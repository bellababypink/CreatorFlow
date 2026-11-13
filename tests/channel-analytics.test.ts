import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnalyticsCsv, prepareImport, parseCsv, ANALYTICS_CSV_TEMPLATE, CSV_COLUMNS } from '../server/channels/imports.js';
import { buildChannelOverview, latestMetrics } from '../server/channels/analytics.js';
import { auditEligibility, buildEvidenceReportMarkdown, generateChannelAudit, renderAuditMarkdown, validateAuditOutput } from '../server/channels/audits.js';
import type { ChannelConnection, ChannelPost, ChannelSnapshot, MetricValue } from '../shared/channels.js';

const csvCell = (value: string) => /[,"\r\n]/.test(value) ? `"${value.replace(/"/g,'""')}"` : value;
const csv = (rows: Record<string,string>[]) => ANALYTICS_CSV_TEMPLATE + rows.map(row=>CSV_COLUMNS.map(column=>csvCell(row[column]||'')).join(',')).join('\n');
const row = (overrides: Record<string,string> = {}) => ({postId:'one',title:'A real supplied title',publishedAt:'2026-10-01',durationSeconds:'30',contentType:'video',pillar:'Education',metricScope:'lifetime',observedAt:'2026-11-01',views:'100',likes:'0',...overrides});
const preview = (rows: Record<string,string>[],overrides:Record<string,string>={}) => parseAnalyticsCsv({csv:csv(rows),platform:'youtube',accountName:'Creator studio',workspaceId:'workspace-a',...overrides} as Parameters<typeof parseAnalyticsCsv>[0]);
const prepared = () => prepareImport(preview([row(),row({postId:'two',title:'A second supplied title',publishedAt:'2026-10-10',durationSeconds:'90',views:'200',likes:''})]),'workspace-a');

test('manual CSV parser handles quoted captions, CRLF, escaped quotes, zero values and missing metrics',()=>{
  const original = '\uFEFFpostId,title,publishedAt,metricScope,observedAt,views,likes,caption\r\none,"A \"\"quoted\"\" title",2026-10-01,lifetime,2026-11-01,0,,"First line\nSecond line"\r\n';
  const parsed = parseAnalyticsCsv({csv:original,platform:'instagram',accountName:'My account',workspaceId:'a'});
  assert.equal(parsed.posts[0].title,'A "quoted" title');
  assert.equal(parsed.posts[0].caption,'First line\nSecond line');
  assert.equal(parsed.posts[0].metrics.length,1);
  assert.equal(parsed.posts[0].metrics[0].value,0);
  assert.equal(parsed.posts[0].metrics[0].source,'manual_import');
  assert.equal(parsed.posts[0].contentType,'unknown');
  assert.match(parsed.warnings.join(' '),/not been independently verified/);
  assert.deepEqual(parseCsv('a,b\n"hello, world",value'),[['a','b'],['hello, world','value']]);
});

test('manual CSV validation rejects ambiguous, malformed and unsafe analytics',()=>{
  const badRows = [
    row({publishedAt:'2026-02-30'}),row({publishedAt:'2026-11-02',observedAt:'2026-11-01'}),row({observedAt:'2026-11-01T12:00:00'}),
    row({views:'-1'}),row({views:'=100+1'}),row({views:'1,000'}),row({views:'1.5'}),row({views:'9007199254740992'}),
    row({metricScope:'daily'}),row({metricScope:'period'}),row({metricScope:'period',periodStart:'2026-11-02',periodEnd:'2026-10-01'}),
    row({periodStart:'2026-10-01'}),row({engagementRatePercent:'101'}),row({contentType:'guessed viral format'}),row({durationSeconds:'0'}),row({url:'javascript:alert(1)'}),row({url:'https://name:secret@example.com/video'}),row({views:'',likes:''}),
  ];
  for (const item of badRows) assert.throws(()=>preview([item]),/Row 2/);
  assert.throws(()=>parseCsv('a,b\n"unclosed,value'),/unclosed/);
  assert.throws(()=>parseCsv('a,b\n"closed"junk,value'),/closing quote/);
  assert.throws(()=>parseCsv('a,b\nhel"lo,value'),/unexpected quote/);
  assert.throws(()=>parseAnalyticsCsv({csv:'postId,title\none,Title',platform:'youtube',accountName:'Studio',workspaceId:'a'}),/missing required column/);
  assert.throws(()=>parseAnalyticsCsv({csv:'postId,postId\none,two',platform:'youtube',accountName:'Studio',workspaceId:'a'}),/duplicate headers/);
  assert.throws(()=>parseAnalyticsCsv({csv:csv([row()]).replace('postId,','mysteryColumn,'),platform:'youtube',accountName:'Studio',workspaceId:'a'}),/Unrecognized/);
  assert.throws(()=>preview([row(),row()]),/duplicate postId/);
  assert.throws(()=>preview(Array.from({length:201},(_,i)=>row({postId:String(i)}))),/200-post/);
  assert.throws(()=>parseCsv('x'.repeat(100001)),/100 KB/);
});

test('import IDs, provenance and immutable observations preserve tenant boundaries and scopes',()=>{
  const a = preview([row({metricScope:'period',periodStart:'2026-10-01',periodEnd:'2026-10-31',viewsDefinition:'Source export counted plays including repeats'})]);
  const b = preview([row({metricScope:'period',periodStart:'2026-10-01',periodEnd:'2026-10-31',viewsDefinition:'Source export counted plays including repeats'})],{workspaceId:'workspace-b'});
  const imported = prepareImport(a,'workspace-a');
  assert.equal(imported.connection.source,'manual_import');
  assert.equal(imported.connection.status,'Unavailable');
  assert.deepEqual(imported.connection.grantedScopes,[]);
  assert.notEqual(a.digest,b.digest);
  assert.notEqual(a.posts[0].connectionId,b.posts[0].connectionId);
  assert.notEqual(a.posts[0].id,b.posts[0].id);
  assert.equal(imported.snapshot.postMetrics[0].metrics[0].scope,'period');
  assert.equal(imported.snapshot.postMetrics[0].metrics[0].periodStart,'2026-10-01');
  assert.equal(imported.snapshot.postMetrics[0].metrics[0].definition,'Source export counted plays including repeats');
  assert.equal(imported.snapshot.accountMetrics.length,0,'Per-post observations must not masquerade as native account totals');
  assert.throws(()=>prepareImport(a,'workspace-b'),/does not belong/);
});

test('analytics keep incompatible definitions, platforms, windows and missing values separate',()=>{
  const one = prepared();
  const two = prepareImport(preview([row({views:'900',viewsDefinition:'Different provider counting rule'})],{platform:'instagram',accountName:'Instagram account'}),'workspace-a');
  const third = preview([row({postId:'three',views:'50',metricScope:'period',periodStart:'2026-10-01',periodEnd:'2026-10-31'})]).posts[0];
  const overview = buildChannelOverview([...one.posts,...two.posts,third],[one.snapshot,two.snapshot],[one.connection,two.connection],{});
  assert.equal(overview.comparisons.length,2);
  const youtube = overview.comparisons.find(series=>series.provider==='youtube')!;
  const instagram = overview.comparisons.find(series=>series.provider==='instagram')!;
  assert.equal(youtube.metrics.filter(metric=>metric.key==='views').length,2,'Lifetime and selected-period totals stay separate');
  assert.equal(youtube.metrics.find(metric=>metric.key==='views'&&metric.scope==='lifetime')!.total,300);
  assert.equal(youtube.metrics.find(metric=>metric.key==='views'&&metric.scope==='period')!.total,50);
  assert.equal(instagram.metrics.find(metric=>metric.key==='views')!.total,900);
  assert.equal(youtube.metrics.find(metric=>metric.key==='likes'&&metric.scope==='lifetime')!.postsWithMetric,1,'Explicit zero is counted while the unavailable second post stays omitted');
  assert.equal(youtube.metrics.find(metric=>metric.key==='likes'&&metric.scope==='period')!.postsWithMetric,1,'A period zero remains in its own reporting cohort');
  assert.equal('totalViews' in overview,false);
  assert.match(overview.coverage.limitations.join(' '),/no combined cross-platform/);
  assert.ok(overview.groups.lengths.every(group=>group.label.includes('youtube')||group.label.includes('instagram')));
});

test('latest metric observations replace repeated values without double counting',()=>{
  const one=prepared();
  const original=one.posts[0].metrics[0];
  const latest={...original,value:150,observedAt:'2026-11-02T00:00:00.000Z'};
  assert.equal(latestMetrics([original,latest],one.posts[0].provider).length,1);
  assert.equal(latestMetrics([original,latest],one.posts[0].provider)[0].value,150);
  const posts=[{...one.posts[0],metrics:[original,latest]},one.posts[1]];
  const overview=buildChannelOverview(posts,[],[one.connection],{});
  assert.equal(overview.comparisons[0].metrics.filter(metric=>metric.key==='views').reduce((sum,metric)=>sum+metric.postsWithMetric,0),2);
  assert.deepEqual(overview.comparisons[0].metrics.filter(metric=>metric.key==='views').map(metric=>metric.total).sort((a,b)=>a-b),[150,200],'Different lifetime as-of dates remain separate rather than a misleading combined350');
});

test('publication filters retain real reporting periods and hide incompatible account history',()=>{
  const one=prepared();
  const overview=buildChannelOverview(one.posts,[one.snapshot],[one.connection],{startDate:'2026-10-05',endDate:'2026-10-31',platform:'youtube'});
  assert.equal(overview.posts.length,1);
  assert.equal(overview.posts[0].metrics[0].scope,'lifetime');
  assert.equal(overview.posts[0].metrics[0].periodStart,null);
  assert.equal(buildChannelOverview(one.posts,[one.snapshot],[one.connection],{pillar:'Education'}).snapshots.length,0);
  assert.equal(buildChannelOverview(one.posts,[one.snapshot],[one.connection],{contentType:'reel'}).posts.length,0);
  assert.throws(()=>buildChannelOverview(one.posts,[],[one.connection],{startDate:'2026-02-30'}),/valid YYYY/);
  assert.throws(()=>buildChannelOverview(one.posts,[],[one.connection],{startDate:'2026-11-01',endDate:'2026-10-01'}),/must not follow/);
});

test('account comparisons do not sum per-post averages or engagement percentages',()=>{
  const imported=prepareImport(preview([row({averageViewDurationSeconds:'20',engagementRatePercent:'7.5'}),row({postId:'two',averageViewDurationSeconds:'30',engagementRatePercent:'12'})]),'workspace-a');
  const overview=buildChannelOverview(imported.posts,[],[imported.connection],{});
  assert.equal(overview.comparisons[0].metrics.some(metric=>metric.key==='average_view_duration'||metric.key==='engagement_rate'),false);
  assert.ok(overview.posts[0].metrics.some(metric=>metric.key==='engagement_rate'),'Individual reported percentages remain available unchanged');
});

function nativeFixture() {
  const imported=prepared();
  const connection:ChannelConnection={...imported.connection,id:'oauth-connection',source:'oauth',status:'Connected'};
  const nativeMetric:MetricValue={...imported.posts[0].metrics[0],source:'youtube_data_api',comparisonKey:'youtube:data:viewCount:lifetime',providerMetric:'viewCount',definition:'Native provider viewCount',value:999};
  const posts:ChannelPost[]=imported.posts.map(post=>({...post,connectionId:connection.id,source:'youtube_data_api',metrics:[{...nativeMetric,value:100}]}));
  const snapshot:ChannelSnapshot={...imported.snapshot,id:'native-snapshot',connectionId:connection.id,accountMetrics:[nativeMetric],coverage:{postsFetched:2,hasMore:false,limitations:[]}};
  return {connection,posts,snapshot};
}

test('native YouTube defaults preserve returned account values without novel scores or API inference',()=>{
  const before=process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED;
  delete process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED;
  try {
    const fixture=nativeFixture();
    const overview=buildChannelOverview(fixture.posts,[fixture.snapshot],[fixture.connection],{});
    assert.equal(overview.comparisons[0].metrics[0].total,999,'Native account value must not become the sum of selected posts');
    assert.equal(overview.comparisons[0].postsPerWeek,null);
    assert.ok(overview.groups.lengths.every(group=>group.median===null));
    assert.equal(auditEligibility(overview).eligible,false);
  } finally { if(before===undefined)delete process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED;else process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED=before; }
});

test('audit validates evidence references and rejects unsupported audience or uncited assertions',()=>{
  const one=prepared();
  const finding={category:'strength',title:'Observed result',detail:'The cited post has a supplied view count.',evidencePostIds:[one.posts[0].id],evidenceSnapshotIds:[],confidence:'low'};
  const output={summary:'A source-backed summary.',findings:[finding],limitations:['Only two imported posts are available.']};
  assert.equal(validateAuditOutput(output,one.posts,[one.snapshot]).findings.length,1);
  assert.throws(()=>validateAuditOutput({...output,findings:[{...finding,evidencePostIds:['another-workspace-post']}]},one.posts,[one.snapshot]),/outside/);
  assert.throws(()=>validateAuditOutput({...output,findings:[{...finding,evidencePostIds:[]}]},one.posts,[one.snapshot]),/without source evidence/);
  assert.throws(()=>validateAuditOutput({...output,findings:[{...finding,category:'audience',evidenceSnapshotIds:[one.snapshot.id]}]},one.posts,[one.snapshot]),/inferred an audience/);
  assert.throws(()=>validateAuditOutput({...output,findings:[{...finding,confidence:'certain'}]},one.posts,[one.snapshot]),/invalid audit structure/);
  assert.throws(()=>validateAuditOutput({...output,summary:'These posts received 9,000 views.'},one.posts,[one.snapshot]),/numeric observation absent/);
  assert.throws(()=>validateAuditOutput({...output,findings:[{...finding,detail:'The cited post received 200 views.'}]},one.posts,[one.snapshot]),/numeric observation absent/,'A value belonging to another post cannot support the cited post');
  assert.throws(()=>validateAuditOutput({...output,findings:[{...finding,detail:'The cited post received 9k views.'}]},one.posts,[one.snapshot]),/numeric observation absent/);
  assert.equal(validateAuditOutput({...output,findings:[{...finding,detail:'The cited post received 100 supplied views.'}]},one.posts,[one.snapshot]).findings.length,1);
  assert.equal(validateAuditOutput({...output,findings:[{...finding,category:'experiment',detail:'Test a new 45-second cut next week; this is a prospective filming parameter.'}]},one.posts,[one.snapshot]).findings.length,1);
});

test('empty evidence, missing Gemini configuration and mixed native YouTube inputs never fabricate audits',async()=>{
  const one=prepared();
  const empty=buildChannelOverview([],[],[],{});
  assert.equal(auditEligibility(empty).eligible,false);
  const overview=buildChannelOverview(one.posts,[one.snapshot],[one.connection],{});
  const previousKey=process.env.GEMINI_API_KEY, previousApproval=process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(generateChannelAudit({workspaceId:'workspace-a',overview}),/Configure GEMINI_API_KEY/);
    process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED='true';
    const native=nativeFixture();
    const mixed=buildChannelOverview([...one.posts,...native.posts],[one.snapshot,native.snapshot],[one.connection,native.connection],{});
    assert.equal(auditEligibility(mixed).eligible,false,'An approval flag does not merge YouTube API data with external sources');
  } finally {
    if(previousKey===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previousKey;
    if(previousApproval===undefined)delete process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED;else process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED=previousApproval;
  }
});

test('download reports expose actual provenance and frozen evidence without pretending descriptive output is AI',()=>{
  const one=prepared(), overview=buildChannelOverview(one.posts,[one.snapshot],[one.connection],{});
  const report=buildEvidenceReportMarkdown(overview,[one.connection]);
  assert.match(report,/Descriptive source data only/);
  assert.match(report,/No Gemini audit has been generated/);
  assert.match(report,/manual_import/);
  assert.match(report,/100 count/);
  const now='2026-11-01T00:00:00.000Z';
  const aiReport=renderAuditMarkdown({id:'audit',workspaceId:'workspace-a',filters:{},summary:'Observed supplied records.',findings:[],limitations:['Small sample.'],model:'test-model-validation-only',generatedAt:now,sourcePostIds:[one.posts[0].id],sourceSnapshotIds:[one.snapshot.id],createdAt:now,version:1},overview);
  assert.match(aiReport,/AI-generated interpretation/);
  assert.match(aiReport,/A real supplied title/);
  assert.equal(aiReport.includes('A second supplied title'),false,'Only the evidence actually submitted to the audit is included');
});
