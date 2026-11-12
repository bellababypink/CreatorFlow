import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

// Isolated local-backend integration tests. No Gemini request is stubbed or
// presented as a real analysis; uploaded bytes here test authorization/storage.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'creatorflow-http-test-'));
process.env.APP_MODE = 'local';
process.env.NODE_ENV = 'test';
process.env.CF_DATA_DIR = dataDir;
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.MAX_UPLOAD_BYTES = '4096';
process.env.WORKSPACE_STORAGE_QUOTA_BYTES = '10000';
process.env.WORKSPACE_MAX_ACTIVE_JOBS = '2';
delete process.env.GEMINI_API_KEY;

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
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  await rm(dataDir, { recursive: true, force: true });
});

async function json(route: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.origin) headers.Origin = options.origin;
  const response = await fetch(`${base}${route}`, {
    method: options.method || 'GET', headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null, response };
}

function session(response: Response): string {
  const value = response.headers.getSetCookie().find((cookie) => cookie.startsWith('creatorflow_session='));
  assert.ok(value, 'Sign-in must set a real session cookie');
  assert.match(value, /HttpOnly/i);
  assert.match(value, /SameSite=Lax/i);
  return value.split(';')[0];
}

async function upload(workspaceId: string, cookie: string, bytes: Uint8Array, mime = 'video/mp4', name = 'authorization-fixture.mp4') {
  const form = new FormData();
  form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), name);
  const response = await fetch(`${base}/api/workspaces/${workspaceId}/assets`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  return { status: response.status, data: await response.json() };
}

