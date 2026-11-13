import { createHash } from 'node:crypto';
import type { ChannelConnection, ChannelPost, ChannelSnapshot, ImportPreview, MetricValue, PostContentType } from '../../shared/channels.js';
import type { Platform } from '../../shared/types.js';
import { HttpError } from '../errors.js';

export const CSV_COLUMNS = ['postId','title','publishedAt','durationSeconds','contentType','pillar','caption','tags','url','metricScope','periodStart','periodEnd','observedAt','views','likes','comments','shares','reach','impressions','watchTimeSeconds','averageViewDurationSeconds','engagementRatePercent','viewsDefinition'] as const;
export const ANALYTICS_CSV_TEMPLATE = CSV_COLUMNS.join(',') + '\n';
export const CSV_IMPORT_HELP = 'Required: postId, publishedAt, metricScope (lifetime or period), observedAt. Period metrics also require periodStart and periodEnd as YYYY-MM-DD. Leave unavailable metrics blank; zero is a real value. Tags use | separators. Use the template headers exactly. Maximum 100 KB and 200 posts. Imported figures are user-supplied and are not verified API analytics.';
export const IMPORT_LIMITS = { bytes: 100_000, rows: 200 } as const;
const requiredColumns = ['postId','publishedAt','metricScope','observedAt'];
const contentTypes: PostContentType[] = ['video','short','reel','tiktok','image','carousel','unknown'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const importConnectionId = (workspaceId: string, platform: Platform, accountName: string) => `import_${hash(JSON.stringify([workspaceId, platform, accountName.trim().toLocaleLowerCase('en-US')])).slice(0,40)}`;

function invalid(message: string): never { throw new HttpError(400, message, 'INVALID_ANALYTICS_IMPORT'); }

/** Small bounded RFC 4180 parser. Newlines and escaped quotes inside quoted fields are preserved. */
export function parseCsv(csv: string): string[][] {
  if (Buffer.byteLength(csv, 'utf8') > IMPORT_LIMITS.bytes) invalid('CSV exceeds the 100 KB import limit.');
  if (csv.includes('\0')) invalid('CSV contains an invalid null character.');
  const input = csv.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, afterQuote = false;
  const pushCell = () => { row.push(cell); cell = ''; afterQuote = false; };
  const pushRow = () => {
    pushCell();
    if (row.some(value => value.trim() !== '')) rows.push(row);
    row = [];
    if (rows.length > IMPORT_LIMITS.rows + 1) invalid('CSV exceeds the 200-post import limit.');
  };
  for (let i=0;i<input.length;i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i+1] === '"') { cell += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else cell += char;
      continue;
    }
    if (char === ',') { pushCell(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i+1] === '\n') i++;
      pushRow(); continue;
    }
    if (afterQuote) { if (char === ' ' || char === '\t') continue; invalid('CSV has text after a closing quote.'); }
    if (char === '"') { if (cell.length) invalid('CSV contains an unexpected quote. Quote the whole field.'); quoted = true; }
    else cell += char;
  }
  if (quoted) invalid('CSV has an unclosed quoted field.');
  if (cell.length || row.length || afterQuote) pushRow();
  return rows;
}

function dateOnly(value: string, field: string, row: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(`Row ${row}: ${field} must use YYYY-MM-DD.`);
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value) invalid(`Row ${row}: ${field} is not a valid calendar date.`);
  return value;
}
function timestamp(value: string, field: string, row: number): string {
  dateOnly(value.slice(0,10), field, row);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) invalid(`Row ${row}: ${field} must be an ISO date or timestamp with a timezone.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid(`Row ${row}: ${field} is invalid.`);
  return new Date(milliseconds).toISOString();
}
function numberValue(value: string, field: string, row: number, count = false): number | null {
  if (!value) return null;
  if (!/^\d+(?:\.\d+)?$/.test(value)) invalid(`Row ${row}: ${field} must be a nonnegative number without separators.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number > Number.MAX_SAFE_INTEGER || (count && !Number.isSafeInteger(number))) invalid(`Row ${row}: ${field} is outside the supported numeric range.`);
  return number;
}
const metricDefinitions: { column: string; key: string; label: string; unit: MetricValue['unit']; count?: boolean }[] = [
  { column:'views',key:'views',label:'Imported views',unit:'count',count:true },
  { column:'likes',key:'likes',label:'Imported likes',unit:'count',count:true },
  { column:'comments',key:'comments',label:'Imported comments',unit:'count',count:true },
  { column:'shares',key:'shares',label:'Imported shares',unit:'count',count:true },
  { column:'reach',key:'reach',label:'Imported reach',unit:'count',count:true },
  { column:'impressions',key:'impressions',label:'Imported impressions',unit:'count',count:true },
  { column:'watchTimeSeconds',key:'watch_time',label:'Imported watch time',unit:'seconds' },
  { column:'averageViewDurationSeconds',key:'average_view_duration',label:'Imported average view duration',unit:'seconds' },
  { column:'engagementRatePercent',key:'engagement_rate',label:'Imported engagement rate',unit:'percent' },
];

