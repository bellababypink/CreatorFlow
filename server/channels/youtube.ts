import { createHash, randomUUID } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import type { Credentials } from 'google-auth-library';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import type { ChannelConnection, ChannelIntegration, ChannelPost, ChannelSnapshot, MetricValue } from '../../shared/channels.js';
import { tokenVaultConfigured } from './token-vault.js';
import { store } from '../store.js';

export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'];
const DATA = 'https://www.googleapis.com/youtube/v3/';
const REPORTS = 'https://youtubeanalytics.googleapis.com/v2/reports';
export interface YouTubeOAuthConfig { clientId: string; clientSecret: string; redirectUri: string }
export interface VerifiedTokenInfo { scopes: string[]; audience: string; expiresAt: number }
export interface YouTubeTransport {
  request: typeof fetch;
  exchange: (code: string, verifier: string) => Promise<Credentials>;
  refresh: (refreshToken: string) => Promise<Credentials>;
  inspect: (accessToken: string) => Promise<VerifiedTokenInfo>;
  revoke: (token: string) => Promise<void>;
}

export function youtubeOAuthConfig(): YouTubeOAuthConfig {
  const clientId = process.env.YOUTUBE_CLIENT_ID || '';
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || '';
  const expected = new URL('/api/channels/oauth/youtube/callback', config.origin).toString();
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || '';
  if (!clientId || !clientSecret || !redirectUri || !tokenVaultConfigured()) throw new HttpError(503, 'Configure the YouTube OAuth web client, exact callback URI, and channel token encryption key before connecting.', 'CONFIGURATION_REQUIRED');
  let parsed: URL;
  try { parsed = new URL(redirectUri); } catch { throw new HttpError(503, 'The YouTube callback URI is invalid.', 'CONFIGURATION_REQUIRED'); }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (redirectUri !== expected || parsed.username || parsed.password || parsed.hash || parsed.search || parsed.protocol !== 'https:' && !(local && config.mode === 'local' && parsed.protocol === 'http:')) {
    throw new HttpError(503, 'YOUTUBE_REDIRECT_URI must exactly match APP_ORIGIN/api/channels/oauth/youtube/callback, using HTTPS outside local development.', 'CONFIGURATION_REQUIRED');
  }
  return { clientId, clientSecret, redirectUri };
}

export function googleOAuthClient(): OAuth2Client {
  const value = youtubeOAuthConfig();
  return new OAuth2Client({ clientId: value.clientId, clientSecret: value.clientSecret, redirectUri: value.redirectUri, transporterOptions: { timeout: 20_000, retry: false } });
}

export const googleYouTubeTransport: YouTubeTransport = {
  request: (...args) => fetch(...args),
  exchange: async (code, verifier) => (await googleOAuthClient().getToken({ code, codeVerifier: verifier })).tokens,
  refresh: async refreshToken => { const client = googleOAuthClient(); client.setCredentials({ refresh_token: refreshToken }); return (await client.refreshAccessToken()).credentials; },
  inspect: async accessToken => { const value = await googleOAuthClient().getTokenInfo(accessToken); return { scopes: value.scopes, audience: value.aud, expiresAt: value.expiry_date }; },
  revoke: async token => { await googleOAuthClient().revokeToken(token); },
};

export function getYouTubeIntegration(): ChannelIntegration {
  const setupSteps = ['Enable YouTube Data API v3 and YouTube Analytics API in your Google Cloud project.', 'Create an OAuth Web application and configure its consent screen and allowed test users or verified audience.', 'Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and the exact YOUTUBE_REDIRECT_URI on the API and worker.', 'Set the same CHANNEL_TOKEN_KEY on all production instances. Local development creates a private local key file.', 'Register APP_ORIGIN/api/channels/oauth/youtube/callback as an authorized redirect URI.'];
  try {
    youtubeOAuthConfig();
    if (process.env.YOUTUBE_APP_REVIEW_STATUS === 'required') return { provider: 'youtube', name: 'YouTube', status: 'Requires Developer Approval', message: 'This installation is marked as requiring Google app verification or developer approval. Complete that review before enabling connections.', configured: true, canConnect: false, requiredScopes: YOUTUBE_SCOPES, setupSteps };
    return { provider: 'youtube', name: 'YouTube', status: 'Needs Permission', message: 'OAuth is configured. Connect your own channel through Google consent to verify access; no channel data has been accessed yet.', configured: true, canConnect: true, requiredScopes: YOUTUBE_SCOPES, setupSteps };
  } catch (error) {
    return { provider: 'youtube', name: 'YouTube', status: 'Not Configured', message: error instanceof HttpError ? error.message : 'YouTube configuration is unavailable.', configured: false, canConnect: false, requiredScopes: YOUTUBE_SCOPES, setupSteps };
  }
}