test('persistent local API enforces identity, workspace isolation, file access, roles and queue recovery', async (t) => {
  let aliceCookie = '', bobCookie = '', aliceId = '', bobId = '', workspaceId = '', bobWorkspaceId = '';
  let assetId = '', firstJobId = '', secondJobId = '';
  const fixture = Uint8Array.from({ length: 64 }, (_, i) => i);
  const password = 'a-real-test-password-12';

  await t.test('anonymous requests, invalid input and cross-origin mutations are rejected', async () => {
    assert.equal((await json('/api/me')).status, 401);
    assert.equal((await json('/api/workspaces', { method: 'POST', body: { name: 'Private' } })).status, 401);
    assert.equal((await json('/api/auth/signup', { method: 'POST', body: { name: '', email: 'invalid', password: 'short' } })).status, 400);
    assert.equal((await json('/api/auth/signup', { method: 'POST', origin: 'https://untrusted.example', body: { name: 'CSRF', email: 'csrf@example.test', password } })).status, 403);
    const crossSite = await fetch(`${base}/api/auth/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ name: 'CSRF', email: 'csrf@example.test', password }),
    });
    assert.equal(crossSite.status, 403, 'Fetch metadata rejects cross-site mutations even without an Origin header');
    const malformed = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"invalid":' });
    assert.equal(malformed.status, 400);
    const status = await json('/api/status');
    assert.equal(status.data.mode, 'local');
    assert.equal(status.data.geminiConfigured, false);
    assert.equal(status.data.workerAvailable, false);
    assert.equal(status.data.limits.maxUploadBytes, 4096);
  });

  await t.test('signup stores hashed credentials and signin reopens persisted workspaces', async () => {
    const alice = await json('/api/auth/signup', { method: 'POST', body: { name: 'Alice', email: 'ALICE@example.test', password } });
    assert.equal(alice.status, 201);
    aliceCookie = session(alice.response);
    aliceId = alice.data.user.id;
    assert.equal(alice.data.user.email, 'alice@example.test');
    const bob = await json('/api/auth/signup', { method: 'POST', body: { name: 'Bob', email: 'bob@example.test', password } });
    assert.equal(bob.status, 201);
    bobCookie = session(bob.response);
    bobId = bob.data.user.id;
    assert.notEqual(aliceId, bobId);
    assert.equal((await json('/api/auth/signup', { method: 'POST', body: { name: 'Duplicate', email: 'alice@example.test', password } })).status, 409);
    assert.equal((await json('/api/auth/signin', { method: 'POST', body: { email: 'alice@example.test', password: 'a-wrong-password-12' } })).status, 401);

    const workspace = await json('/api/workspaces', { method: 'POST', cookie: aliceCookie, body: { name: 'Alice Studio', platforms: ['youtube'], niches: ['education'], goals: ['community'], onboardingComplete: true } });
    assert.equal(workspace.status, 201);
    workspaceId = workspace.data.id;
    assert.equal(workspace.data.role, 'owner');
    assert.equal(workspace.data.onboardingComplete, true);
    const bobWorkspace = await json('/api/workspaces', { method: 'POST', cookie: bobCookie, body: { name: 'Bob Studio' } });
    bobWorkspaceId = bobWorkspace.data.id;

    assert.equal((await json(`/api/workspaces/${workspaceId}`, { method: 'PATCH', cookie: aliceCookie, body: { ownerId: bobId } })).status, 400);
    const update = await json(`/api/workspaces/${workspaceId}`, { method: 'PATCH', cookie: aliceCookie, body: { brandStyle: { voice: 'Warm and concise', source: 'user_confirmed' } } });
    assert.equal(update.status, 200);
    assert.equal(update.data.brandStyle.source, 'user_confirmed');
    assert.equal((await json(`/api/workspaces/${workspaceId}`, { method: 'PATCH', cookie: aliceCookie, body: { brandStyle: { voice: 'Assumed', source: 'detected' } } })).status, 400);

    assert.equal((await json('/api/auth/signout', { method: 'POST', cookie: aliceCookie })).status, 200);
    assert.equal((await json('/api/me', { cookie: aliceCookie })).status, 401);
    const signedIn = await json('/api/auth/signin', { method: 'POST', body: { email: 'alice@example.test', password } });
    assert.equal(signedIn.status, 200);
    aliceCookie = session(signedIn.response);
    const reopened = await json('/api/me', { cookie: aliceCookie });
    assert.equal(reopened.data.workspaces.length, 1);
    assert.equal(reopened.data.workspaces[0].id, workspaceId);
    assert.equal(reopened.data.workspaces[0].brandStyle.voice, 'Warm and concise');
    const db = new DatabaseSync(path.join(dataDir, 'creatorflow.sqlite'), { readOnly: true });
    try {
      const row = db.prepare("SELECT data FROM records WHERE collection='credentials'").get() as { data: string };
      assert.ok(row);
      assert.equal(row.data.includes(password), false);
      assert.match(JSON.parse(row.data).passwordHash, /^[a-f0-9]+:[a-f0-9]+$/);
      const persisted = db.prepare("SELECT data FROM records WHERE collection='workspaces' AND id=?").get(workspaceId) as { data: string };
      assert.equal(JSON.parse(persisted.data).name, 'Alice Studio');
    } finally { db.close(); }
  });

  await t.test('private uploads persist and authorization covers every media endpoint', async () => {
    const uploaded = await upload(workspaceId, aliceCookie, fixture);
    assert.equal(uploaded.status, 202);
    assetId = uploaded.data.asset.id;
    firstJobId = uploaded.data.job.id;
    assert.equal(uploaded.data.job.status, 'queued');
    assert.equal(uploaded.data.asset.analysisId, null);
    assert.equal('storageKey' in uploaded.data.asset, false);
    assert.equal('sha256' in uploaded.data.asset, false);
    const stored = await store.get<any>('assets', assetId);
    const original = await readFile(path.join(dataDir, 'media', stored.storageKey));
    assert.deepEqual(original, Buffer.from(fixture));
    assert.equal((await stat(path.join(dataDir, 'media'))).mode & 0o077, 0);

    for (const suffix of ['', `/${assetId}`, `/${assetId}/content`, `/${assetId}/thumbnail`]) {
      assert.equal((await json(`/api/workspaces/${workspaceId}/assets${suffix}`, { cookie: bobCookie })).status, 403, suffix);
    }
    for (const suffix of ['jobs', 'providers', 'export']) assert.equal((await json(`/api/workspaces/${workspaceId}/${suffix}`, { cookie: bobCookie })).status, 403, suffix);
    assert.equal((await json(`/api/workspaces/${workspaceId}/assets/${assetId}/analyze`, { method: 'POST', cookie: bobCookie })).status, 403);
    assert.equal((await json(`/api/workspaces/${workspaceId}/assets/${assetId}`, { method: 'DELETE', cookie: bobCookie })).status, 403);
    assert.equal((await json(`/api/workspaces/${bobWorkspaceId}/assets/${assetId}`, { cookie: bobCookie })).status, 404);
    assert.equal((await json(`/api/workspaces/${workspaceId}/assets/${assetId}/content`)).status, 401);

    const range = await fetch(`${base}/api/workspaces/${workspaceId}/assets/${assetId}/content`, { headers: { Cookie: aliceCookie, Range: 'bytes=4-11' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 4-11/64');
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.from(fixture.slice(4, 12)));
    const detail = await json(`/api/workspaces/${workspaceId}/assets/${assetId}`, { cookie: aliceCookie });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.analysis, null, 'No fake Gemini result may appear');
    assert.equal(detail.data.job.id, firstJobId);
    assert.equal((await json(`/api/workspaces/${workspaceId}/assets/${assetId}`, { method: 'DELETE', cookie: aliceCookie })).status, 409, 'Cannot delete a queued job source');
  });

  await t.test('upload validation and active-job quota reject excess work', async () => {
    assert.equal((await upload(workspaceId, aliceCookie, fixture, 'text/plain', 'not-video.txt')).status, 415);
    assert.equal((await upload(workspaceId, aliceCookie, new Uint8Array(8192))).status, 413);
    assert.equal((await upload(workspaceId, aliceCookie, fixture)).status, 409);
    const next = await upload(workspaceId, aliceCookie, Uint8Array.of(101, 102, 103));
    assert.equal(next.status, 202);
    secondJobId = next.data.job.id;
    assert.equal((await upload(workspaceId, aliceCookie, Uint8Array.of(201, 202, 203))).status, 429);
    const state = await store.get<any>('workspaces', workspaceId);
    assert.equal(state.activeJobCount, 2);
    assert.equal(state.storageBytes, 67);
    assert.equal((await store.list('jobs', 'workspaceId', workspaceId)).length, 2, 'Rejected uploads cannot enqueue jobs');
    assert.equal((await store.list('assets', 'workspaceId', workspaceId)).length, 2, 'Rejected uploads cannot leave asset records');
  });

  await t.test('viewer membership permits scoped reads and denies edits and exports', async () => {
    await store.put('memberships', { id: `${workspaceId}_${bobId}`, workspaceId, userId: bobId, role: 'viewer' });
    assert.equal((await json(`/api/workspaces/${workspaceId}/assets`, { cookie: bobCookie })).status, 200);
    assert.equal((await json(`/api/workspaces/${workspaceId}/assets/${assetId}`, { cookie: bobCookie })).status, 200);
    assert.equal((await upload(workspaceId, bobCookie, Uint8Array.of(21))).status, 403);
    assert.equal((await json(`/api/workspaces/${workspaceId}`, { method: 'PATCH', cookie: bobCookie, body: { name: 'Changed' } })).status, 403);
    assert.equal((await json(`/api/workspaces/${workspaceId}/assets/${assetId}/analyze`, { method: 'POST', cookie: bobCookie })).status, 403);
    assert.equal((await json(`/api/workspaces/${workspaceId}/assets/${assetId}`, { method: 'DELETE', cookie: bobCookie })).status, 403);
    assert.equal((await json(`/api/workspaces/${workspaceId}/export`, { cookie: bobCookie })).status, 403);
  });

  await t.test('job leases recover after expiry and finishing releases quota once', async () => {
    const claimed = await store.claimJob('worker-first');
    assert.equal(claimed.id, firstJobId);
    assert.equal(claimed.attempts, 1);
    const second = await store.claimJob('worker-second');
    assert.equal(second.id, secondJobId);
    assert.equal(await store.claimJob('worker-third'), null, 'Healthy leases cannot be stolen');
    await store.put('jobs', { ...claimed, leaseUntil: new Date(Date.now() - 1000).toISOString() });
    const recovered = await store.claimJob('worker-recovery');
    assert.equal(recovered.id, firstJobId);
    assert.equal(recovered.attempts, 2);
    const originalAsset = await store.get<any>('assets', assetId);
    await assert.rejects(store.progressJob(firstJobId, 'worker-first', { progress: 90 }, [{ collection: 'assets', value: { ...originalAsset, originalName: 'stale overwrite' } }]), /lease lost/i);
    await store.finishJob(firstJobId, 'worker-first', { status: 'failed' }, [{ collection: 'assets', value: { ...originalAsset, originalName: 'stale overwrite' } }]);
    assert.equal((await store.get<any>('jobs', firstJobId)).status, 'processing', 'Stale owner cannot finish a recovered job');
    assert.equal((await store.get<any>('assets', assetId)).originalName, originalAsset.originalName, 'Stale worker cannot commit derived asset state');
    await store.finishJob(firstJobId, 'worker-recovery', { status: 'blocked_configuration', stage: 'Configuration required' });
    assert.equal((await store.get<any>('workspaces', workspaceId)).activeJobCount, 1);
    await store.finishJob(firstJobId, 'worker-recovery', { status: 'blocked_configuration' });
    assert.equal((await store.get<any>('workspaces', workspaceId)).activeJobCount, 1, 'Repeated completion cannot release another job slot');
    await store.put('jobs', { ...second, attempts: second.maxAttempts, leaseUntil: new Date(Date.now() - 1000).toISOString() });
    await store.mutate<any>('assets', second.assetId, (asset) => ({ ...asset, status: 'processing' }));
    await store.finishJob(secondJobId, null, { status: 'failed', stage: 'Retry limit reached' });
    assert.equal((await store.get<any>('assets', second.assetId)).status, 'failed', 'Exhausted abandoned jobs cannot leave the asset processing forever');
    assert.equal((await store.get<any>('workspaces', workspaceId)).activeJobCount, 0);
    assert.equal(await store.claimJob('worker-terminal'), null);
    assert.equal((await json(`/api/workspaces/${workspaceId}/assets/${assetId}/analyze`, { method: 'POST', cookie: aliceCookie })).status, 503, 'Missing Gemini configuration is explicit');

    // This presence-only key enables the enqueue boundary; no worker runs and
    // no request is made to Gemini. Check rollback without inventing AI output.
    process.env.GEMINI_API_KEY = 'configuration-presence-test-only';
    await store.mutate<any>('workspaces', workspaceId, (workspace) => ({ ...workspace, activeJobCount: 2 }));
    try {
      const retry = await json(`/api/workspaces/${workspaceId}/assets/${assetId}/analyze`, { method: 'POST', cookie: aliceCookie });
      assert.equal(retry.status, 429);
      assert.equal((await store.get<any>('assets', assetId)).activeJobId, null, 'Rejected retry cannot leave an asset permanently locked');
      assert.equal((await store.list('jobs', 'workspaceId', workspaceId)).length, 2, 'Rejected retry cannot create a job');
      assert.equal((await store.get<any>('workspaces', workspaceId)).activeJobCount, 2, 'Rejected retry cannot change quota reservations');
    } finally {
      delete process.env.GEMINI_API_KEY;
      await store.mutate<any>('workspaces', workspaceId, (workspace) => ({ ...workspace, activeJobCount: 0 }));
    }
  });

  await t.test('workspace export and asset deletion preserve privacy and release storage', async () => {
    const exported = await json(`/api/workspaces/${workspaceId}/export`, { cookie: aliceCookie });
    assert.equal(exported.status, 200);
    assert.equal(exported.data.workspace.id, workspaceId);
    assert.equal(exported.data.assets.length, 2);
    assert.equal('credentials' in exported.data, false);
    assert.equal('sessions' in exported.data, false);
    assert.equal(JSON.stringify(exported.data).includes('passwordHash'), false);
    assert.ok(exported.data.assets.every((asset: any) => asset.workspaceId === workspaceId && !('storageKey' in asset)));
    const stored = await store.get<any>('assets', assetId);
    const concurrentDeletion = await Promise.all([
      json(`/api/workspaces/${workspaceId}/assets/${assetId}`, { method: 'DELETE', cookie: aliceCookie }),
      json(`/api/workspaces/${workspaceId}/assets/${assetId}`, { method: 'DELETE', cookie: aliceCookie }),
    ]);
    assert.equal(concurrentDeletion.filter((result) => result.status === 200).length, 1, 'Only one concurrent deletion may release storage quota');
    assert.ok(concurrentDeletion.every((result) => [200, 404, 409].includes(result.status)), 'Concurrent loser must report already missing or being deleted');
    assert.equal(await store.get('assets', assetId), null);
    assert.equal(await store.get('jobs', firstJobId), null);
    await assert.rejects(stat(path.join(dataDir, 'media', stored.storageKey)), { code: 'ENOENT' });
    assert.equal((await json(`/api/workspaces/${workspaceId}/assets/${assetId}/content`, { cookie: aliceCookie })).status, 404);
    assert.equal((await store.get<any>('workspaces', workspaceId)).storageBytes, 3);
  });

  await t.test('workspace/account deletion requires ownership, confirmation and reauthentication', async () => {
    assert.equal((await json('/api/account', { method: 'DELETE', cookie: aliceCookie, body: { confirmation: 'alice@example.test', password } })).status, 409, 'Owners must delete or transfer workspaces first');
    assert.equal((await json(`/api/workspaces/${workspaceId}`, { method: 'DELETE', cookie: aliceCookie, body: { confirmation: 'wrong' } })).status, 400);
    assert.equal((await json(`/api/workspaces/${workspaceId}`, { method: 'DELETE', cookie: bobCookie, body: { confirmation: 'Alice Studio' } })).status, 403);
    assert.equal((await json(`/api/workspaces/${bobWorkspaceId}`, { method: 'DELETE', cookie: bobCookie, body: { confirmation: 'Bob Studio' } })).status, 200);
    const accountExport = await json('/api/account/export', { cookie: bobCookie });
    assert.equal(accountExport.status, 200);
    assert.equal(accountExport.data.user.id, bobId);
    assert.equal(JSON.stringify(accountExport.data).includes('passwordHash'), false);
    assert.equal((await json('/api/account', { method: 'DELETE', cookie: bobCookie, body: { confirmation: 'bob@example.test' } })).status, 401);
    assert.equal((await json('/api/account', { method: 'DELETE', cookie: bobCookie, body: { confirmation: 'bob@example.test', password } })).status, 200);
    assert.equal((await json('/api/me', { cookie: bobCookie })).status, 401);
    assert.equal((await json(`/api/workspaces/${workspaceId}/assets`, { cookie: aliceCookie })).data.length, 1, 'Deleting a viewer account preserves another owner’s workspace');
    assert.equal((await json(`/api/workspaces/${workspaceId}`, { method: 'DELETE', cookie: aliceCookie, body: { confirmation: 'Alice Studio' } })).status, 200);
    assert.equal(await store.get('workspaces', workspaceId), null);
    for (const collection of ['memberships', 'assets', 'analyses', 'jobs', 'auditLogs', 'usage']) assert.equal((await store.list(collection, 'workspaceId', workspaceId)).length, 0, collection);
    assert.equal((await json('/api/account', { method: 'DELETE', cookie: aliceCookie, body: { confirmation: 'alice@example.test', password } })).status, 200);
    assert.equal((await json('/api/me', { cookie: aliceCookie })).status, 401);
  });
});

test('production configuration fails closed without real cloud configuration', () => {
  const configModule = new URL('../server/config.ts', import.meta.url).href;
  const run = (overrides: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(configModule)})`], {
    env: { ...process.env, FIREBASE_WEB_API_KEY: '', FIREBASE_AUTH_DOMAIN: '', FIREBASE_PROJECT_ID: '', FIREBASE_STORAGE_BUCKET: '', FIREBASE_APP_ID: '', ...overrides },
    encoding: 'utf8', timeout: 10_000,
  });
  const localProduction = run({ NODE_ENV: 'production', APP_MODE: 'local' });
  assert.notEqual(localProduction.status, 0);
  assert.match(localProduction.stderr, /Local accounts are disabled in production/);
  const unconfiguredFirebase = run({ NODE_ENV: 'production', APP_MODE: 'firebase' });
  assert.notEqual(unconfiguredFirebase.status, 0);
  assert.match(unconfiguredFirebase.stderr, /Firebase mode requires/);
  const invalidLimit = run({ NODE_ENV: 'test', APP_MODE: 'local', MAX_UPLOAD_BYTES: 'NaN' });
  assert.notEqual(invalidLimit.status, 0);
  assert.match(invalidLimit.stderr, /must be a positive finite number/);
});
