import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Credentials } from 'google-auth-library';
import type { ChannelConnection } from '../shared/channels.js';
import type { YouTubeTransport } from '../server/channels/youtube.js';

// Protocol tests use an injectable, in-process Google transport. They never
// claim to verify consent, credentials, scopes or analytics for a live account.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'creatorflow-youtube-protocol-'));
Object.assign(process.env, {
  APP_MODE: 'local', NODE_ENV: 'test', CF_DATA_DIR: dataDir, APP_ORIGIN: 'http://localhost:5173',
  YOUTUBE_CLIENT_ID: 'protocol-test.apps.googleusercontent.com', YOUTUBE_CLIENT_SECRET: 'not-a-real-client-secret',
  YOUTUBE_REDIRECT_URI: 'http://localhost:5173/api/channels/oauth/youtube/callback',
  CHANNEL_TOKEN_KEY: randomBytes(32).toString('base64'), GEMINI_API_KEY: '',
});
delete process.env.YOUTUBE_APP_REVIEW_STATUS;
const { store } = await import('../server/store.js');
const { HttpError } = await import('../server/errors.js');
const { beginYouTubeAuthorization, completeYouTubeAuthorization, refreshYouTubeConnection, revokeYouTubeConnection, withYouTubeAccess } = await import('../server/channels/oauth.js');
const { getYouTubeIntegration, syncYouTube, YOUTUBE_SCOPES, YouTubeProviderError, youtubeMetric, isoDurationSeconds } = await import('../server/channels/youtube.js');
const { encryptYouTubeTokens, decryptYouTubeTokens } = await import('../server/channels/token-vault.js');
after(async () => { await rm(dataDir, { recursive: true, force: true }); });

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
function isCode(code: string) { return (error: unknown) => error instanceof HttpError && error.code === code; }
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function workspace() {
  const id = randomUUID(), userId = randomUUID(), now = new Date().toISOString();
  await store.put('workspaces', { id, ownerId: userId, name: 'Isolated protocol test', role: 'owner', platforms: [], niches: [], goals: [], onboardingComplete: true, storageBytes: 0, activeJobCount: 0, createdAt: now, updatedAt: now, version: 1 });
  await store.put('memberships', { id: `${id}_${userId}`, workspaceId: id, userId, role: 'owner' });
  return { id, userId };
}
type FakeOptions = {
  channelId?: string; scopes?: string[]; audience?: string; noRefresh?: boolean; expiresIn?: number;
  refresh?: (token: string) => Promise<Credentials>;
  request?: (url: URL, init?: RequestInit) => Promise<Response | undefined>;
  revoke?: (token: string) => Promise<void>; manyVideos?: boolean;
};
function fakeGoogle(options: FakeOptions = {}) {
  const channelId = options.channelId || `UC_fixture_${randomUUID()}`;
  const tokenSuffix = randomUUID();
  const calls = { exchanges: [] as { code: string; verifier: string }[], refreshes: [] as string[], revocations: [] as string[], urls: [] as URL[], bearers: [] as string[] };
  const access = `fixture-access-${tokenSuffix}`, renewed = `fixture-renewed-${tokenSuffix}`, refreshToken = `fixture-refresh-${tokenSuffix}`;
  const metrics = ['views','estimatedMinutesWatched','averageViewDuration','likes','comments','shares','subscribersGained','subscribersLost'];
  const transport: YouTubeTransport = {
    exchange: async (code, verifier) => { calls.exchanges.push({ code, verifier }); return { access_token: access, ...(options.noRefresh ? {} : { refresh_token: refreshToken }), expiry_date: Date.now() + (options.expiresIn || 3600_000) }; },
    inspect: async () => ({ scopes: options.scopes || YOUTUBE_SCOPES, audience: options.audience || process.env.YOUTUBE_CLIENT_ID!, expiresAt: Date.now() + 3600_000 }),
    refresh: async token => { calls.refreshes.push(token); return options.refresh ? options.refresh(token) : { access_token: renewed, expiry_date: Date.now() + 3600_000 }; },
    revoke: async token => { calls.revocations.push(token); await options.revoke?.(token); },
    request: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()); calls.urls.push(url); calls.bearers.push(new Headers(init?.headers).get('authorization') || '');
      const injected = await options.request?.(url, init); if (injected) return injected;
      if (url.pathname.endsWith('/channels')) return json({ items: [{ id: channelId, snippet: { title: 'Protocol fixture channel' }, contentDetails: { relatedPlaylists: { uploads: 'UU_fixture' } }, statistics: { viewCount: '15000', subscriberCount: '1000', videoCount: '205' } }] });
      if (url.pathname.endsWith('/playlistItems')) {
        if (options.manyVideos) {
          const page = Number(url.searchParams.get('pageToken') || '0');
          return json({ items: Array.from({ length: 50 }, (_, i) => ({ contentDetails: { videoId: `many_${page * 50 + i}` } })), nextPageToken: String(page + 1) });
        }
        return json({ items: ['video_1','unlisted_2','foreign_3','video_4'].map(videoId => ({ contentDetails: { videoId } })) });
      }
      if (url.pathname.endsWith('/videos')) return json({ items: url.searchParams.get('id')!.split(',').map(id => ({
        id, status: { privacyStatus: id === 'unlisted_2' ? 'unlisted' : 'public' },
        snippet: { channelId: id === 'foreign_3' ? 'UC_other' : channelId, publishedAt: '2026-01-01T12:00:00Z', title: `Fixture ${id}`, description: 'Authorized metadata fixture', tags: ['sample'], thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } } },
        contentDetails: { duration: 'PT15S' }, statistics: id === 'video_4' ? { viewCount: '0' } : { viewCount: '100', likeCount: '10', commentCount: '0' },
      })) });
      if (url.hostname === 'youtubeanalytics.googleapis.com') {
        const dimensions = url.searchParams.get('dimensions');
        if (!dimensions) return json({ columnHeaders: metrics.map(name => ({ name })), rows: [[270,900,200,10,5,4,3,1]] });
        if (dimensions === 'day') return json({ columnHeaders: ['day',...metrics].map(name => ({ name })), rows: [[url.searchParams.get('endDate'),25,100,240,2,1,1,1,0],['1900-01-01',999,999,999,999,999,999,999,999]] });
        if (dimensions === 'video') return json({ columnHeaders: ['video',...metrics].map(name => ({ name })), rows: [['video_1',40,10,15,2,1,1,0,0]] });
        if (dimensions === 'ageGroup,gender') return json({ columnHeaders: ['ageGroup','gender','viewerPercentage'].map(name => ({ name })), rows: [['age18-24','female',60],['age25-34','male',101]] });
      }
      throw new Error(`Unexpected mock transport request: ${url.origin}${url.pathname}`);
    }) as typeof fetch,
  };
  return { transport, calls, channelId, access, renewed, refreshToken };
}
async function link(owner: Awaited<ReturnType<typeof workspace>>, fixture = fakeGoogle()) {
  const browserNonce = randomBytes(32).toString('base64url');
  const flow = await beginYouTubeAuthorization({ workspaceId: owner.id, userId: owner.userId, browserNonce });
  const connection = await completeYouTubeAuthorization({ state: flow.state, code: 'fixture-code', userId: owner.userId, browserNonce }, fixture.transport);
  return { connection, fixture };
}
async function seedEvidence(connection: ChannelConnection, suffix = '') {
  const postId = `post_${randomUUID()}${suffix}`, snapshotId = `snapshot_${randomUUID()}`, auditId = `audit_${randomUUID()}`;
  await store.put('socialPosts', { id: postId, workspaceId: connection.workspaceId, connectionId: connection.id });
  await store.put('analyticsSnapshots', { id: snapshotId, workspaceId: connection.workspaceId, connectionId: connection.id });
  await store.put('channelAudits', { id: auditId, workspaceId: connection.workspaceId, filters: {}, sourcePostIds: [postId], sourceSnapshotIds: [snapshotId] });
  await store.put('channelAuditInputs', { id: auditId, workspaceId: connection.workspaceId, overview: { posts: [{ id: postId, connectionId: connection.id }], snapshots: [] } });
  return { postId, snapshotId, auditId };
}

