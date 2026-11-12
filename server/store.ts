import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getApps, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.js';
import { HttpError } from './errors.js';
import type { StoredAsset, StoredJob, StoredWorkspace } from './models.js';
type RecordData = {
    id: string;
    workspaceId?: string;
    [key: string]: any;
};
type Write = {
    collection: string;
    value: RecordData;
};
export interface Store {
    get<T = RecordData>(collection: string, id: string): Promise<T | null>;
    put<T extends {
        id: string;
    }>(collection: string, value: T): Promise<void>;
    create<T extends {
        id: string;
    }>(collection: string, value: T): Promise<boolean>;
    mutate<T extends {
        id: string;
    }>(collection: string, id: string, update: (current: T | null) => T): Promise<T>;
    remove(collection: string, id: string): Promise<void>;
    list<T = RecordData>(collection: string, field?: string, value?: string): Promise<T[]>;
    batch(operations: ({
        collection: string;
        value: RecordData;
    } | {
        collection: string;
        id: string;
    })[]): Promise<void>;
    claimJob(workerId: string): Promise<any | null>;
    finishJob(jobId: string, workerId: string | null, patch: Record<string, unknown>, writes?: Write[]): Promise<void>;
    progressJob(jobId: string, workerId: string, patch: Record<string, unknown>, writes?: Write[]): Promise<void>;
    enqueueMedia(asset: StoredAsset, job: StoredJob, newAsset: boolean): Promise<StoredAsset>;
    beginAssetDeletion(workspaceId: string, assetId: string): Promise<{ asset: StoredAsset; token: string }>;
    finishAssetDeletion(workspaceId: string, assetId: string, token: string): Promise<void>;
}
function enqueueWorkspace(workspace: StoredWorkspace | null, bytes: number): StoredWorkspace {
    if (!workspace) throw new HttpError(404, 'Workspace not found.');
    if (workspace.deleting) throw new HttpError(409, 'This workspace is being deleted.');
    if (workspace.storageBytes + bytes > config.storageQuotaBytes) throw new HttpError(413, 'Workspace storage quota reached. Delete an asset before uploading more.', 'QUOTA_EXCEEDED');
    if (workspace.activeJobCount >= config.maxActiveJobs) throw new HttpError(429, 'This workspace already has the maximum number of active jobs. Try again after a job finishes.', 'JOB_LIMIT');
    return { ...workspace, storageBytes: workspace.storageBytes + bytes, activeJobCount: workspace.activeJobCount + 1 };
}
function queuedAsset(input: StoredAsset, current: StoredAsset | null, job: StoredJob, newAsset: boolean): StoredAsset {
    if (newAsset) {
        if (current) throw new HttpError(409, 'This video already exists.');
        return { ...input, activeJobId: job.id };
    }
    if (!current || current.workspaceId !== input.workspaceId) throw new HttpError(404, 'Video not found.');
    if (current.deleting) throw new HttpError(409, 'This video is being deleted.');
    if (current.activeJobId) throw new HttpError(409, 'This video is already being processed.');
    return { ...current, status: 'uploaded', activeJobId: job.id, updatedAt: new Date().toISOString(), version: current.version + 1 };
}
function deletionLease(asset: StoredAsset | null, workspaceId: string, lease: any) {
    if (!asset || asset.workspaceId !== workspaceId) throw new HttpError(404, 'Video not found.');
    if (asset.activeJobId) throw new HttpError(409, 'Wait for processing to finish before deleting this video.');
    if (asset.deleting && lease && Date.parse(lease.expiresAt) > Date.now()) throw new HttpError(409, 'This video is already being deleted.');
    return { id: asset.id, workspaceId, token: randomUUID(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
}
export function initializeFirebase() {
    if (!getApps().length)
        initializeApp({ credential: applicationDefault(), projectId: config.firebaseConfig.projectId, storageBucket: config.bucket });
}
class SQLiteStore implements Store {
    db = new DatabaseSync(path.join(config.dataDir, 'creatorflow.sqlite'));
    constructor() {
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, workspace_id TEXT, data TEXT NOT NULL, PRIMARY KEY(collection,id)); CREATE INDEX IF NOT EXISTS records_workspace ON records(collection,workspace_id);');
    }
    async get<T>(collection: string, id: string): Promise<T | null> {
        const row = this.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection, id) as {
            data: string;
        } | undefined;
        return row ? JSON.parse(row.data) : null;
    }
    async put<T extends {
        id: string;
    }>(collection: string, value: T) {
        this.db.prepare('INSERT INTO records(collection,id,workspace_id,data) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET workspace_id=excluded.workspace_id,data=excluded.data').run(collection, value.id, (value as any).workspaceId || null, JSON.stringify(value));
    }
    async create<T extends {
        id: string;
    }>(collection: string, value: T) { return this.db.prepare('INSERT OR IGNORE INTO records(collection,id,workspace_id,data) VALUES(?,?,?,?)').run(collection, value.id, (value as any).workspaceId || null, JSON.stringify(value)).changes > 0; }
    async mutate<T extends {
        id: string;
    }>(collection: string, id: string, update: (current: T | null) => T) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const row = this.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection, id) as any;
            const next = update(row ? JSON.parse(row.data) : null);
            this.db.prepare('INSERT INTO records(collection,id,workspace_id,data) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET workspace_id=excluded.workspace_id,data=excluded.data').run(collection, id, (next as any).workspaceId || null, JSON.stringify(next));
            this.db.exec('COMMIT');
            return next;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    async remove(collection: string, id: string) { this.db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(collection, id); }
    async list<T>(collection: string, field?: string, value?: string): Promise<T[]> {
        const rows = field === 'workspaceId'
            ? this.db.prepare('SELECT data FROM records WHERE collection=? AND workspace_id=?').all(collection, value || '')
            : this.db.prepare('SELECT data FROM records WHERE collection=?').all(collection);
        return rows.map((row: any) => JSON.parse(row.data)).filter((item) => !field || item[field] === value);
    }
    async batch(operations: ({
        collection: string;
        value: RecordData;
    } | {
        collection: string;
        id: string;
    })[]) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const op of operations) {
                if ('value' in op)
                    this.db.prepare('INSERT INTO records(collection,id,workspace_id,data) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET workspace_id=excluded.workspace_id,data=excluded.data').run(op.collection, op.value.id, op.value.workspaceId || null, JSON.stringify(op.value));
                else
                    this.db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(op.collection, op.id);
            }
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    async enqueueMedia(asset: StoredAsset, job: StoredJob, newAsset: boolean) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const read = (collection: string, id: string) => {
                const row = this.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection, id) as { data: string } | undefined;
                return row ? JSON.parse(row.data) : null;
            };
            const write = (collection: string, value: RecordData) => this.db.prepare('INSERT INTO records(collection,id,workspace_id,data) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET workspace_id=excluded.workspace_id,data=excluded.data').run(collection, value.id, value.workspaceId || null, JSON.stringify(value));
            const workspace = enqueueWorkspace(read('workspaces', asset.workspaceId), newAsset ? asset.sizeBytes : 0);
            const nextAsset = queuedAsset(asset, read('assets', asset.id), job, newAsset);
            const digestId = `${asset.workspaceId}_${asset.sha256}`;
            if (newAsset && read('assetDigests', digestId)) throw new HttpError(409, 'This video is already in your Media Vault.', 'DUPLICATE_ASSET');
            write('workspaces', workspace);
            write('assets', nextAsset);
            write('jobs', job);
            if (newAsset) write('assetDigests', { id: digestId, workspaceId: asset.workspaceId, assetId: asset.id });
            this.db.exec('COMMIT');
            return nextAsset;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    async beginAssetDeletion(workspaceId: string, assetId: string) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const read = (collection: string) => {
                const row = this.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection, assetId) as { data: string } | undefined;
                return row ? JSON.parse(row.data) : null;
            };
            const asset = read('assets') as StoredAsset | null;
            const lease = deletionLease(asset, workspaceId, read('assetDeletions'));
            this.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify({ ...asset, deleting: true }), 'assets', assetId);
            this.db.prepare('INSERT INTO records(collection,id,workspace_id,data) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data').run('assetDeletions', assetId, workspaceId, JSON.stringify(lease));
            this.db.exec('COMMIT');
            return { asset: asset!, token: lease.token };
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    async finishAssetDeletion(workspaceId: string, assetId: string, token: string) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const read = (collection: string, id: string) => {
                const row = this.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection, id) as { data: string } | undefined;
                return row ? JSON.parse(row.data) : null;
            };
            const asset = read('assets', assetId) as StoredAsset | null;
            const lease = read('assetDeletions', assetId);
            if (!asset || asset.workspaceId !== workspaceId || lease?.token !== token) throw new HttpError(409, 'This video deletion was already completed or recovered.');
            const workspace = read('workspaces', workspaceId) as StoredWorkspace | null;
            if (workspace) this.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify({ ...workspace, storageBytes: Math.max(0, workspace.storageBytes - asset.sizeBytes) }), 'workspaces', workspaceId);
            for (const [collection, id] of [['assets', assetId], ['assetDeletions', assetId], ['assetDigests', `${workspaceId}_${asset.sha256}`]]) this.db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(collection, id);
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    async claimJob(workerId: string) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const rows = this.db.prepare("SELECT data FROM records WHERE collection='jobs'").all() as {
                data: string;
            }[];
            const now = Date.now();
            const candidate = rows.map(row => JSON.parse(row.data)).filter(j => (j.status === 'queued' || j.status === 'processing' && Date.parse(j.leaseUntil || '') < now) && j.attempts < j.maxAttempts && (!j.nextAttemptAt || Date.parse(j.nextAttemptAt) <= now)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
            if (!candidate) {
                this.db.exec('COMMIT');
                return null;
            }
            const job = { ...candidate, status: 'processing', workerId, attempts: candidate.attempts + 1, leaseUntil: new Date(now + 15 * 60 * 1000).toISOString(), updatedAt: new Date().toISOString() };
            this.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify(job), 'jobs', job.id);
            this.db.exec('COMMIT');
            return job;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    async finishJob(jobId: string, workerId: string | null, patch: Record<string, unknown>, writes: Write[] = []) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const fetch = (collection: string, id: string) => { const row = this.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection, id) as any; return row ? JSON.parse(row.data) : null; };
            const write = (collection: string, value: any) => this.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify(value), collection, value.id);
            const job = fetch('jobs', jobId);
            if (!job)
                throw new Error('Job missing.');
            if (workerId ? job.workerId !== workerId || job.status !== 'processing' || Date.parse(job.leaseUntil || '') < Date.now() : job.status !== 'processing' || Date.parse(job.leaseUntil || '') >= Date.now()) {
                this.db.exec('COMMIT');
                return;
            }
            const workspace = fetch('workspaces', job.workspaceId), asset = fetch('assets', job.assetId);
            for (const op of writes)
                this.db.prepare('INSERT INTO records(collection,id,workspace_id,data) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET workspace_id=excluded.workspace_id,data=excluded.data').run(op.collection, op.value.id, op.value.workspaceId || null, JSON.stringify(op.value));
            if (job.slotReserved && workspace)
                write('workspaces', { ...workspace, activeJobCount: Math.max(0, workspace.activeJobCount - 1) });
            if (asset?.activeJobId === jobId)
                write('assets', { ...(writes.find(op => op.collection === 'assets' && op.value.id === asset.id)?.value || asset), ...(workerId === null && patch.status === 'failed' ? { status: 'failed', updatedAt: new Date().toISOString(), version: asset.version + 1 } : {}), activeJobId: null });
            write('jobs', { ...job, ...patch, slotReserved: false, leaseUntil: null, updatedAt: new Date().toISOString(), version: job.version + 1 });
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    async progressJob(jobId: string, workerId: string, patch: Record<string, unknown>, writes: Write[] = []) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const row = this.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get('jobs', jobId) as any;
            const job = row ? JSON.parse(row.data) : null;
            if (!job || job.workerId !== workerId || job.status !== 'processing' || Date.parse(job.leaseUntil || '') < Date.now())
                throw new Error('Job lease lost.');
            const next = { ...job, ...patch, updatedAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(), version: job.version + 1 };
            this.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify(next), 'jobs', jobId);
            for (const op of writes)
                this.db.prepare('INSERT INTO records(collection,id,workspace_id,data) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET workspace_id=excluded.workspace_id,data=excluded.data').run(op.collection, op.value.id, op.value.workspaceId || null, JSON.stringify(op.value));
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}
class FirestoreStore implements Store {
    db;
    constructor() { initializeFirebase(); this.db = getFirestore(); }
    async get<T>(collection: string, id: string): Promise<T | null> { const snap = await this.db.collection(collection).doc(id).get(); return snap.exists ? snap.data() as T : null; }
    async put<T extends {
        id: string;
    }>(collection: string, value: T) { await this.db.collection(collection).doc(value.id).set(JSON.parse(JSON.stringify(value))); }
    async create<T extends {
        id: string;
    }>(collection: string, value: T) { try {
        await this.db.collection(collection).doc(value.id).create(JSON.parse(JSON.stringify(value)));
        return true;
    }
    catch (error: any) {
        if (error.code === 6)
            return false;
        throw error;
    } }
    async mutate<T extends {
        id: string;
    }>(collection: string, id: string, update: (current: T | null) => T): Promise<T> { const ref = this.db.collection(collection).doc(id); return this.db.runTransaction(async (tx) => { const snap = await tx.get(ref); const next = update(snap.exists ? snap.data() as T : null); tx.set(ref, JSON.parse(JSON.stringify(next))); return next; }); }
    async remove(collection: string, id: string) { await this.db.collection(collection).doc(id).delete(); }
    async list<T>(collection: string, field?: string, value?: string): Promise<T[]> {
        const query = field ? this.db.collection(collection).where(field, '==', value) : this.db.collection(collection);
        return (await query.get()).docs.map(doc => doc.data() as T);
    }
    async batch(operations: ({
        collection: string;
        value: RecordData;
    } | {
        collection: string;
        id: string;
    })[]) {
        if (operations.length > 450)
            throw new Error('Batch size exceeds safe transaction size.');
        const batch = this.db.batch();
        for (const op of operations) {
            if ('value' in op)
                batch.set(this.db.collection(op.collection).doc(op.value.id), JSON.parse(JSON.stringify(op.value)));
            else
                batch.delete(this.db.collection(op.collection).doc(op.id));
        }
        await batch.commit();
    }
    async enqueueMedia(asset: StoredAsset, job: StoredJob, newAsset: boolean) {
        const workspaceRef = this.db.collection('workspaces').doc(asset.workspaceId);
        const assetRef = this.db.collection('assets').doc(asset.id);
        const digestRef = this.db.collection('assetDigests').doc(`${asset.workspaceId}_${asset.sha256}`);
        return this.db.runTransaction(async tx => {
            const workspaceSnap = await tx.get(workspaceRef);
            const assetSnap = await tx.get(assetRef);
            const digestSnap = newAsset ? await tx.get(digestRef) : null;
            const workspace = enqueueWorkspace(workspaceSnap.exists ? workspaceSnap.data() as StoredWorkspace : null, newAsset ? asset.sizeBytes : 0);
            const nextAsset = queuedAsset(asset, assetSnap.exists ? assetSnap.data() as StoredAsset : null, job, newAsset);
            if (digestSnap?.exists) throw new HttpError(409, 'This video is already in your Media Vault.', 'DUPLICATE_ASSET');
            tx.set(workspaceRef, workspace);
            tx.set(assetRef, JSON.parse(JSON.stringify(nextAsset)));
            tx.create(this.db.collection('jobs').doc(job.id), JSON.parse(JSON.stringify(job)));
            if (newAsset) tx.create(digestRef, { id: digestRef.id, workspaceId: asset.workspaceId, assetId: asset.id });
            return nextAsset;
        });
    }
    async beginAssetDeletion(workspaceId: string, assetId: string) {
        const assetRef = this.db.collection('assets').doc(assetId);
        const leaseRef = this.db.collection('assetDeletions').doc(assetId);
        return this.db.runTransaction(async tx => {
            const assetSnap = await tx.get(assetRef), leaseSnap = await tx.get(leaseRef);
            const asset = assetSnap.exists ? assetSnap.data() as StoredAsset : null;
            const lease = deletionLease(asset, workspaceId, leaseSnap.data());
            tx.update(assetRef, { deleting: true });
            tx.set(leaseRef, lease);
            return { asset: asset!, token: lease.token };
        });
    }
    async finishAssetDeletion(workspaceId: string, assetId: string, token: string) {
        const assetRef = this.db.collection('assets').doc(assetId), leaseRef = this.db.collection('assetDeletions').doc(assetId);
        const workspaceRef = this.db.collection('workspaces').doc(workspaceId);
        await this.db.runTransaction(async tx => {
            const assetSnap = await tx.get(assetRef), leaseSnap = await tx.get(leaseRef), workspaceSnap = await tx.get(workspaceRef);
            const asset = assetSnap.exists ? assetSnap.data() as StoredAsset : null;
            if (!asset || asset.workspaceId !== workspaceId || leaseSnap.data()?.token !== token) throw new HttpError(409, 'This video deletion was already completed or recovered.');
            const workspace = workspaceSnap.data();
            if (workspace) tx.update(workspaceRef, { storageBytes: Math.max(0, workspace.storageBytes - asset.sizeBytes) });
            tx.delete(assetRef); tx.delete(leaseRef); tx.delete(this.db.collection('assetDigests').doc(`${workspaceId}_${asset.sha256}`));
        });
    }
    async claimJob(workerId: string) {
        // Prefer queued work so healthy in-flight leases cannot crowd it out.
        const queued = await this.db.collection('jobs').where('status', '==', 'queued').limit(100).get();
        const expired = await this.db.collection('jobs').where('status', '==', 'processing').where('leaseUntil', '<', new Date().toISOString()).limit(100).get();
        for (const candidate of [...queued.docs, ...expired.docs]) {
            const result = await this.db.runTransaction(async (tx) => {
                const snap = await tx.get(candidate.ref);
                const j = snap.data();
                const now = Date.now();
                if (!j || !['queued', 'processing'].includes(j.status) || j.attempts >= j.maxAttempts || j.nextAttemptAt && Date.parse(j.nextAttemptAt) > now || j.status === 'processing' && Date.parse(j.leaseUntil || '') >= now)
                    return null;
                const job = { ...j, id: snap.id, status: 'processing', workerId, attempts: j.attempts + 1, leaseUntil: new Date(now + 15 * 60 * 1000).toISOString(), updatedAt: new Date().toISOString() };
                tx.set(candidate.ref, job);
                return job;
            });
            if (result)
                return result;
        }
        return null;
    }
    async finishJob(jobId: string, workerId: string | null, patch: Record<string, unknown>, writes: Write[] = []) {
        await this.db.runTransaction(async (tx) => {
            const ref = this.db.collection('jobs').doc(jobId), snap = await tx.get(ref), job = snap.data();
            if (!job)
                throw new Error('Job missing.');
            if (workerId ? job.workerId !== workerId || job.status !== 'processing' || Date.parse(job.leaseUntil || '') < Date.now() : job.status !== 'processing' || Date.parse(job.leaseUntil || '') >= Date.now())
                return;
            const workspaceRef = this.db.collection('workspaces').doc(job.workspaceId), assetRef = this.db.collection('assets').doc(job.assetId);
            const workspaceSnap = await tx.get(workspaceRef), assetSnap = await tx.get(assetRef), workspace = workspaceSnap.data(), asset = assetSnap.data();
            for (const op of writes)
                tx.set(this.db.collection(op.collection).doc(op.value.id), JSON.parse(JSON.stringify(op.value)));
            if (job.slotReserved && workspace)
                tx.update(workspaceRef, { activeJobCount: Math.max(0, workspace.activeJobCount - 1) });
            if (asset?.activeJobId === jobId)
                tx.update(assetRef, { ...(workerId === null && patch.status === 'failed' ? { status: 'failed', updatedAt: new Date().toISOString(), version: asset.version + 1 } : {}), activeJobId: null });
            tx.set(ref, { ...job, ...patch, slotReserved: false, leaseUntil: null, updatedAt: new Date().toISOString(), version: job.version + 1 });
        });
    }
    async progressJob(jobId: string, workerId: string, patch: Record<string, unknown>, writes: Write[] = []) {
        await this.db.runTransaction(async (tx) => {
            const ref = this.db.collection('jobs').doc(jobId), snap = await tx.get(ref), job = snap.data();
            if (!job || job.workerId !== workerId || job.status !== 'processing' || Date.parse(job.leaseUntil || '') < Date.now())
                throw new Error('Job lease lost.');
            tx.set(ref, { ...job, ...patch, updatedAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(), version: job.version + 1 });
            for (const op of writes)
                tx.set(this.db.collection(op.collection).doc(op.value.id), JSON.parse(JSON.stringify(op.value)));
        });
    }
}
export const store: Store = config.mode === 'firebase' ? new FirestoreStore() : new SQLiteStore();
