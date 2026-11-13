import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChannelConnection, ChannelPost, ChannelSnapshot, MetricValue } from '../shared/channels.js';
import type { StoredJob } from '../server/models.js';

// Isolated worker orchestration tests. All Google responses below are supplied
// by an in-process test transport; no live account or external service is used.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'creatorflow-channel-worker-'));
Object.assign(process.env, {
  APP_MODE: 'local', NODE_ENV: 'test', CF_DATA_DIR: dataDir,
  APP_ORIGIN: 'http://localhost:5173', GEMINI_API_KEY: '',
  YOUTUBE_CLIENT_ID: 'worker-test.apps.googleusercontent.com', YOUTUBE_CLIENT_SECRET: 'isolated-worker-fixture',
  YOUTUBE_REDIRECT_URI: 'http://localhost:5173/api/channels/oauth/youtube/callback',
  CHANNEL_TOKEN_KEY: randomBytes(32).toString('base64'), WORKSPACE_MAX_ACTIVE_JOBS: '3',
});
const { store } = await import('../server/store.js');
const { channelJob } = await import('../server/channels/service.js');
const { processChannelJob } = await import('../server/channels/worker.js');
const { googleYouTubeTransport, stableYouTubeId, YOUTUBE_SCOPES } = await import('../server/channels/youtube.js');
const { encryptYouTubeTokens } = await import('../server/channels/token-vault.js');
const { snapshotWrites, hydrateSnapshots } = await import('../server/channels/snapshots.js');

afterEach(async () => {
  for (const collection of ['jobs','socialConnections','socialPosts','channelSecrets','analyticsSnapshots','analyticsSnapshotParts','workspaces','memberships']) {
    for (const record of await store.list<any>(collection)) await store.remove(collection, record.id);
  }
});
after(async () => { await rm(dataDir, { recursive: true, force: true }); });

async function workspace() {
  const id = randomUUID(), ownerId = randomUUID(), now = new Date().toISOString();
  await store.put('workspaces', { id, ownerId, name: 'Worker test workspace', role: 'owner', platforms: [], niches: [], goals: [], onboardingComplete: true, storageBytes: 0, activeJobCount: 0, channelRevision: 0, createdAt: now, updatedAt: now, version: 1 });
  await store.put('memberships', { id: `${id}_${ownerId}`, workspaceId: id, userId: ownerId, role: 'owner' });
  return id;
}
async function connection(workspaceId: string): Promise<ChannelConnection> {
  const now = new Date().toISOString(), id = stableYouTubeId(workspaceId, 'UC_worker_fixture', 'connection');
  const value: ChannelConnection = { id, workspaceId, provider: 'youtube', source: 'oauth', providerAccountId: 'UC_worker_fixture', accountName: 'Injected worker fixture', status: 'Connected', grantedScopes: YOUTUBE_SCOPES, missingScopes: [], lastSyncedAt: null, lastError: null, availableMetrics: [], disconnectedAt: null, generation: 1, createdAt: now, updatedAt: now, version: 1 };
  const secret = await encryptYouTubeTokens({ accessToken: 'isolated-worker-access', refreshToken: 'isolated-worker-refresh', expiresAt: new Date(Date.now() + 3600_000).toISOString(), grantedScopes: YOUTUBE_SCOPES }, workspaceId, id, 1);
  await store.commitChannelWrites(workspaceId, id, 0, [{ collection: 'socialConnections', value }, { collection: 'channelSecrets', value: secret }]);
  return value;
}
function response(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function injectGoogle(beforeVideo?: () => Promise<void>) {
  const original = { ...googleYouTubeTransport };
  const metrics = ['views','estimatedMinutesWatched','averageViewDuration','likes','comments','shares','subscribersGained','subscribersLost'];
  googleYouTubeTransport.request = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer isolated-worker-access');
    if (url.pathname.endsWith('/channels')) return response({ items: [{ id: 'UC_worker_fixture', snippet: { title: 'Injected worker fixture' }, contentDetails: { relatedPlaylists: { uploads: 'UU_worker_fixture' } }, statistics: { viewCount: '900', subscriberCount: '30', videoCount: '1' } }] });
    if (url.pathname.endsWith('/playlistItems')) return response({ items: [{ contentDetails: { videoId: 'worker_video' } }] });
    if (url.pathname.endsWith('/videos')) {
      await beforeVideo?.();
      return response({ items: [{ id: 'worker_video', status: { privacyStatus: 'public' }, snippet: { channelId: 'UC_worker_fixture', publishedAt: '2026-01-01T12:00:00Z', title: 'Injected published video', description: 'Isolated source metadata', tags: ['fixture'] }, contentDetails: { duration: 'PT15S' }, statistics: { viewCount: '120', likeCount: '8', commentCount: '2' } }] });
    }
    if (url.hostname === 'youtubeanalytics.googleapis.com') {
      const dimensions = url.searchParams.get('dimensions');
      if (!dimensions) return response({ columnHeaders: metrics.map(name => ({ name })), rows: [[40,10,15,4,2,1,1,0]] });
      if (dimensions === 'day') return response({ columnHeaders: ['day',...metrics].map(name => ({ name })), rows: [[url.searchParams.get('endDate'),40,10,15,4,2,1,1,0]] });
      if (dimensions === 'video') return response({ columnHeaders: ['video',...metrics].map(name => ({ name })), rows: [['worker_video',40,10,15,4,2,1,1,0]] });
      if (dimensions === 'ageGroup,gender') return response({ columnHeaders: ['ageGroup','gender','viewerPercentage'].map(name => ({ name })), rows: [] });
    }
    throw new Error(`Unexpected injected provider request: ${url.origin}${url.pathname}`);
  };
  googleYouTubeTransport.refresh = async () => { throw new Error('Fresh worker fixture must not refresh externally'); };
  googleYouTubeTransport.inspect = async () => ({ scopes: YOUTUBE_SCOPES, audience: process.env.YOUTUBE_CLIENT_ID!, expiresAt: Date.now() + 3600_000 });
  googleYouTubeTransport.revoke = async () => {};
  return () => Object.assign(googleYouTubeTransport, original);
}
async function claim(job: StoredJob, workerId: string) {
  await store.enqueueChannelJob(job);
  const claimed = await store.claimJob(workerId) as StoredJob | null;
  assert.ok(claimed);
  assert.equal(claimed.id, job.id);
  return claimed;
}