test('YouTube OAuth and synchronization protocols use isolated injected provider responses, never live account data', async t => {
  await t.test('configuration status and authorization URL require the exact trusted callback, PKCE and encrypted state', async () => {
    assert.equal(getYouTubeIntegration().canConnect, true);
    const original = process.env.YOUTUBE_REDIRECT_URI;
    process.env.YOUTUBE_REDIRECT_URI = 'https://untrusted.example/callback';
    assert.equal(getYouTubeIntegration().status, 'Not Configured');
    process.env.YOUTUBE_REDIRECT_URI = original;
    const owner = await workspace(), browserNonce = randomBytes(32).toString('base64url');
    const flow = await beginYouTubeAuthorization({ workspaceId: owner.id, userId: owner.userId, browserNonce });
    const url = new URL(flow.url);
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('state'), flow.state);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('redirect_uri'), original);
    assert.deepEqual(new Set(url.searchParams.get('scope')!.split(' ')), new Set(YOUTUBE_SCOPES));
    const stateId = createHash('sha256').update(flow.state).digest('hex');
    const record = await store.get<any>('channelOAuthStates', stateId);
    assert.ok(record); assert.equal(record.workspaceId, owner.id);
    assert.notEqual(record.browserHash, browserNonce);
    assert.equal(JSON.stringify(record).includes(browserNonce), false);
    const verifier = await decryptYouTubeTokens(record.verifier, owner.id, `oauth_${stateId}`, 1);
    assert.equal(createHash('sha256').update(verifier.accessToken).digest('base64url'), url.searchParams.get('code_challenge'));
    const fixture = fakeGoogle();
    const connection = await completeYouTubeAuthorization({ state: flow.state, code: 'fixture-code', userId: owner.userId, browserNonce }, fixture.transport);
    assert.equal(connection.status, 'Connected');
    assert.equal(fixture.calls.exchanges[0].verifier, verifier.accessToken);
    const secret = await store.get<any>('channelSecrets', connection.id);
    assert.equal(JSON.stringify(secret).includes(fixture.access), false);
    assert.equal(JSON.stringify(secret).includes(fixture.refreshToken), false);
    assert.equal((await decryptYouTubeTokens(secret, owner.id, connection.id, 1)).accessToken, fixture.access);
    assert.equal(await store.get('channelOAuthStates', stateId), null);
    await assert.rejects(completeYouTubeAuthorization({ state: flow.state, code: 'replay', userId: owner.userId, browserNonce }, fixture.transport), isCode('INVALID_OAUTH_STATE'));
  });

  await t.test('wrong browser/user, expired state and revoked workspace role cannot exchange authorization codes', async () => {
    const owner = await workspace(), nonce = randomBytes(32).toString('base64url'), fixture = fakeGoogle();
    const flow = await beginYouTubeAuthorization({ workspaceId: owner.id, userId: owner.userId, browserNonce: nonce });
    const complete = (userId: string = owner.userId, browserNonce = nonce) => completeYouTubeAuthorization({ state: flow.state, code: 'fixture-code', userId, browserNonce }, fixture.transport);
    await assert.rejects(complete('other-user'), isCode('INVALID_OAUTH_STATE'));
    await assert.rejects(complete(owner.userId, 'wrong-browser'), isCode('INVALID_OAUTH_STATE'));
    await store.put('memberships', { id: `${owner.id}_${owner.userId}`, workspaceId: owner.id, userId: owner.userId, role: 'viewer' });
    await assert.rejects(complete(), isCode('FORBIDDEN'));
    await store.put('memberships', { id: `${owner.id}_${owner.userId}`, workspaceId: owner.id, userId: owner.userId, role: 'owner' });
    const stateId = createHash('sha256').update(flow.state).digest('hex');
    await store.mutate<any>('channelOAuthStates', stateId, value => ({ ...value, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    await assert.rejects(complete(), isCode('INVALID_OAUTH_STATE'));
    assert.equal(fixture.calls.exchanges.length, 0);
  });

  await t.test('denied and malformed callbacks scrub their consumed verifier', async () => {
    const owner = await workspace(), nonce = randomBytes(32).toString('base64url');
    for (const extra of [{ error: 'access_denied' }, {}]) {
      const flow = await beginYouTubeAuthorization({ workspaceId: owner.id, userId: owner.userId, browserNonce: nonce });
      await assert.rejects(completeYouTubeAuthorization({ state: flow.state, userId: owner.userId, browserNonce: nonce, ...extra }, fakeGoogle().transport));
      assert.equal(await store.get('channelOAuthStates', createHash('sha256').update(flow.state).digest('hex')), null);
    }
  });

  await t.test('provider token audience and actual granted scopes are verified without manufacturing permissions', async () => {
    for (const options of [{ audience: 'another-client' }, { scopes: [YOUTUBE_SCOPES[1]] }]) {
      const owner = await workspace(), fixture = fakeGoogle(options);
      await assert.rejects(link(owner, fixture));
      assert.equal((await store.list('socialConnections', 'workspaceId', owner.id)).length, 0);
      assert.equal(fixture.calls.revocations.length, 1);
    }
    const owner = await workspace(), fixture = fakeGoogle({ scopes: [YOUTUBE_SCOPES[0]] });
    const { connection } = await link(owner, fixture);
    assert.equal(connection.status, 'Needs Permission');
    assert.deepEqual(connection.missingScopes, [YOUTUBE_SCOPES[1]]);
    const result = await syncYouTube(connection, undefined, fixture.transport);
    assert.equal(result.posts.length, 2);
    assert.equal(result.snapshot.daily.length, 0);
    assert.equal(fixture.calls.urls.some(url => url.hostname === 'youtubeanalytics.googleapis.com'), false);
    assert.match(result.snapshot.coverage.limitations.join(' '), /Analytics permission/);
  });

  await t.test('credentials cannot be transplanted across workspaces, connections or generations, or tampered with', async () => {
    const owner = await workspace(), { connection } = await link(owner);
    const secret = await store.get<any>('channelSecrets', connection.id);
    await assert.rejects(decryptYouTubeTokens(secret, 'other-workspace', connection.id, connection.generation), isCode('CREDENTIAL_SCOPE_MISMATCH'));
    await assert.rejects(decryptYouTubeTokens(secret, owner.id, 'other-connection', connection.generation), isCode('CREDENTIAL_SCOPE_MISMATCH'));
    await assert.rejects(decryptYouTubeTokens(secret, owner.id, connection.id, connection.generation + 1), isCode('CREDENTIAL_SCOPE_MISMATCH'));
    const tampered = { ...secret, ciphertext: (secret.ciphertext[0] === 'A' ? 'B' : 'A') + secret.ciphertext.slice(1) };
    await assert.rejects(decryptYouTubeTokens(tampered, owner.id, connection.id, connection.generation), isCode('CREDENTIAL_DECRYPTION_FAILED'));
  });

  await t.test('expired access is refreshed and an API401 triggers at most one refresh/retry', async () => {
    const owner = await workspace(), fixture = fakeGoogle({ expiresIn: 10_000 });
    const { connection } = await link(owner, fixture);
    assert.equal(await withYouTubeAccess(connection, async token => token, fixture.transport), fixture.renewed);
    assert.deepEqual(fixture.calls.refreshes, [fixture.refreshToken]);
    let attempts = 0;
    assert.equal(await withYouTubeAccess(connection, async token => {
      if (++attempts === 1) throw new YouTubeProviderError(401, 'invalid_token', 'Protocol fixture401', 'AUTHORIZATION_REVOKED');
      return token;
    }, fixture.transport), fixture.renewed);
    assert.equal(attempts, 2);
    assert.equal(fixture.calls.refreshes.length, 2);
    await assert.rejects(refreshYouTubeConnection(connection.id, 'different-workspace', fixture.transport), isCode('NOT_FOUND'));
  });

  await t.test('refresh leases prevent simultaneous token rotation and disconnect fences a pending refresh', async () => {
    const owner = await workspace(), entered = deferred<void>(), finish = deferred<Credentials>();
    const fixture = fakeGoogle({ refresh: async () => { entered.resolve(); return finish.promise; } });
    const { connection } = await link(owner, fixture);
    const first = refreshYouTubeConnection(connection.id, owner.id, fixture.transport);
    await entered.promise;
    await assert.rejects(refreshYouTubeConnection(connection.id, owner.id, fixture.transport), isCode('REFRESH_IN_PROGRESS'));
    assert.equal(fixture.calls.refreshes.length, 1);
    await revokeYouTubeConnection(connection.id, owner.id, fixture.transport);
    finish.resolve({ access_token: 'fixture-stale-refresh-result', expiry_date: Date.now() + 3600_000 });
    await assert.rejects(first, isCode('AUTHORIZATION_CHANGED'));
    const saved = await store.get<any>('socialConnections', connection.id), secret = await store.get<any>('channelSecrets', connection.id);
    assert.ok(saved.disconnectedAt); assert.equal(saved.status, 'Needs Permission');
    assert.equal(saved.providerAccountId, ''); assert.equal(saved.accountName, 'Disconnected YouTube account');
    assert.equal(secret.revoked, true); assert.equal(secret.ciphertext, '');
  });

  await t.test('invalidgrant removes authorized data and audit evidence while preserving another workspace', async () => {
    const owner = await workspace(), fixture = fakeGoogle({ refresh: async () => { throw { response: { status: 400, data: { error: 'invalid_grant' } } }; } });
    const { connection } = await link(owner, fixture), evidence = await seedEvidence(connection);
    const otherOwner = await workspace(), other = await link(otherOwner), otherEvidence = await seedEvidence(other.connection);
    await assert.rejects(refreshYouTubeConnection(connection.id, owner.id, fixture.transport), isCode('AUTHORIZATION_REVOKED'));
    for (const [collection, id] of [['socialPosts', evidence.postId], ['analyticsSnapshots', evidence.snapshotId], ['channelAudits', evidence.auditId], ['channelAuditInputs', evidence.auditId]]) assert.equal(await store.get(collection, id), null);
    assert.ok(await store.get('socialPosts', otherEvidence.postId));
    const saved = await store.get<any>('socialConnections', connection.id);
    assert.ok(saved.disconnectedAt); assert.equal(saved.accountUrl, undefined); assert.equal(saved.purgeOwner, null);
  });

  await t.test('a stale refresh failure cannot purge or revoke a newer successful connection', async () => {
    const owner = await workspace(), entered = deferred<void>(), finish = deferred<Credentials>();
    const firstFixture = fakeGoogle({ refresh: async () => { entered.resolve(); return finish.promise; } });
    const { connection: old } = await link(owner, firstFixture);
    const pending = refreshYouTubeConnection(old.id, owner.id, firstFixture.transport);
    await entered.promise;
    const newFixture = fakeGoogle({ channelId: firstFixture.channelId });
    const { connection: fresh } = await link(owner, newFixture);
    assert.equal(fresh.generation, old.generation + 1);
    const evidence = await seedEvidence(fresh);
    finish.reject({ response: { status: 400, data: { error: 'invalid_grant' } } });
    await assert.rejects(pending, isCode('AUTHORIZATION_REVOKED'));
    assert.ok(await store.get('socialPosts', evidence.postId));
    const saved = await store.get<any>('socialConnections', fresh.id);
    assert.equal(saved.disconnectedAt, null); assert.equal(saved.generation, fresh.generation);
    assert.equal((await store.get<any>('channelSecrets', fresh.id)).revoked, undefined);
    assert.equal(firstFixture.calls.revocations.length, 0);
  });

  await t.test('reconnect cannot race data cleanup and remote revocation failure is explicit after local removal', async () => {
    const owner = await workspace(), fixture = fakeGoogle({ revoke: async () => { throw new Error('isolated simulated network failure'); } });
    const { connection } = await link(owner, fixture), evidence = await seedEvidence(connection);
    const entered = deferred<void>(), finish = deferred<void>(), originalBatch = store.batch.bind(store);
    store.batch = async operations => {
      if (operations.some(op => 'id' in op && op.collection === 'socialPosts' && op.id === evidence.postId)) { entered.resolve(); await finish.promise; }
      return originalBatch(operations);
    };
    const revoke = revokeYouTubeConnection(connection.id, owner.id, fixture.transport);
    try {
      await entered.promise;
      const another = fakeGoogle({ channelId: fixture.channelId });
      await assert.rejects(link(owner, another), isCode('CHANNEL_CLEANUP_PENDING'));
      finish.resolve();
      await assert.rejects(revoke, isCode('REVOCATION_UNCONFIRMED'));
    } finally { finish.resolve(); store.batch = originalBatch; }
    assert.equal(await store.get('socialPosts', evidence.postId), null);
    assert.equal((await store.get<any>('channelSecrets', connection.id)).ciphertext, '');
    assert.equal((await store.get<any>('socialConnections', connection.id)).purgeOwner, null);
  });

  await t.test('Google revocation is attempted despite a cleanup failure and missing credentials never claim provider revocation', async () => {
    const owner = await workspace(), fixture = fakeGoogle(), { connection } = await link(owner, fixture);
    const evidence = await seedEvidence(connection), originalBatch = store.batch.bind(store);
    store.batch = async operations => {
      if (operations.some(op => 'id' in op && op.collection === 'socialPosts' && op.id === evidence.postId)) throw new Error('Isolated cleanup failure');
      return originalBatch(operations);
    };
    try { await assert.rejects(revokeYouTubeConnection(connection.id, owner.id, fixture.transport), isCode('CHANNEL_CLEANUP_PENDING')); }
    finally { store.batch = originalBatch; }
    assert.deepEqual(fixture.calls.revocations, [fixture.refreshToken]);
    const pending = await store.get<any>('socialConnections', connection.id);
    assert.ok(pending.disconnectedAt); assert.ok(pending.purgeOwner);
    assert.equal((await store.get<any>('channelSecrets', connection.id)).ciphertext, '');
    // An expired cleanup lease permits a later retry to finish deletion.
    await store.mutate<any>('socialConnections', connection.id, value => ({ ...value, purgeUntil: new Date(Date.now() - 1000).toISOString() }));
    await revokeYouTubeConnection(connection.id, owner.id, fixture.transport);
    assert.equal(await store.get('socialPosts', evidence.postId), null);
    assert.equal((await store.get<any>('socialConnections', connection.id)).purgeOwner, null);

    const secondOwner = await workspace(), secondFixture = fakeGoogle(), second = await link(secondOwner, secondFixture);
    await store.remove('channelSecrets', second.connection.id);
    await assert.rejects(revokeYouTubeConnection(second.connection.id, secondOwner.id, secondFixture.transport), isCode('REVOCATION_UNCONFIRMED'));
    assert.ok((await store.get<any>('socialConnections', second.connection.id)).disconnectedAt);
    assert.equal(secondFixture.calls.revocations.length, 0);
  });

  await t.test('synchronization preserves native definitions, windows, missing data and bounded authorized metadata', async () => {
    const owner = await workspace(), fixture = fakeGoogle(), { connection } = await link(owner, fixture);
    const result = await syncYouTube(connection, undefined, fixture.transport);
    assert.equal(result.posts.length, 2, 'Nonpublic and foreign-channel videos are excluded');
    const first = result.posts.find(post => post.providerPostId === 'video_1')!, hidden = result.posts.find(post => post.providerPostId === 'video_4')!;
    assert.equal(first.durationSeconds, 15); assert.equal(first.contentType, 'video', 'Shorts must not be guessed from duration');
    assert.equal(first.metrics.find(m => m.providerMetric === 'viewCount')?.value, 100);
    assert.equal(first.metrics.find(m => m.providerMetric === 'views')?.value, 40);
    assert.notEqual(first.metrics.find(m => m.providerMetric === 'viewCount')?.comparisonKey, first.metrics.find(m => m.providerMetric === 'views')?.comparisonKey);
    assert.equal(hidden.metrics.find(m => m.key === 'views')?.value, 0, 'An actual zero is retained');
    assert.equal(hidden.metrics.some(m => m.key === 'likes'), false, 'Unavailable likes are not zero-filled');
    assert.equal(result.snapshot.daily.length, 1);
    assert.equal(result.snapshot.audience.length, 1, 'Out-of-range percentages are omitted');
    assert.equal(result.snapshot.accountMetrics.find(m => m.providerMetric === 'views')?.value, 270, 'Native channel aggregate is not replaced by a post sample sum');
    assert.match(result.snapshot.accountMetrics.find(m => m.providerMetric === 'viewCount')!.definition, /channel/);
    assert.equal(result.snapshot.postMetrics?.length, 2);
    assert.equal(result.connection.availableMetrics.includes('youtube_analytics_api:averageViewDuration:period'), true);
    const reports = fixture.calls.urls.filter(url => url.hostname === 'youtubeanalytics.googleapis.com');
    assert.ok(reports.length >= 4);
    assert.equal(Date.parse(result.snapshot.periodEnd) - Date.parse(result.snapshot.periodStart), 89 * 86400000);
    assert.equal(result.snapshot.periodEnd, new Date(Date.now() - 86400000).toISOString().slice(0, 10));
    assert.ok(reports.every(url => url.searchParams.get('ids') === `channel==${fixture.channelId}`));
    assert.ok(fixture.calls.bearers.every(bearer => bearer.startsWith('Bearer fixture-')));
    assert.equal(fixture.calls.urls.some(url => !['www.googleapis.com','youtubeanalytics.googleapis.com'].includes(url.hostname)), false);
  });

  await t.test('pagination stops at200 uploads, partial coverage is explicit, and permission/quota errors are distinct', async () => {
    const owner = await workspace(), fixture = fakeGoogle({ scopes: [YOUTUBE_SCOPES[0]], manyVideos: true }), { connection } = await link(owner, fixture);
    const result = await syncYouTube(connection, undefined, fixture.transport);
    assert.equal(result.posts.length, 200); assert.equal(result.snapshot.coverage.hasMore, true);
    assert.equal(fixture.calls.urls.filter(url => url.pathname.endsWith('/playlistItems')).length, 4);
    const permitted = fakeGoogle({ request: async url => url.hostname === 'youtubeanalytics.googleapis.com' ? json({ error: { errors: [{ reason: 'insufficientPermissions' }] } }, 403) : undefined });
    const second = await link(await workspace(), permitted);
    const partial = await syncYouTube(second.connection, undefined, permitted.transport);
    assert.equal(partial.connection.status, 'Needs Permission'); assert.equal(partial.snapshot.daily.length, 0);
    assert.ok(partial.posts.every(post => post.metrics.every(metric => metric.source === 'youtube_data_api')));
    const quota = fakeGoogle({ request: async url => url.pathname.endsWith('/playlistItems') ? json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403) : undefined });
    const third = await link(await workspace(), quota);
    await assert.rejects(syncYouTube(third.connection, undefined, quota.transport), isCode('PROVIDER_QUOTA'));
    assert.equal((await store.list('socialPosts', 'workspaceId', third.connection.workspaceId)).length, 0, 'Failed provider synchronization never publishes partial data');
  });

  await t.test('technical and metric parsing reject malformed values rather than inventing observations', () => {
    assert.equal(isoDurationSeconds('PT1H2M3.5S'), 3723.5);
    assert.equal(isoDurationSeconds('P'), null); assert.equal(isoDurationSeconds('nonsense'), null);
    assert.equal(youtubeMetric('viewCount', '1.5', 'youtube_data_api','lifetime',new Date().toISOString(),null,null), null);
    assert.equal(youtubeMetric('viewerPercentage', 101, 'youtube_analytics_api','period',new Date().toISOString(),'2026-01-01','2026-01-31'), null);
    assert.equal(youtubeMetric('likeCount', undefined, 'youtube_data_api','lifetime',new Date().toISOString(),null,null), null);
  });

  await t.test('concurrent local development key creation publishes a complete private key before use', async () => {
    const configured = process.env.CHANNEL_TOKEN_KEY; delete process.env.CHANNEL_TOKEN_KEY;
    try {
      const samples = await Promise.all(Array.from({ length: 12 }, (_, i) => encryptYouTubeTokens({ accessToken: `local-fixture-${i}`, expiresAt: new Date(Date.now()+3600_000).toISOString(), grantedScopes: [] }, 'local-ws', `local-${i}`, 1)));
      assert.equal((await readFile(path.join(dataDir,'channel-token.key'))).length, 32);
      assert.equal((await stat(path.join(dataDir,'channel-token.key'))).mode & 0o077, 0);
      for (const [i, secret] of samples.entries()) assert.equal((await decryptYouTubeTokens(secret,'local-ws',`local-${i}`,1)).accessToken,`local-fixture-${i}`);
    } finally { process.env.CHANNEL_TOKEN_KEY = configured; }
  });
});
