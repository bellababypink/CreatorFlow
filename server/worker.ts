import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { store } from './store.js';
import { config } from './config.js';
import { materializeFile, putFile } from './storage.js';
import { inspectMedia, createThumbnail, analyzeVideo, ProcessingError } from './processing/index.js';
import type { StoredAsset, StoredJob, StoredWorkspace } from './models.js';
import type { Analysis } from '../shared/types.js';
const workerId = randomUUID();
let stopping = false;
const now = () => new Date().toISOString();
async function heartbeat() { await store.put('workers', { id: workerId, updatedAt: now() }); }
async function progress(job: StoredJob, value: number, stage: string, asset?: StoredAsset) {
    await store.progressJob(job.id, workerId, { progress: Math.max(0, Math.min(99, value)), stage }, asset ? [{ collection: 'assets', value: asset }] : []);
    await heartbeat();
}
async function finish(job: StoredJob, patch: Partial<StoredJob>, writes: {
    collection: string;
    value: any;
}[] = []) {
    await store.finishJob(job.id, workerId, patch, writes);
}
export async function processJob(job: StoredJob) {
    const workDir = path.join(config.dataDir, 'tmp', `job-${job.id}-${workerId}`);
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    let asset = await store.get<StoredAsset>('assets', job.assetId);
    try {
        if (!asset || asset.workspaceId !== job.workspaceId)
            throw new ProcessingError('ASSET_NOT_FOUND', 'The source video is no longer available.', false);
        asset = { ...asset, status: 'processing', updatedAt: now(), version: asset.version + 1 };
        await progress(job, 5, 'Inspecting source video', asset);
        const source = await materializeFile(asset.storageKey, path.join(workDir, 'source'));
        const metadata = await inspectMedia(source);
        asset = { ...asset, metadata, updatedAt: now(), version: asset.version + 1 };
        await progress(job, 15, 'Creating a private thumbnail', asset);
        const thumbnailPath = path.join(workDir, 'thumbnail.jpg');
        await createThumbnail(source, thumbnailPath);
        const thumbnailKey = `workspaces/${asset.workspaceId}/derived/${asset.id}/thumbnail.jpg`;
        await putFile(thumbnailKey, thumbnailPath, 'image/jpeg');
        asset = { ...asset, thumbnailKey, thumbnailReady: true, updatedAt: now(), version: asset.version + 1 };
        await progress(job, 25, 'Preparing Gemini video analysis', asset);
        const workspace = await store.get<StoredWorkspace>('workspaces', job.workspaceId);
        const result = await analyzeVideo({ filePath: source, mimeType: asset.mimeType, metadata, brandContext: workspace ? JSON.stringify({ creatorType: workspace.creatorType, niches: workspace.niches, goals: workspace.goals, brandStyle: workspace.brandStyle }) : undefined, onProgress: (value, stage) => progress(job, value, stage) });
        const analysis: Analysis = { ...result, id: randomUUID(), workspaceId: job.workspaceId, assetId: job.assetId, createdAt: now(), version: 1 };
        await finish(job, { status: 'completed', progress: 100, stage: 'Analysis saved', error: null, outputId: analysis.id }, [{ collection: 'analyses', value: analysis }, { collection: 'assets', value: { ...asset, status: 'ready', analysisId: analysis.id, updatedAt: now(), version: asset.version + 1 } }, { collection: 'usage', value: { id: randomUUID(), workspaceId: job.workspaceId, jobId: job.id, assetId: job.assetId, provider: 'gemini', model: result.model, inputBytes: asset.sizeBytes, videoSeconds: metadata.durationSeconds, tokens: result.usage || {}, costStatus: 'unpriced', createdAt: now() } }]);
    }
    catch (error) {
        const typed = error instanceof ProcessingError ? error : null;
        const blocked = typed?.code === 'CONFIGURATION_REQUIRED';
        const retry = Boolean(typed?.retryable) && !blocked && job.attempts < job.maxAttempts;
        const message = typed?.message || 'The media worker could not complete this job. Retry the analysis or inspect the worker logs.';
        console.error(`Media job ${job.id}: ${typed?.code || 'WORKER_ERROR'}`);
        if (retry) {
            await store.progressJob(job.id, workerId, { status: 'queued', stage: 'Waiting to retry', error: message, leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.pow(2, job.attempts) * 5000).toISOString() });
        }
        else {
            await finish(job, { status: blocked ? 'blocked_configuration' : 'failed', stage: blocked ? 'Configuration required' : 'Processing failed', error: message }, asset ? [{ collection: 'assets', value: { ...asset, status: blocked ? 'uploaded' : 'failed', updatedAt: now(), version: asset.version + 1 } }] : []);
        }
    }
    finally {
        await rm(workDir, { recursive: true, force: true });
    }
}
async function recoverExhaustedJobs() {
    for (const job of await store.list<StoredJob>('jobs', 'status', 'processing')) {
        if (job.status === 'processing' && job.attempts >= job.maxAttempts && Date.parse(job.leaseUntil || '') < Date.now()) {
            await store.finishJob(job.id, null, { status: 'failed', stage: 'Retry limit reached', error: 'The worker stopped repeatedly before finishing. Retry this analysis to create a new job.' });
        }
    }
}
async function main() {
    console.log(`CreatorFlow media worker started (${config.mode} mode)`);
    await heartbeat();
    const interval = setInterval(() => heartbeat().catch(() => { }), 10000);
    let nextRecoveryAt = 0;
    for (const signal of ['SIGINT', 'SIGTERM'])
        process.on(signal, () => { stopping = true; });
    while (!stopping) {
        try {
            if (Date.now() >= nextRecoveryAt) {
                await recoverExhaustedJobs();
                nextRecoveryAt = Date.now() + 60_000;
            }
            const job = await store.claimJob(workerId);
            if (job)
                await processJob(job);
            else
                await new Promise(resolve => setTimeout(resolve, 1500));
        }
        catch (error) {
            console.error('Worker queue unavailable:', error instanceof Error ? error.name : 'Error');
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    clearInterval(interval);
    await store.remove('workers', workerId);
}
if (process.argv[1]?.endsWith('/worker.ts') || process.argv[1]?.endsWith('/worker.js'))
    void main();