test('channel commit guards reject foreign ownership, stale generation/revision/lease and oversized writes atomically', async () => {
  const first = await workspace(), second = await workspace(), channel = await connection(first);
  const marker = (workspaceId: string, id = 'commit-marker') => ({ collection: 'socialPosts', value: { id, workspaceId, connectionId: channel.id } });
  await assert.rejects(store.commitChannelWrites(second, channel.id, 1, [marker(second)]), /authorization changed/);
  await assert.rejects(store.commitChannelWrites(first, channel.id, 1, [marker(second)]), /workspace-owned/);
  const revision = (await store.get<any>('workspaces', first)).channelRevision;
  await store.commitChannelWrites(first, null, null, [], { bumpRevision: true });
  await assert.rejects(store.commitChannelWrites(first, channel.id, 1, [marker(first)], { dataRevision: revision }), /data changed/);
  await store.mutate<ChannelConnection>('socialConnections', channel.id, current => ({ ...current!, generation: 2 }));
  await assert.rejects(store.commitChannelWrites(first, channel.id, 1, [marker(first)]), /authorization changed/);
  const leased = await claim(channelJob(first, 'channel_sync', { connectionId: channel.id }), 'guard-worker');
  await store.put('jobs', { ...leased, leaseUntil: new Date(Date.now() - 1).toISOString() });
  await assert.rejects(store.commitChannelWrites(first, channel.id, 2, [marker(first)], { jobId: leased.id, workerId: 'guard-worker' }), /no longer owns its lease/);
  await assert.rejects(store.commitChannelWrites(first, channel.id, 2, [marker(first, 'atomic-first'), { collection: 'socialPosts', value: { id: 'oversized-second', workspaceId: first, padding: 'x'.repeat(900_001) } }]), /storage size limit/);
  assert.equal(await store.get('socialPosts', 'commit-marker'), null);
  assert.equal(await store.get('socialPosts', 'atomic-first'), null);
  assert.equal(await store.get('socialPosts', 'oversized-second'), null);
});