export class YouTubeProviderError extends HttpError {
  constructor(public providerStatus: number, public reason: string, message: string, code: string) { super(providerStatus === 429 ? 429 : providerStatus >= 500 ? 503 : providerStatus === 401 ? 401 : 403, message, code); }
}

export function providerFailure(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const e = error as { response?: { status?: number; data?: { error?: string | { status?: string } } }; status?: number; code?: string; name?: string };
  const status = e.response?.status || e.status || 0;
  const reason = typeof e.response?.data?.error === 'string' ? e.response.data.error : e.code;
  if (reason === 'invalid_grant' || reason === 'invalid_token' || status === 401) return new YouTubeProviderError(401, 'invalid_grant', 'YouTube authorization expired or was revoked. Reconnect the channel to continue.', 'AUTHORIZATION_REVOKED');
  if (status === 429) return new YouTubeProviderError(429, 'quota', 'YouTube rate or quota limit reached. Try synchronization later.', 'PROVIDER_QUOTA');
  if (status >= 500 || status === 0) return new YouTubeProviderError(503, 'unavailable', 'YouTube could not complete this request. The worker can retry within its retry limit.', 'PROVIDER_UNAVAILABLE');
  return new YouTubeProviderError(status, 'authorization', 'Google rejected the authorization request. Check the OAuth application and granted permissions.', 'PROVIDER_AUTHORIZATION_FAILED');
}

export async function youtubeJson<T>(url: URL | string, accessToken: string, transport = googleYouTubeTransport): Promise<T> {
  let response: Response;
  try { response = await transport.request(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(25_000) }); }
  catch (error) { throw providerFailure(error); }
  const body: any = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || 'unknown';
    if (response.status === 401) throw new YouTubeProviderError(401, reason, 'YouTube authorization must be refreshed or renewed.', 'AUTHORIZATION_REVOKED');
    if (response.status === 429 || /quota|rateLimit|RESOURCE_EXHAUSTED/i.test(reason)) throw new YouTubeProviderError(429, reason, 'YouTube rate or quota limit reached. No missing metrics were replaced with zero.', 'PROVIDER_QUOTA');
    if (/accessNotConfigured|SERVICE_DISABLED|API_KEY_SERVICE_BLOCKED/i.test(reason)) throw new YouTubeProviderError(403, reason, 'Enable the required YouTube API in the configured Google project before synchronizing.', 'DEVELOPER_APPROVAL_REQUIRED');
    if (response.status === 403) throw new YouTubeProviderError(403, reason, 'YouTube did not grant access to this report. Check account eligibility and permissions.', 'PERMISSION_REQUIRED');
    throw new YouTubeProviderError(response.status, reason, 'YouTube could not return the requested authorized data.', response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REQUEST_FAILED');
  }
  if (!body || typeof body !== 'object') throw new HttpError(502, 'YouTube returned an unreadable response.', 'INVALID_PROVIDER_RESPONSE');
  return body as T;
}

export function youtubeDataUrl(resource: string, parameters: Record<string, string>): URL {
  const url = new URL(resource, DATA); for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value); return url;
}

export interface YouTubeChannelResource {
  id: string; snippet?: { title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } };
  statistics?: { viewCount?: string; subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string };
}

