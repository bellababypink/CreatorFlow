import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { ChannelOverview, ImportPreview } from '../shared/channels.js';

// Real HTTP requests to an isolated local database. CSV values and direct store
// fixtures are test evidence, never a claim of live YouTube access or Gemini use.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'creatorflow-channel-http-'));
Object.assign(process.env, {
  APP_MODE: 'local', NODE_ENV: 'test', CF_DATA_DIR: dataDir,
  APP_ORIGIN: 'http://localhost:5173', GEMINI_API_KEY: '',
  YOUTUBE_CLIENT_ID: '', YOUTUBE_CLIENT_SECRET: '', YOUTUBE_REDIRECT_URI: '',
});
const { app } = await import('../server/app.js');
const { store } = await import('../server/store.js');
let server: Server;
let base: string;

before(async () => {
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  await rm(dataDir, { recursive: true, force: true });
});

async function request(route: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.origin) headers.Origin = options.origin;
  const response = await fetch(base + route, {
    method: options.method || 'GET', headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const data = response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text;
  return { status: response.status, data, response };
}
async function signup(name: string, email: string) {
  const result = await request('/api/auth/signup', { method: 'POST', body: { name, email, password: 'isolated-channel-test-password' } });
  assert.equal(result.status, 201);
  const cookie = result.response.headers.getSetCookie().find(c => c.startsWith('creatorflow_session='))?.split(';')[0];
  assert.ok(cookie);
  return { id: result.data.user.id as string, cookie };
}
const csv = [
  'postId,title,publishedAt,durationSeconds,contentType,pillar,caption,metricScope,periodStart,periodEnd,observedAt,views,likes,comments,viewsDefinition',
  'post-one,"Fixture: useful morning routine",2026-10-01T12:00:00Z,35,video,Routines,"A deliberately supplied test caption",lifetime,,,2026-11-01T00:00:00Z,120,8,2,Manual export cumulative views as supplied by the tester',
  'post-two,Fixture: reading corner,2026-10-10T12:00:00Z,80,video,Books,Another supplied caption,lifetime,,,2026-11-01T00:00:00Z,300,20,4,Manual export cumulative views as supplied by the tester',
].join('\n');

test('Channel Intelligence HTTP boundaries preserve provenance, real imports and tenant isolation', async t => {
  let alice: Awaited<ReturnType<typeof signup>>;
  let bob: Awaited<ReturnType<typeof signup>>;
  let viewer: Awaited<ReturnType<typeof signup>>;
  let workspaceId = '', bobWorkspaceId = '', connectionId = '', postId = '', otherPostId = '';
  let preview: ImportPreview;
  const route = (suffix = '') => `/api/workspaces/${workspaceId}/channels${suffix}`;
  const importBody = { platform: 'youtube', accountName: 'Explicit manual fixture', csv };

  await t.test('unconfigured platforms have honest statuses and private routes require identity', async () => {
    assert.equal((await request('/api/workspaces/unknown/channels')).status, 401);
    alice = await signup('Channel Alice', 'channels-alice@example.test');
    bob = await signup('Channel Bob', 'channels-bob@example.test');
    viewer = await signup('Channel Viewer', 'channels-viewer@example.test');
    const workspace = await request('/api/workspaces', { method: 'POST', cookie: alice.cookie, body: { name: 'Channel isolation A', niches: ['Education'] } });
    assert.equal(workspace.status, 201);
    workspaceId = workspace.data.id;
    const second = await request('/api/workspaces', { method: 'POST', cookie: bob.cookie, body: { name: 'Channel isolation B' } });
    assert.equal(second.status, 201);
    bobWorkspaceId = second.data.id;
    const empty = await request(route(), { cookie: alice.cookie });
    assert.equal(empty.status, 200);
    assert.equal(empty.data.connections.length, 0);
    assert.equal(empty.data.audits.length, 0);
    assert.equal(empty.data.integrations.length, 3);
    const allowed = new Set(['Connected', 'Needs Permission', 'Requires Developer Approval', 'Not Configured', 'Unavailable']);
    for (const integration of empty.data.integrations) {
      assert.ok(allowed.has(integration.status));
      assert.notEqual(integration.status, 'Connected');
    }
    assert.equal((await request(route('/youtube/authorize'), { method: 'POST', cookie: alice.cookie })).status, 503);
    assert.equal((await request(route(), { cookie: bob.cookie })).status, 403);
    assert.equal((await request(route('/overview'), { cookie: bob.cookie })).status, 403);
    assert.match(empty.response.headers.get('cache-control') || '', /private.*no-store/);
  });

  await t.test('CSV preview validates without writing, and commit is idempotent and visibly imported', async () => {
    const template = await request(route('/imports/template'), { cookie: alice.cookie });
    assert.equal(template.status, 200);
    assert.match(template.response.headers.get('content-type') || '', /text\/csv/);
    assert.match(template.data, /metricScope/);
    assert.match(template.data, /observedAt/);
    const invalid = await request(route('/imports/preview'), { method: 'POST', cookie: alice.cookie, body: { ...importBody, csv: 'postId,publishedAt\nx,not-a-date' } });
    assert.equal(invalid.status, 400);
    const result = await request(route('/imports/preview'), { method: 'POST', cookie: alice.cookie, body: importBody });
    assert.equal(result.status, 200);
    preview = result.data;
    assert.equal(preview.rows, 2);
    assert.equal(preview.posts.length, 2);
    assert.ok(preview.digest);
    assert.equal((await request(route(), { cookie: alice.cookie })).data.connections.length, 0);
    assert.equal((await request(route('/overview'), { cookie: alice.cookie })).data.posts.length, 0);
    const tampered = await request(route('/imports/commit'), { method: 'POST', cookie: alice.cookie, body: { ...importBody, digest: 'not-the-preview-digest' } });
    assert.ok([400, 409].includes(tampered.status));
    assert.equal((await request(route(), { cookie: alice.cookie })).data.connections.length, 0);
    const committed = await request(route('/imports/commit'), { method: 'POST', cookie: alice.cookie, body: { ...importBody, digest: preview.digest } });
    assert.ok([200, 201].includes(committed.status));
    connectionId = committed.data.connection.id;
    assert.equal(committed.data.connection.source, 'manual_import');
    assert.equal(committed.data.connection.status, 'Unavailable');
    assert.deepEqual(committed.data.connection.grantedScopes, []);
    const repeated = await request(route('/imports/commit'), { method: 'POST', cookie: alice.cookie, body: { ...importBody, digest: preview.digest } });
    assert.ok([200, 201, 409].includes(repeated.status));
    if (repeated.status === 409) assert.equal(repeated.data.error.code, 'IMPORT_ALREADY_EXISTS');
    else assert.equal(repeated.data.connection.id, connectionId);
    const overview = (await request(route('/overview'), { cookie: alice.cookie })).data as ChannelOverview;
    assert.equal(overview.posts.length, 2);
    assert.equal(overview.snapshots.length, 1);
    postId = overview.posts.find(p => p.providerPostId === 'post-one')!.id;
    otherPostId = overview.posts.find(p => p.providerPostId === 'post-two')!.id;
    assert.ok(postId && otherPostId);
    for (const post of overview.posts) {
      assert.equal(post.workspaceId, workspaceId);
      assert.equal(post.source, 'manual_import');
      assert.equal(post.mediaAssetId, null);
      const views = post.metrics.find(m => m.providerMetric === 'views');
      assert.ok(views);
      assert.equal(views.scope, 'lifetime');
      assert.equal(views.periodStart, null);
      assert.equal(views.periodEnd, null);
      assert.equal(views.source, 'manual_import');
      assert.ok(views.definition);
      assert.ok(views.comparisonKey);
    }
  });

  await t.test('scoped filters and comparisons keep definitions, windows and accounts separate', async () => {
    const selected = await request(route('/overview?startDate=2026-10-01&endDate=2026-10-05&platform=youtube&contentType=video&pillar=Routines'), { cookie: alice.cookie });
    assert.equal(selected.status, 200);
    assert.equal(selected.data.posts.length, 1);
    assert.equal(selected.data.posts[0].id, postId);
    assert.equal(selected.data.posts[0].metrics.find((m: any) => m.providerMetric === 'views').scope, 'lifetime', 'Publication filtering cannot turn a cumulative value into period activity');
    const changed = await request(route(`/posts/${postId}`), { method: 'PATCH', cookie: alice.cookie, body: { pillar: 'Morning experiments', contentType: 'short' } });
    assert.equal(changed.status, 200);
    const filtered = await request(route('/overview?contentType=short&pillar=Morning%20experiments'), { cookie: alice.cookie });
    assert.equal(filtered.data.posts.length, 1);
    assert.equal(filtered.data.posts[0].pillarSource, 'user_confirmed');
    const tikTokCsv = csv.replace('post-one', 'tiktok-one').replace('post-two', 'tiktok-two').replaceAll(',video,', ',tiktok,').replaceAll('Manual export cumulative views as supplied by the tester', 'TikTok manual export starts as supplied by the tester');
    const input = { platform: 'tiktok', accountName: 'Independent TikTok fixture', csv: tikTokCsv };
    const prior = await request(route('/imports/preview'), { method: 'POST', cookie: alice.cookie, body: input });
    assert.equal(prior.status, 200);
    assert.ok([200, 201].includes((await request(route('/imports/commit'), { method: 'POST', cookie: alice.cookie, body: { ...input, digest: prior.data.digest } })).status));
    const overview = (await request(route('/overview'), { cookie: alice.cookie })).data as ChannelOverview;
    assert.equal(overview.comparisons.length, 2);
    assert.deepEqual(new Set(overview.comparisons.map(c => c.provider)), new Set(['youtube', 'tiktok']));
    assert.ok(overview.comparisons.every(c => c.source === 'manual_import' && c.posts === 2));
    const viewKeys = overview.comparisons.flatMap(c => c.metrics.filter(m => m.key.includes('view')).map(m => m.comparisonKey));
    assert.ok(new Set(viewKeys).size >= 2, 'Different platform/view definitions need separate comparison identities');
    assert.equal((await request(route('/overview?startDate=not-a-date'), { cookie: alice.cookie })).status, 400);
  });

  await t.test('post and media linking enforce workspace ownership and expose missing video evidence', async () => {
    const otherInput = { ...importBody, accountName: 'Other tenant fixture' };
    const bobRoot = `/api/workspaces/${bobWorkspaceId}/channels`;
    const bobPreview = await request(bobRoot + '/imports/preview', { method: 'POST', cookie: bob.cookie, body: otherInput });
    const bobCommit = await request(bobRoot + '/imports/commit', { method: 'POST', cookie: bob.cookie, body: { ...otherInput, digest: bobPreview.data.digest } });
    assert.ok([200, 201].includes(bobCommit.status));
    const before = await request(route(`/posts/${postId}`), { cookie: alice.cookie });
    assert.equal(before.status, 200);
    assert.equal(before.data.linkedMedia, null);
    assert.equal(before.data.mediaAnalysis, null);
    assert.equal(before.data.evidenceAvailability.video, false);
    assert.equal((await request(route(`/posts/${postId}`), { cookie: bob.cookie })).status, 403);
    assert.equal((await request(bobRoot + `/posts/${postId}`, { cookie: bob.cookie })).status, 404);
    const now = new Date().toISOString();
    const asset = (id: string, ownerWorkspace: string) => ({ id, workspaceId: ownerWorkspace, uploadedBy: alice.id, originalName: 'isolated-link-fixture.mp4', mimeType: 'video/mp4', sizeBytes: 0, status: 'uploaded', metadata: null, thumbnailReady: false, analysisId: null, createdAt: now, updatedAt: now, version: 1, storageKey: `workspaces/${ownerWorkspace}/originals/${id}/source`, sha256: id });
    await store.put('assets', asset('local-link-asset', workspaceId));
    await store.put('assets', asset('foreign-link-asset', bobWorkspaceId));
    assert.equal((await request(route(`/posts/${postId}`), { method: 'PATCH', cookie: alice.cookie, body: { mediaAssetId: 'foreign-link-asset' } })).status, 404);
    assert.equal((await request(route(`/posts/${postId}`), { method: 'PATCH', cookie: alice.cookie, body: { mediaAssetId: 'local-link-asset' } })).status, 200);
    const linked = await request(route(`/posts/${postId}`), { cookie: alice.cookie });
    assert.equal(linked.data.linkedMedia.id, 'local-link-asset');
    assert.equal(linked.data.mediaAnalysis, null, 'Linking a file without completed analysis cannot fabricate visual/hook findings');

    const updateInput = { ...importBody, csv: csv.replaceAll('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z').replace(',120,8,2,', ',125,8,2,') };
    const updatedPreview = await request(route('/imports/preview'), { method: 'POST', cookie: alice.cookie, body: updateInput });
    assert.equal(updatedPreview.status, 200);
    assert.ok([200, 201].includes((await request(route('/imports/commit'), { method: 'POST', cookie: alice.cookie, body: { ...updateInput, digest: updatedPreview.data.digest } })).status));
    const afterImport = await request(route(`/posts/${postId}`), { cookie: alice.cookie });
    assert.equal(afterImport.data.post.pillar, 'Morning experiments', 'A later import cannot overwrite a creator-confirmed pillar');
    assert.equal(afterImport.data.post.pillarSource, 'user_confirmed');
    assert.equal(afterImport.data.post.mediaAssetId, 'local-link-asset', 'A later observation preserves the authorized media link');
    assert.equal(afterImport.data.post.metrics.find((m: any) => m.providerMetric === 'views').value, 125);

    const olderInput = { ...importBody, csv: csv.replaceAll('2026-11-01T00:00:00Z', '2026-10-31T00:00:00Z').replace(',120,8,2,', ',99,8,2,') };
    const olderPreview = await request(route('/imports/preview'), { method: 'POST', cookie: alice.cookie, body: olderInput });
    assert.equal(olderPreview.status, 200);
    assert.equal((await request(route('/imports/commit'), { method: 'POST', cookie: alice.cookie, body: { ...olderInput, digest: olderPreview.data.digest } })).status, 201);
    const afterOlder = await request(route(`/posts/${postId}`), { cookie: alice.cookie });
    assert.equal(afterOlder.data.post.metrics.find((m: any) => m.providerMetric === 'views' && m.scope === 'lifetime').value, 125, 'Uploading an older export cannot replace a newer observed value');

    const periodInput = { ...importBody, csv: csv.replaceAll(',lifetime,,,', ',period,2026-10-01,2026-10-31,').replaceAll('2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z') };
    const periodPreview = await request(route('/imports/preview'), { method: 'POST', cookie: alice.cookie, body: periodInput });
    assert.equal(periodPreview.status, 200);
    assert.equal((await request(route('/imports/commit'), { method: 'POST', cookie: alice.cookie, body: { ...periodInput, digest: periodPreview.data.digest } })).status, 201);
    const afterPeriod = await request(route(`/posts/${postId}`), { cookie: alice.cookie });
    assert.equal(afterPeriod.data.post.metrics.filter((m: any) => m.providerMetric === 'views').length, 2, 'Period imports preserve the existing lifetime cohort');
    assert.equal(afterPeriod.data.post.metrics.find((m: any) => m.providerMetric === 'views' && m.scope === 'lifetime').value, 125);
    assert.equal(afterPeriod.data.post.metrics.find((m: any) => m.providerMetric === 'views' && m.scope === 'period').value, 120);
    assert.equal(afterPeriod.data.post.pillar, 'Morning experiments');
    assert.equal(afterPeriod.data.post.mediaAssetId, 'local-link-asset');
    const history = (await store.list<any>('analyticsSnapshots', 'workspaceId', workspaceId)).filter(snapshot => snapshot.connectionId === connectionId);
    assert.equal(history.length, 4, 'Every confirmed export retains its immutable observation snapshot');
    assert.ok(history.some(snapshot => snapshot.postMetrics.some((item: any) => item.postId === postId && item.metrics.some((metric: any) => metric.providerMetric === 'views' && metric.value === 99))));

    const conflictingInput = { ...updateInput, csv: updateInput.csv.replace(',125,8,2,', ',126,8,2,') };
    const conflictPreview = await request(route('/imports/preview'), { method: 'POST', cookie: alice.cookie, body: conflictingInput });
    assert.equal(conflictPreview.status, 200);
    assert.equal((await request(route('/imports/commit'), { method: 'POST', cookie: alice.cookie, body: { ...conflictingInput, digest: conflictPreview.data.digest } })).status, 409, 'Conflicting values for an identical metric observation require reconciliation rather than silent overwrite');
    assert.equal((await store.list<any>('analyticsSnapshots', 'workspaceId', workspaceId)).filter(snapshot => snapshot.connectionId === connectionId).length, 4);
  });

  await t.test('viewer permissions, disconnected setup, audit failures and export redaction remain explicit', async () => {
    await store.put('memberships', { id: `${workspaceId}_${viewer.id}`, workspaceId, userId: viewer.id, role: 'viewer', createdAt: new Date().toISOString() });
    assert.equal((await request(route(), { cookie: viewer.cookie })).status, 200);
    assert.equal((await request(route(`/posts/${postId}`), { cookie: viewer.cookie })).status, 200);
    assert.equal((await request(route('/imports/commit'), { method: 'POST', cookie: viewer.cookie, body: { ...importBody, digest: preview.digest } })).status, 403);
    assert.equal((await request(route(`/posts/${postId}`), { method: 'PATCH', cookie: viewer.cookie, body: { pillar: 'Forbidden change' } })).status, 403);
    assert.equal((await request(route('/youtube/authorize'), { method: 'POST', cookie: viewer.cookie })).status, 403);
    assert.equal((await request(route(`/connections/${connectionId}/sync`), { method: 'POST', cookie: viewer.cookie })).status, 403);
    assert.equal((await request(route(`/connections/${connectionId}/refresh`), { method: 'POST', cookie: viewer.cookie })).status, 403);
    assert.equal((await request(route(`/connections/${connectionId}`), { method: 'DELETE', cookie: viewer.cookie, body: { confirmation: importBody.accountName } })).status, 403);
    assert.equal((await request(route(`/connections/${connectionId}/sync`), { method: 'POST', cookie: alice.cookie })).status, 409, 'Imported evidence is not a live provider to synchronize');
    assert.equal((await request(route(`/connections/${connectionId}/refresh`), { method: 'POST', cookie: alice.cookie })).status, 409);
    const jobsBefore = (await request(route(), { cookie: alice.cookie })).data.jobs.length;
    const audit = await request(route('/audits'), { method: 'POST', cookie: alice.cookie, body: { filters: {} } });
    assert.equal(audit.status, 503);
    const state = await request(route(), { cookie: alice.cookie });
    assert.equal(state.data.audits.length, 0, 'An unconfigured Gemini request cannot become a successful audit');
    assert.equal(state.data.jobs.length, jobsBefore);
    await store.put('channelSecrets', { id: connectionId, workspaceId, encrypted: 'PRIVATE-ISOLATED-TOKEN-MARKER' });
    const exported = await request(`/api/workspaces/${workspaceId}/export`, { cookie: alice.cookie });
    assert.equal(exported.status, 200);
    assert.equal(JSON.stringify(exported.data).includes('PRIVATE-ISOLATED-TOKEN-MARKER'), false);
    assert.equal('channelSecrets' in exported.data, false);
    const report = await request(route('/report'), { cookie: alice.cookie });
    assert.equal(report.status, 200);
    assert.match(report.response.headers.get('content-disposition') || '', /attachment/);
    assert.match(report.response.headers.get('content-type') || '', /text\/markdown/);
    assert.match(report.data, /Fixture: useful morning routine/);
    assert.match(report.data.toLowerCase(), /manual|import/);
    assert.equal(report.data.includes('PRIVATE-ISOLATED-TOKEN-MARKER'), false);
    assert.equal((await request(route('/report'), { cookie: bob.cookie })).status, 403);
  });

  await t.test('disconnect purges scoped imported evidence and cannot delete another tenant', async () => {
    assert.equal((await request(route(`/connections/${connectionId}`), { method: 'DELETE', cookie: bob.cookie, body: { confirmation: importBody.accountName } })).status, 403);
    assert.equal((await request(route(`/connections/${connectionId}`), { method: 'DELETE', cookie: alice.cookie, body: { confirmation: 'wrong account name' } })).status, 400);
    const before = await request(`/api/workspaces/${bobWorkspaceId}/channels/overview`, { cookie: bob.cookie });
    assert.equal(before.data.posts.length, 2);
    const removed = await request(route(`/connections/${connectionId}`), { method: 'DELETE', cookie: alice.cookie, body: { confirmation: importBody.accountName } });
    assert.equal(removed.status, 200);
    const overview = (await request(route('/overview?platform=youtube'), { cookie: alice.cookie })).data as ChannelOverview;
    assert.equal(overview.posts.length, 0);
    assert.equal(overview.snapshots.length, 0);
    assert.equal((await request(route(`/posts/${postId}`), { cookie: alice.cookie })).status, 404);
    assert.equal((await request(route(`/posts/${otherPostId}`), { cookie: alice.cookie })).status, 404);
    assert.equal(await store.get('channelSecrets', connectionId), null);
    assert.equal((await request(`/api/workspaces/${bobWorkspaceId}/channels/overview`, { cookie: bob.cookie })).data.posts.length, 2);
  });
});