test('channel enqueue atomically locks duplicate work, enforces workspace quota and releases one slot per terminal job', async () => {
  const id = await workspace(), channel = await connection(id);
  const first = channelJob(id, 'channel_sync', { connectionId: channel.id });
  await store.enqueueChannelJob(first);
  await assert.rejects(store.enqueueChannelJob(first), /already in the creative queue/);
  assert.equal((await store.get<any>('workspaces', id)).activeJobCount, 1);
  await store.enqueueChannelJob(channelJob(id, 'channel_audit', { filters: { pillar: 'one' } }));
  await store.enqueueChannelJob(channelJob(id, 'channel_audit', { filters: { pillar: 'two' } }));
  await assert.rejects(store.enqueueChannelJob(channelJob(id, 'channel_audit', { filters: { pillar: 'three' } })), /maximum number of active jobs/);
  assert.equal((await store.get<any>('workspaces', id)).activeJobCount, 3);
  const running = await store.claimJob('quota-worker') as StoredJob;
  await store.finishJob(running.id, 'quota-worker', { status: 'completed', progress: 100 });
  await store.finishJob(running.id, 'quota-worker', { status: 'completed', progress: 100 });
  assert.equal((await store.get<any>('workspaces', id)).activeJobCount, 2, 'Repeated completion cannot free a different job’s reserved slot');
  await store.enqueueChannelJob(channelJob(id, 'channel_audit', { filters: { pillar: 'three' } }));
  assert.equal((await store.get<any>('workspaces', id)).activeJobCount, 3);
});

test('channel worker runs the source adapter and persists synchronized records using isolated Google responses', { timeout: 10_000 }, async () => {
  const id = await workspace(), channel = await connection(id), now = new Date().toISOString();
  const old: ChannelPost = { id: stableYouTubeId(id, `${channel.id}:worker_video`, 'post'), workspaceId: id, connectionId: channel.id, provider: 'youtube', providerPostId: 'worker_video', title: 'Earlier fixture metadata', caption: '', publishedAt: '2026-01-01T12:00:00.000Z', url: null, thumbnailUrl: null, durationSeconds: 15, contentType: 'video', pillar: 'Creator-confirmed pillar', pillarSource: 'user_confirmed', mediaAssetId: 'owned-media-fixture', tags: [], metrics: [], source: 'youtube_data_api', createdAt: now, updatedAt: now, version: 4 };
  await store.commitChannelWrites(id, channel.id, 1, [{ collection: 'socialPosts', value: old }]);
  const job = await claim(channelJob(id, 'channel_sync', { connectionId: channel.id }), 'sync-worker');
  const restore = injectGoogle();
  try { await processChannelJob(job, 'sync-worker'); } finally { restore(); }
  const finished = await store.get<StoredJob>('jobs', job.id);
  assert.equal(finished?.status, 'completed', finished?.error || 'Expected completed synchronization');
  assert.equal(finished.progress, 100);
  assert.equal((await store.get<any>('workspaces', id)).activeJobCount, 0);
  const saved = await store.get<ChannelPost>('socialPosts', old.id);
  assert.equal(saved?.title, 'Injected published video');
  assert.equal(saved?.pillar, old.pillar);
  assert.equal(saved?.mediaAssetId, old.mediaAssetId);
  assert.equal(saved?.version, 5);
  assert.equal(saved?.contentType, 'video', 'Shorts cannot be inferred from a 15-second duration');
  assert.equal(saved?.metrics.find(metric => metric.providerMetric === 'viewCount')?.value, 120);
  assert.equal(saved?.metrics.find(metric => metric.providerMetric === 'views')?.value, 40);
  const snapshot = await store.get<ChannelSnapshot>('analyticsSnapshots', finished.outputId!);
  assert.ok(snapshot);
  assert.equal(snapshot.daily.length, 1);
  assert.equal(snapshot.audience.length, 0, 'Empty audience reports are unavailable, not inferred');
  assert.equal(snapshot.postMetrics?.[0].postId, old.id);
  const connected = await store.get<ChannelConnection>('socialConnections', channel.id);
  assert.equal(connected?.lastSyncedAt, snapshot.observedAt);
  assert.equal(connected?.generation, 1);
});

