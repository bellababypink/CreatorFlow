import { randomUUID } from 'node:crypto';
import { store } from './store.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import type { StoredJob, StoredWorkspace } from './models.js';
export async function reserveWorkspace(workspaceId: string, bytes: number, slot = true) {
    await store.mutate<StoredWorkspace>('workspaces', workspaceId, w => {
        if (!w)
            throw new HttpError(404, 'Workspace not found.');
        if (w.deleting)
            throw new HttpError(409, 'This workspace is being deleted.');
        if (w.storageBytes + bytes > config.storageQuotaBytes)
            throw new HttpError(413, 'Workspace storage quota reached. Delete an asset before uploading more.', 'QUOTA_EXCEEDED');
        if (slot && w.activeJobCount >= config.maxActiveJobs)
            throw new HttpError(429, 'This workspace already has the maximum number of active jobs. Try again after a job finishes.', 'JOB_LIMIT');
        return { ...w, storageBytes: Math.max(0, w.storageBytes + bytes), activeJobCount: Math.max(0, w.activeJobCount + (slot ? 1 : 0)) };
    });
}
export async function releaseWorkspace(workspaceId: string, bytes = 0, slot = true) {
    await store.mutate<StoredWorkspace>('workspaces', workspaceId, w => {
        if (!w)
            throw new Error('Workspace missing.');
        return { ...w, storageBytes: Math.max(0, w.storageBytes - bytes), activeJobCount: Math.max(0, w.activeJobCount - (slot ? 1 : 0)) };
    });
}
export function newJob(workspaceId: string, assetId: string, type: StoredJob['type'] = 'media_ingestion'): StoredJob {
    const now = new Date().toISOString();
    return { id: randomUUID(), workspaceId, assetId, type, status: 'queued', progress: 0, stage: 'Waiting for media worker', attempts: 0, maxAttempts: 3, error: null, outputId: null, createdAt: now, updatedAt: now, version: 1, slotReserved: true };
}