export async function authorizedYouTubeProfile(accessToken: string, transport = googleYouTubeTransport): Promise<YouTubeChannelResource> {
  const body = await youtubeJson<{ items?: YouTubeChannelResource[] }>(youtubeDataUrl('channels', { part: 'snippet,contentDetails,statistics', mine: 'true', maxResults: '50' }), accessToken, transport);
  if (!body.items?.length) throw new HttpError(400, 'The authorized Google identity has no accessible YouTube channel. Choose the intended channel or Brand Account during consent.', 'CHANNEL_NOT_FOUND');
  if (body.items.length !== 1) throw new HttpError(409, 'More than one channel was returned. Reconnect and select the intended YouTube channel in Google consent.', 'CHANNEL_SELECTION_REQUIRED');
  const channel = body.items[0];
  if (!channel.id || !channel.snippet?.title) throw new HttpError(502, 'YouTube did not return a valid channel identity.', 'INVALID_PROVIDER_RESPONSE');
  return channel;
}

export function stableYouTubeId(workspaceId: string, providerId: string, kind: 'connection' | 'post'): string {
  return `yt_${kind}_${createHash('sha256').update(`${workspaceId}:${providerId}`).digest('hex')}`;
}

export function isoDurationSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(part => part !== undefined)) return null;
  const total = Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

type MetricSpec = { key: string; label: string; definition: string; unit: MetricValue['unit'] };
const SPECS: Record<string, MetricSpec> = {
  viewCount: { key: 'views', label: 'Lifetime video views', unit: 'count', definition: 'YouTube Data API reported lifetime viewCount. Shorts and long-form view counting differ; this adapter does not infer Shorts classification.' },
  likeCount: { key: 'likes', label: 'Lifetime likes', unit: 'count', definition: 'YouTube Data API reported lifetime likes. Unavailable or hidden counts are omitted.' },
  commentCount: { key: 'comments', label: 'Lifetime comments', unit: 'count', definition: 'YouTube Data API reported lifetime comment count. Unavailable counts are omitted.' },
  subscriberCount: { key: 'subscribers', label: 'Reported subscribers', unit: 'count', definition: 'YouTube channel subscriberCount as returned by the Data API, rounded according to provider policy. Hidden counts are omitted.' },
  videoCount: { key: 'published_videos', label: 'Reported public videos', unit: 'count', definition: 'YouTube Data API channel videoCount, representing public videos according to the provider definition.' },
  views: { key: 'views', label: 'Period views', unit: 'count', definition: 'YouTube Analytics views for this report window. It is distinct from lifetime Data API viewCount and from other platforms’ views.' },
  estimatedMinutesWatched: { key: 'watch_time_minutes', label: 'Watch time', unit: 'minutes', definition: 'YouTube Analytics estimated total minutes watched during the report window.' },
  averageViewDuration: { key: 'average_view_duration_seconds', label: 'Average view duration', unit: 'seconds', definition: 'YouTube Analytics average playback duration in seconds for the report window. Averages must not be summed across posts or days.' },
  likes: { key: 'likes', label: 'Period likes', unit: 'count', definition: 'YouTube Analytics likes attributed to this report window, distinct from lifetime Data API likes.' },
  comments: { key: 'comments', label: 'Period comments', unit: 'count', definition: 'YouTube Analytics comments attributed to this report window.' },
  shares: { key: 'shares', label: 'Period shares', unit: 'count', definition: 'YouTube Analytics shares attributed to this report window through the provider’s sharing measurement.' },
  subscribersGained: { key: 'subscribers_gained', label: 'Subscribers gained', unit: 'count', definition: 'YouTube Analytics subscribers gained during this report window; video reports count only eligible video-attributed subscriptions.' },
  subscribersLost: { key: 'subscribers_lost', label: 'Subscribers lost', unit: 'count', definition: 'YouTube Analytics subscribers lost during this report window.' },
  viewerPercentage: { key: 'viewer_percentage', label: 'Viewer percentage', unit: 'percent', definition: 'Percentage of logged-in viewers in the returned YouTube Analytics demographic group. Privacy thresholds and eligibility limit coverage.' },
};