test('disconnecting during a pending source response prevents worker data persistence and releases the job slot', { timeout: 10_000 }, async () => {
  const id = await workspace(), channel = await connection(id), pending = deferred(), received = deferred();
  const job = await claim(channelJob(id, 'channel_sync', { connectionId: channel.id }), 'disconnect-race-worker');
  const restore = injectGoogle(async () => { received.resolve(); await pending.promise; });
  try {
    const processing = processChannelJob(job, 'disconnect-race-worker');
    await received.promise;
    await store.mutate<ChannelConnection>('socialConnections', channel.id, current => ({ ...current!, generation: 2, disconnectedAt: new Date().toISOString(), status: 'Needs Permission' }));
    pending.resolve();
    await processing;
  } finally { pending.resolve(); restore(); }
  const failed = await store.get<StoredJob>('jobs', job.id);
  assert.equal(failed?.status, 'failed');
  assert.match(failed?.error || '', /disconnected|authorization changed/i);
  assert.equal((await store.list('socialPosts', 'workspaceId', id)).length, 0);
  assert.equal((await store.list('analyticsSnapshots', 'workspaceId', id)).length, 0);
  assert.equal((await store.get<any>('workspaces', id)).activeJobCount, 0);
  assert.equal((await store.get<ChannelConnection>('socialConnections', channel.id))?.lastSyncedAt, null);
});

test('large snapshot packing retains 200 post observations below document limits and excludes foreign parts', () => {
  const now = new Date().toISOString();
  const metric: MetricValue = { key: 'views', providerMetric: 'views', label: 'Supplied observation', definition: 'x'.repeat(1500), unit: 'count', value: 120, scope: 'period', periodStart: '2026-10-01', periodEnd: '2026-10-31', observedAt: now, source: 'manual_import', comparisonKey: 'isolated-packing-cohort' };
  const snapshot: ChannelSnapshot = { id: 'packed-snapshot', workspaceId: 'packing-a', connectionId: 'packing-channel', provider: 'youtube', observedAt: now, periodStart: '2026-10-01', periodEnd: '2026-10-31', accountMetrics: [], daily: [], audience: [], postMetrics: Array.from({ length: 200 }, (_, i) => ({ postId: `post-${i}`, metrics: Array.from({ length: 20 }, (_, j) => ({ ...metric, value: i + j, providerMetric: `metric-${j}` })) })), coverage: { postsFetched: 200, hasMore: false, limitations: [] }, createdAt: now, version: 1 };
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 900_000);
  const writes = snapshotWrites(snapshot);
  assert.ok(writes.length > 11, 'The round trip exercises numeric part ordering beyond single-digit indexes');
  assert.ok(writes.every(write => Buffer.byteLength(JSON.stringify(write.value), 'utf8') < 900_000));
  const base = writes.find(write => write.collection === 'analyticsSnapshots')!.value as unknown as ChannelSnapshot;
  const parts = writes.filter(write => write.collection === 'analyticsSnapshotParts').map(write => write.value as unknown as Parameters<typeof hydrateSnapshots>[1][number]);
  const foreign = { ...parts[0], id: 'foreign-part', workspaceId: 'packing-b', postMetrics: [{ postId: 'foreign-post', metrics: [metric] }] };
  const wrongConnection = { ...parts[0], id: 'wrong-connection-part', connectionId: 'other-channel', postMetrics: [{ postId: 'other-channel-post', metrics: [metric] }] };
  const wrongSnapshot = { ...parts[0], id: 'wrong-snapshot-part', snapshotId: 'other-snapshot', postMetrics: [{ postId: 'other-snapshot-post', metrics: [metric] }] };
  const hydrated = hydrateSnapshots([base], [...parts, foreign, wrongConnection, wrongSnapshot])[0];
  assert.deepEqual(hydrated.postMetrics?.map(post=>post.postId),snapshot.postMetrics!.map(post=>post.postId),'Multipart hydration preserves the original post ordering');
  const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(fingerprint(hydrated.postMetrics),fingerprint(snapshot.postMetrics),'All metric values survive packing');
  const {postMetrics:actualMetrics,...actualMetadata}=hydrated;
  const {postMetrics:expectedMetrics,...expectedMetadata}=snapshot;
  assert.deepEqual(actualMetadata,expectedMetadata,'All snapshot metadata survives packing');
  assert.equal(hydrateSnapshots([snapshot], [foreign])[0], snapshot);
});
