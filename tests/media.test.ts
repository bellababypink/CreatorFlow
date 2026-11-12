import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import type { AssetDetail } from '../shared/types.js';

const execFileAsync = promisify(execFile);
const projectDir = fileURLToPath(new URL('../', import.meta.url));

function binary(name: 'ffmpeg' | 'ffprobe'): string {
  const configured = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (configured) return configured.includes(path.sep) ? path.resolve(projectDir, configured) : configured;
  const localTool = path.join(projectDir, '.tools', name);
  return existsSync(localTool) ? localTool : name;
}

async function stopWorker(worker: ChildProcess | undefined) {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = once(worker, 'exit');
  worker.kill('SIGTERM');
  const timeout = setTimeout(() => worker.kill('SIGKILL'), 5_000);
  try { await exited; } finally { clearTimeout(timeout); }
}

test('real video survives private upload, separate-worker inspection and reopening without fake AI output', { timeout: 60_000 }, async t => {
  const ffmpeg = binary('ffmpeg');
  const ffprobe = binary('ffprobe');
  try {
    await Promise.all([
      execFileAsync(ffmpeg, ['-version'], { timeout: 5_000 }),
      execFileAsync(ffprobe, ['-version'], { timeout: 5_000 }),
    ]);
  } catch {
    t.skip('Real media test requires working FFmpeg and FFprobe. Configure FFMPEG_PATH and FFPROBE_PATH or install both tools.');
    return;
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'creatorflow-real-media-'));
  // Exercise the same hidden-directory storage shape as the default .data.
  const dataDir = path.join(scratch, '.private-data');
  await mkdir(dataDir, { mode: 0o700 });
  const fixturePath = path.join(scratch, 'authorized-synthetic-fixture.mp4');
  let server: Server | undefined;
  let worker: ChildProcess | undefined;
  let workerOutput = '';
  try {
    await execFileAsync(ffmpeg, [
      '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x8e6872:s=360x640:r=24',
      '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', fixturePath,
    ], { timeout: 20_000 });
    const fixture = await readFile(fixturePath);
    assert.ok(fixture.length > 1000, 'FFmpeg produced a genuine MP4 fixture');

    Object.assign(process.env, {
      APP_MODE: 'local', NODE_ENV: 'test', CF_DATA_DIR: dataDir,
      APP_ORIGIN: 'http://localhost:5173', GEMINI_API_KEY: '',
      FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe,
      MAX_UPLOAD_BYTES: '1048576', MAX_VIDEO_DURATION_SECONDS: '10',
      WORKSPACE_STORAGE_QUOTA_BYTES: '10485760', WORKSPACE_MAX_ACTIVE_JOBS: '2',
    });
    const { app } = await import('../server/app.js');
    const { store } = await import('../server/store.js');
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const password = 'synthetic-media-test-password';
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Media verifier', email: 'media@example.test', password }),
    });
    assert.equal(signup.status, 201);
    const cookie = signup.headers.getSetCookie().find(c => c.startsWith('creatorflow_session='))?.split(';')[0];
    assert.ok(cookie);
    const createWorkspace = await fetch(`${base}/api/workspaces`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Real media verification', onboardingComplete: true }),
    });
    assert.equal(createWorkspace.status, 201);
    const workspace = await createWorkspace.json() as { id: string };
    const form = new FormData();
    form.append('file', new Blob([fixture], { type: 'video/mp4' }), 'authorized-synthetic-fixture.mp4');
    const upload = await fetch(`${base}/api/workspaces/${workspace.id}/assets`, { method: 'POST', headers: { Cookie: cookie }, body: form });
    assert.equal(upload.status, 202);
    const uploaded = await upload.json() as { asset: { id: string }; job: { status: string } };
    assert.equal(uploaded.job.status, 'queued');
    const route = `${base}/api/workspaces/${workspace.id}/assets/${uploaded.asset.id}`;

    worker = spawn(process.execPath, ['--import', 'tsx', path.join(projectDir, 'server/worker.ts')], {
      cwd: projectDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    worker.stdout?.on('data', chunk => { workerOutput = (workerOutput + String(chunk)).slice(-8000); });
    worker.stderr?.on('data', chunk => { workerOutput = (workerOutput + String(chunk)).slice(-8000); });
    const workerError = new Promise<never>((_, reject) => worker!.once('error', reject));
    const poll = async (): Promise<AssetDetail> => {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const response: Response = await fetch(route, { headers: { Cookie: cookie } });
        assert.equal(response.status, 200);
        const detail = await response.json() as AssetDetail;
        if (detail.job && ['blocked_configuration', 'failed', 'completed'].includes(detail.job.status)) return detail;
        if (worker!.exitCode !== null || worker!.signalCode !== null) throw new Error(`Worker exited before producing a result: ${workerOutput}`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error(`Worker did not finish inspection: ${workerOutput}`);
    };
    const inspected = await Promise.race([poll(), workerError]);
    assert.equal(inspected.job?.status, 'blocked_configuration', workerOutput);
    assert.match(inspected.job?.error || '', /GEMINI_API_KEY/);
    assert.equal(inspected.analysis, null, 'A missing API key must never create a fabricated AI result');
    assert.equal(inspected.asset.analysisId, null);
    assert.equal(inspected.asset.thumbnailReady, true);
    assert.equal(inspected.asset.metadata?.durationSeconds, 3);
    assert.equal(inspected.asset.metadata.width, 360);
    assert.equal(inspected.asset.metadata.height, 640);
    assert.equal(inspected.asset.metadata.orientation, 'portrait');
    assert.equal(inspected.asset.metadata.fps, 24);
    assert.equal(inspected.asset.metadata.hasAudio, false);
    assert.equal(inspected.asset.metadata.videoCodec, 'h264');
    assert.equal((await store.get<any>('workspaces', workspace.id)).activeJobCount, 0);

    const content = await fetch(`${route}/content`, { headers: { Cookie: cookie } });
    assert.equal(content.status, 200, 'Authorized originals in the hidden private data directory must remain playable');
    assert.match(content.headers.get('content-type') || '', /^video\/mp4/);
    assert.match(content.headers.get('cache-control') || '', /private.*no-store/);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), fixture);
    const range = await fetch(`${route}/content`, { headers: { Cookie: cookie, Range: 'bytes=0-63' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 0-63/${fixture.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), fixture.subarray(0, 64));
    const thumbnail = await fetch(`${route}/thumbnail`, { headers: { Cookie: cookie } });
    assert.equal(thumbnail.status, 200);
    assert.match(thumbnail.headers.get('content-type') || '', /^image\/jpeg/);
    const jpeg = Buffer.from(await thumbnail.arrayBuffer());
    assert.equal(jpeg.subarray(0, 3).toString('hex'), 'ffd8ff');
    assert.ok(jpeg.length > 100);
    assert.equal((await fetch(`${route}/content`)).status, 401);
    assert.equal((await fetch(`${route}/thumbnail`)).status, 401);

    await stopWorker(worker);
    worker = undefined;
    const stored = await fetch(route, { headers: { Cookie: cookie } });
    assert.equal(stored.status, 200);
    const reopened = await stored.json() as AssetDetail;
    assert.deepEqual(reopened.asset.metadata, inspected.asset.metadata);
    assert.equal(reopened.job?.status, 'blocked_configuration');
    assert.equal(reopened.analysis, null);
    const signin = await fetch(`${base}/api/auth/signin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'media@example.test', password }),
    });
    assert.equal(signin.status, 200);
    const nextCookie = signin.headers.getSetCookie().find(c => c.startsWith('creatorflow_session='))?.split(';')[0];
    assert.ok(nextCookie);
    assert.equal((await fetch(route, { headers: { Cookie: nextCookie } })).status, 200);
    t.diagnostic('Genuine synthetic MP4, separate worker, FFprobe metadata, FFmpeg JPEG, private Range access and saved reopening verified; Gemini was deliberately unconfigured, never mocked.');
  } finally {
    await stopWorker(worker);
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