export function youtubeMetric(providerMetric: string, value: unknown, source: MetricValue['source'], scope: MetricValue['scope'], observedAt: string, periodStart: string | null, periodEnd: string | null, entity: 'video' | 'channel' = 'video'): MetricValue | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  const spec = SPECS[providerMetric];
  if (!spec || !Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER || spec.unit === 'count' && !Number.isSafeInteger(number) || spec.unit === 'percent' && number > 100) return null;
  const contextual = entity === 'channel' && providerMetric === 'viewCount' ? { label: 'Lifetime channel views', definition: 'YouTube Data API channel statistics.viewCount as reported by the provider. It includes channel-wide views and is distinct from video-level lifetime counts and period Analytics views.' } : {};
  return { ...spec, ...contextual, providerMetric, value: number, source, scope, observedAt, periodStart, periodEnd, comparisonKey: `youtube:${source}:${entity}:${providerMetric}:${scope}:${periodStart || 'all'}:${periodEnd || 'all'}` };
}

interface Report { columnHeaders?: { name: string }[]; rows?: unknown[][] }
const REPORT_METRICS = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'];
function reportRecords(report: Report): Record<string, unknown>[] {
  if (!Array.isArray(report.columnHeaders) || report.columnHeaders.some(c => typeof c.name !== 'string') || report.rows !== undefined && (!Array.isArray(report.rows) || report.rows.some(row => !Array.isArray(row) || row.length !== report.columnHeaders!.length))) throw new HttpError(502, 'YouTube Analytics returned invalid report column definitions or rows.', 'INVALID_PROVIDER_RESPONSE');
  return (report.rows || []).map(row => Object.fromEntries(report.columnHeaders!.map((column, i) => [column.name, row[i]])));
}
function reportMetrics(row: Record<string, unknown>, scope: 'daily' | 'period', observed: string, start: string, end: string, entity: 'video' | 'channel'): MetricValue[] {
  return REPORT_METRICS.map(key => youtubeMetric(key, row[key], 'youtube_analytics_api', scope, observed, start, end, entity)).filter((value): value is MetricValue => value !== null);
}