export function parseAnalyticsCsv(input: { csv: string; platform: Platform; accountName: string; workspaceId: string }): ImportPreview {
  if (!['youtube','instagram','tiktok'].includes(input.platform)) invalid('Choose YouTube, Instagram, or TikTok.');
  const accountName = input.accountName.trim();
  if (!accountName || accountName.length > 100) invalid('Account name must contain 1–100 characters.');
  const rows = parseCsv(input.csv);
  if (rows.length < 2) invalid('CSV must contain a header and at least one post.');
  const header = rows[0].map(value => value.trim());
  if (new Set(header).size !== header.length) invalid('CSV contains duplicate headers.');
  const unknown = header.filter(value => !(CSV_COLUMNS as readonly string[]).includes(value));
  if (unknown.length) invalid(`Unrecognized CSV columns: ${unknown.join(', ')}. Map your export to the provided template.`);
  for (const field of requiredColumns) if (!header.includes(field)) invalid(`CSV is missing required column: ${field}.`);
  const connectionId = importConnectionId(input.workspaceId, input.platform, accountName);
  const seen = new Set<string>();
  const now = new Date().toISOString();
  const warnings = ['User-supplied analytics import: account ownership, figures, and counting definitions have not been independently verified.', 'Unavailable fields are omitted. Imported figures are compared only within the same provider, source, content type, metric definition, scope, and reporting window.'];
  const posts = rows.slice(1).map((cells,index): ChannelPost => {
    const rowNumber = index+2;
    if (cells.length !== header.length) invalid(`Row ${rowNumber}: expected ${header.length} columns; found ${cells.length}.`);
    const values = Object.fromEntries(header.map((field,i) => [field, cells[i].trim()]));
    for (const field of requiredColumns) if (!values[field]) invalid(`Row ${rowNumber}: ${field} is required.`);
    const providerPostId = values.postId;
    if (providerPostId.length > 200 || /[\x00-\x1f]/.test(providerPostId)) invalid(`Row ${rowNumber}: postId is invalid.`);
    if (seen.has(providerPostId)) invalid(`Row ${rowNumber}: duplicate postId. Import each post once per file.`);
    seen.add(providerPostId);
    const publishedAt = timestamp(values.publishedAt,'publishedAt',rowNumber);
    const observedAt = timestamp(values.observedAt,'observedAt',rowNumber);
    if (Date.parse(publishedAt) > Date.parse(observedAt)) invalid(`Row ${rowNumber}: publishedAt cannot follow observedAt.`);
    if (Date.parse(observedAt) > Date.now()+86_400_000) invalid(`Row ${rowNumber}: observedAt cannot be in the future.`);
    const scope = values.metricScope;
    if (scope !== 'lifetime' && scope !== 'period') invalid(`Row ${rowNumber}: metricScope must be lifetime or period.`);
    let periodStart: string | null = null, periodEnd: string | null = null;
    if (scope === 'period') {
      periodStart = dateOnly(values.periodStart || '', 'periodStart', rowNumber);
      periodEnd = dateOnly(values.periodEnd || '', 'periodEnd', rowNumber);
      if (periodStart > periodEnd || periodEnd > observedAt.slice(0,10)) invalid(`Row ${rowNumber}: reporting dates must be ordered and cannot follow observedAt.`);
    } else if (values.periodStart || values.periodEnd) invalid(`Row ${rowNumber}: lifetime metrics must leave periodStart and periodEnd blank.`);
    const contentType = (values.contentType || 'unknown') as PostContentType;
    if (!contentTypes.includes(contentType)) invalid(`Row ${rowNumber}: unsupported contentType.`);
    const durationSeconds = numberValue(values.durationSeconds || '', 'durationSeconds', rowNumber);
    if (durationSeconds !== null && durationSeconds <= 0) invalid(`Row ${rowNumber}: durationSeconds must be positive when supplied.`);
    for (const [field,max] of [['title',300],['caption',5000],['pillar',100],['viewsDefinition',600]] as const) if ((values[field] || '').length > max) invalid(`Row ${rowNumber}: ${field} exceeds ${max} characters.`);
    let url: string | null = null;
    if (values.url) {
      try { const parsed = new URL(values.url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(); url = parsed.href; }
      catch { invalid(`Row ${rowNumber}: url must be a valid HTTPS URL without credentials.`); }
    }
    const tags = (values.tags || '').split('|').map(tag=>tag.trim()).filter(Boolean);
    if (tags.length > 30 || tags.some(tag=>tag.length>100)) invalid(`Row ${rowNumber}: tags allow up to 30 entries of 100 characters.`);
    const metrics: MetricValue[] = metricDefinitions.flatMap(def => {
      const value = numberValue(values[def.column] || '', def.column, rowNumber, def.count);
      if (value === null) return [];
      if (def.unit === 'percent' && value > 100) invalid(`Row ${rowNumber}: engagementRatePercent must be between 0 and 100.`);
      const definition = def.column === 'views' && values.viewsDefinition
        ? values.viewsDefinition
        : `${input.platform} export column ${def.column}, supplied by the user; provider counting methodology is not independently verified.`;
      return [{ key:def.key, providerMetric:def.column, label:def.label, definition, unit:def.unit, value, scope, periodStart, periodEnd, observedAt, source:'manual_import' as const,
        comparisonKey: ['manual',input.platform,contentType,def.column,hash(definition).slice(0,12),scope,periodStart||'',periodEnd||''].join(':') }];
    });
    if (!metrics.length) invalid(`Row ${rowNumber}: supply at least one metric. Leave other metrics blank.`);
    return { id:`post_${hash(JSON.stringify([connectionId,providerPostId])).slice(0,40)}`, workspaceId:input.workspaceId, connectionId, provider:input.platform, providerPostId,
      title:values.title || providerPostId, caption:values.caption || '', publishedAt, url, thumbnailUrl:null, durationSeconds, contentType,
      pillar:values.pillar || null, pillarSource:values.pillar ? 'imported' : null, mediaAssetId:null, tags, metrics, source:'manual_import', createdAt:now, updatedAt:now, version:1 };
  });
  if (posts.some(post=>post.contentType === 'unknown')) warnings.push('Some formats are unknown because no contentType was supplied. No format was inferred from duration.');
  return { platform:input.platform,accountName,rows:posts.length,posts,warnings,digest:hash(JSON.stringify([input.workspaceId,input.platform,accountName.toLocaleLowerCase('en-US'),input.csv.replace(/\r\n/g,'\n')])) };
}

export function prepareImport(preview: ImportPreview, workspaceId: string): { connection: ChannelConnection; posts: ChannelPost[]; snapshot: ChannelSnapshot & { postMetrics: { postId: string; metrics: MetricValue[] }[] }; importRecord: {id:string;workspaceId:string;connectionId:string;digest:string;rows:number;source:string;createdAt:string;version:number} } {
  // The API must reparse the original CSV before calling this helper, rather than trusting a browser-supplied preview.
  if (!preview.posts.length || preview.posts.some(post=>post.workspaceId !== workspaceId || post.source !== 'manual_import')) invalid('Import preview does not belong to this workspace.');
  const now = new Date().toISOString();
  const id = importConnectionId(workspaceId,preview.platform,preview.accountName);
  if (preview.posts.some(post=>post.connectionId !== id)) invalid('Import account reference is invalid.');
  const dates = preview.posts.flatMap(post=>post.metrics.map(metric=>metric.observedAt)).sort();
  const periodStarts = preview.posts.flatMap(post=>post.metrics.map(metric=>metric.periodStart || metric.observedAt.slice(0,10))).sort();
  const periodEnds = preview.posts.flatMap(post=>post.metrics.map(metric=>metric.periodEnd || metric.observedAt.slice(0,10))).sort();
  return {
    connection: { id,workspaceId,provider:preview.platform,source:'manual_import',providerAccountId:`import:${preview.accountName}`,accountName:preview.accountName,status:'Unavailable',grantedScopes:[],missingScopes:[],lastSyncedAt:now,lastError:null,availableMetrics:[...new Set(preview.posts.flatMap(post=>post.metrics.map(metric=>metric.key)))],generation:1,createdAt:now,updatedAt:now,version:1 },
    posts:preview.posts,
    snapshot: { id:`snapshot_import_${preview.digest}`,workspaceId,connectionId:id,provider:preview.platform,observedAt:dates.at(-1)!,periodStart:periodStarts[0],periodEnd:periodEnds.at(-1)!,accountMetrics:[],daily:[],audience:[],postMetrics:preview.posts.map(post=>({postId:post.id,metrics:post.metrics})),coverage:{postsFetched:preview.posts.length,hasMore:false,limitations:[...preview.warnings,'This import contains per-post observations only. It does not provide account-level history or audience demographics.']},createdAt:now,version:1 },
    importRecord:{id:`import_${preview.digest}`,workspaceId,connectionId:id,digest:preview.digest,rows:preview.rows,source:'manual_import',createdAt:now,version:1},
  };
}