/** Returns actual authorized data, never writes a partially synchronized dataset. */
export async function syncYouTube(connection: ChannelConnection, onProgress?: (progress: number, stage: string) => Promise<void> | void, transport = googleYouTubeTransport): Promise<{ connection: ChannelConnection; posts: ChannelPost[]; snapshot: ChannelSnapshot }> {
  const { withYouTubeAccess } = await import('./oauth.js');
  return withYouTubeAccess(connection, async accessToken => {
    const current = await store.get<ChannelConnection>('socialConnections', connection.id);
    if (!current || current.workspaceId !== connection.workspaceId || current.generation !== connection.generation || current.disconnectedAt) throw new HttpError(409, 'The channel authorization changed before synchronization.', 'AUTHORIZATION_CHANGED');
    connection = current;
    await onProgress?.(10, 'Reading authorized YouTube channel');
    const channel = await authorizedYouTubeProfile(accessToken, transport);
    if (channel.id !== connection.providerAccountId) throw new HttpError(409, 'The authorization no longer matches this channel. Reconnect the intended account.', 'CHANNEL_IDENTITY_MISMATCH');
    const now = new Date().toISOString();
    const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const start = new Date(Date.parse(end) - 89 * 86400000).toISOString().slice(0, 10);
    const limitations = ['Up to 200 recent upload entries are inspected; results are not a census of the full channel.', 'Published public videos are included. Private, unlisted, deleted, or inaccessible uploads are excluded.', 'Lifetime Data API counts and period Analytics values are separate observations, not interchangeable totals.', 'YouTube Analytics reporting dates use Pacific time. Requested windows may be truncated by the provider to its latest fully processed day; absent dates are not zero.', 'YouTube Analytics day boundaries follow the provider reporting timezone; they are not converted to the workspace timezone.', 'YouTube metadata does not reliably identify Shorts here. Video type is not inferred from duration.', 'The APIs used here do not provide audiovisual source files, spoken hooks, transcripts, or visual editing patterns. Link an authorized uploaded video for those analyses.'];
    const ids: string[] = []; let page: string | undefined; let hasMore = false;
    if (channel.contentDetails?.relatedPlaylists?.uploads) {
      for (let i = 0; i < 4; i++) {
        await onProgress?.(12 + i * 2, 'Reading the authorized uploads inventory');
        const body = await youtubeJson<{ items?: { contentDetails?: { videoId?: string } }[]; nextPageToken?: string }>(youtubeDataUrl('playlistItems', { part: 'contentDetails', playlistId: channel.contentDetails.relatedPlaylists.uploads, maxResults: '50', ...(page ? { pageToken: page } : {}) }), accessToken, transport);
        for (const item of body.items || []) if (item.contentDetails?.videoId && !ids.includes(item.contentDetails.videoId)) ids.push(item.contentDetails.videoId);
        page = body.nextPageToken; hasMore = Boolean(page); if (!page) break;
      }
    }
    const posts: ChannelPost[] = [];
    for (let offset = 0; offset < ids.length; offset += 50) {
      await onProgress?.(20 + Math.round(offset / 200 * 25), 'Reading published video metadata and lifetime counts');
      const body = await youtubeJson<{ items?: any[] }>(youtubeDataUrl('videos', { part: 'snippet,contentDetails,statistics,status', id: ids.slice(offset, offset + 50).join(','), maxResults: '50' }), accessToken, transport);
      for (const video of body.items || []) {
        if (video.status?.privacyStatus !== 'public' || !video.id || video.snippet?.channelId !== channel.id || !video.snippet?.publishedAt || !Number.isFinite(Date.parse(video.snippet.publishedAt))) continue;
        posts.push({ id: stableYouTubeId(connection.workspaceId, `${connection.id}:${video.id}`, 'post'), workspaceId: connection.workspaceId, connectionId: connection.id, provider: 'youtube', providerPostId: video.id, title: String(video.snippet.title || '').slice(0, 1000), caption: String(video.snippet.description || '').slice(0, 10000), publishedAt: video.snippet.publishedAt, url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`, thumbnailUrl: /^https:\/\/i\.ytimg\.com\//.test(video.snippet.thumbnails?.medium?.url || '') ? video.snippet.thumbnails.medium.url : null, durationSeconds: isoDurationSeconds(video.contentDetails?.duration), contentType: 'video', pillar: null, pillarSource: null, mediaAssetId: null, tags: Array.isArray(video.snippet.tags) ? video.snippet.tags.slice(0, 50).map((tag: unknown) => String(tag).slice(0, 100)) : [], metrics: ['viewCount', 'likeCount', 'commentCount'].map(key => youtubeMetric(key, video.statistics?.[key], 'youtube_data_api', 'lifetime', now, null, null)).filter((value): value is MetricValue => value !== null), source: 'youtube_data_api', createdAt: now, updatedAt: now, version: 1 });
      }
    }
    const accountMetrics = ['viewCount', 'subscriberCount', 'videoCount'].map(key => youtubeMetric(key, key === 'subscriberCount' && channel.statistics?.hiddenSubscriberCount ? undefined : channel.statistics?.[key as keyof typeof channel.statistics], 'youtube_data_api', 'lifetime', now, null, null, 'channel')).filter((value): value is MetricValue => value !== null);
    const snapshot: ChannelSnapshot = { id: randomUUID(), workspaceId: connection.workspaceId, connectionId: connection.id, provider: 'youtube', observedAt: now, periodStart: start, periodEnd: end, accountMetrics, daily: [], audience: [], coverage: { postsFetched: posts.length, hasMore, limitations }, createdAt: now, version: 1 };
    const reportUrl = (dimensions: string, extra: Record<string, string> = {}) => { const url = new URL(REPORTS); for (const [key, value] of Object.entries({ ids: `channel==${channel.id}`, startDate: start, endDate: end, metrics: REPORT_METRICS.join(','), ...(dimensions ? { dimensions } : {}), ...extra })) url.searchParams.set(key, value); return url; };
    if (connection.grantedScopes.includes(YOUTUBE_SCOPES[1])) {
      await onProgress?.(55, 'Reading 90-day YouTube Analytics reports');
      try {
        const channelRows = reportRecords(await youtubeJson<Report>(reportUrl(''), accessToken, transport));
        if (channelRows[0]) snapshot.accountMetrics.push(...reportMetrics(channelRows[0], 'period', now, start, end, 'channel'));
        const daily = reportRecords(await youtubeJson<Report>(reportUrl('day', { sort: 'day' }), accessToken, transport));
        snapshot.daily = daily.filter(row => typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day) && row.day >= start && row.day <= end && Number.isFinite(Date.parse(`${row.day}T00:00:00Z`)) && new Date(`${row.day}T00:00:00Z`).toISOString().slice(0, 10) === row.day).map(row => ({ date: row.day as string, metrics: reportMetrics(row, 'daily', now, row.day as string, row.day as string, 'channel') }));
        let nextIndex = 1; const videoRows: Record<string, unknown>[] = [];
        for (let i = 0; i < 2; i++) {
          const rows = reportRecords(await youtubeJson<Report>(reportUrl('video', { sort: '-views', maxResults: '200', startIndex: String(nextIndex) }), accessToken, transport));
          videoRows.push(...rows); if (rows.length < 200) break; nextIndex += 200;
          if (i === 1) limitations.push('Per-video Analytics is capped at the top 400 videos by period views; omitted report rows are unavailable, not zero.');
        }
        for (const post of posts) { const row = videoRows.find(row => row.video === post.providerPostId); if (row) post.metrics.push(...reportMetrics(row, 'period', now, start, end, 'video')); }
        await onProgress?.(75, 'Checking available audience aggregates');
        try {
          const url = reportUrl('ageGroup,gender'); url.searchParams.set('metrics', 'viewerPercentage');
          const demographics = reportRecords(await youtubeJson<Report>(url, accessToken, transport));
          snapshot.audience = demographics.filter(row => typeof row.ageGroup === 'string' && typeof row.gender === 'string').map(row => ({ dimension: 'ageGroup,gender', value: `${row.ageGroup}, ${row.gender}`, metrics: [youtubeMetric('viewerPercentage', row.viewerPercentage, 'youtube_analytics_api', 'period', now, start, end, 'channel')].filter((m): m is MetricValue => m !== null) })).filter(group => group.metrics.length > 0);
          if (!snapshot.audience.length) limitations.push('Demographic data is unavailable or withheld by YouTube privacy thresholds for this period.');
        } catch (error) {
          if (error instanceof YouTubeProviderError && error.providerStatus === 401) throw error;
          limitations.push('YouTube did not make demographic data available for this account/report; no audience demographics were inferred.');
        }
      } catch (error) {
        if (error instanceof YouTubeProviderError && ['PERMISSION_REQUIRED', 'DEVELOPER_APPROVAL_REQUIRED'].includes(error.code)) {
          limitations.push(error.message); snapshot.daily = []; snapshot.audience = []; snapshot.accountMetrics = snapshot.accountMetrics.filter(metric => metric.source !== 'youtube_analytics_api');
          for (const post of posts) post.metrics = post.metrics.filter(metric => metric.source !== 'youtube_analytics_api');
          connection = { ...connection, status: error.code === 'DEVELOPER_APPROVAL_REQUIRED' ? 'Requires Developer Approval' : 'Needs Permission', lastError: error.message };
        } else throw error;
      }
    } else {
      limitations.push('YouTube Analytics permission was not granted. Only authorized Data API metadata and lifetime counts are available.');
    }
    await onProgress?.(90, 'Preparing source-labelled channel records');
    snapshot.postMetrics = posts.map(post => ({ postId: post.id, metrics: post.metrics }));
    return { posts, snapshot, connection: { ...connection, accountName: channel.snippet!.title!, availableMetrics: [...new Set([...posts.flatMap(p => p.metrics.map(m => `${m.source}:${m.providerMetric}:${m.scope}`)), ...snapshot.accountMetrics.map(m => `${m.source}:${m.providerMetric}:${m.scope}`), ...snapshot.daily.flatMap(d => d.metrics.map(m => `${m.source}:${m.providerMetric}:${m.scope}`))])], lastSyncedAt: now, updatedAt: now, version: connection.version + 1, lastError: connection.status === 'Connected' ? null : connection.lastError } };
  }, transport);
}
