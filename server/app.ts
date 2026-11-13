import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { getAuth } from 'firebase-admin/auth';
import { config } from './config.js';
import { store } from './store.js';
import { authenticate, workspaceAccess, credentialId, hashPassword, verifyPassword, createLocalSession, deleteSession, setSessionCookie } from './auth.js';
import { HttpError, safeError } from './errors.js';
import { putFile, cleanupTemporary, mediaLocation, deleteFile } from './storage.js';
import { newJob } from './jobs.js';
import { publicAsset, publicWorkspace } from './models.js';
import type { StoredAsset, StoredJob, StoredWorkspace } from './models.js';
import type { Analysis, User } from '../shared/types.js';
import { getProviderStatuses } from './providers/index.js';
import { channelsRouter, youtubeOAuthCallback } from './channels/routes.js';
import { revokeYouTubeConnection } from './channels/oauth.js';
export const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin' }); next(); });
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
app.use('/api/workspaces/:workspaceId/channels/imports', express.json({ limit: '256kb' }));
app.use(express.json({ limit: '128kb' }));
app.use(cookieParser());
app.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (req.headers['sec-fetch-site'] === 'cross-site' || origin && origin !== config.origin)
            return next(new HttpError(403, 'This request came from an untrusted origin.', 'ORIGIN_REJECTED'));
    }
    next();
});
const rateLimits = new Map<string, {
    count: number;
    until: number;
}>();
app.use('/api/auth', (req, _res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let record = rateLimits.get(key);
    if (!record || record.until < now) {
        record = { count: 0, until: now + 15 * 60 * 1000 };
        rateLimits.set(key, record);
    }
    if (++record.count > 50)
        return next(new HttpError(429, 'Too many sign-in attempts. Please wait a few minutes.', 'RATE_LIMITED'));
    if (rateLimits.size > 10000)
        for (const [k, r] of rateLimits)
            if (r.until < now)
                rateLimits.delete(k);
    next();
});
const signupSchema = z.object({ name: z.string().trim().min(1).max(100), email: z.string().trim().email().max(254).transform(v => v.toLowerCase()), password: z.string().min(10).max(128) });
const platformList = z.array(z.enum(['instagram', 'tiktok', 'youtube'])).max(3);
const textList = z.array(z.string().trim().min(1).max(100)).max(20);
const workspaceSchema = z.object({ name: z.string().trim().min(1).max(100), creatorType: z.string().trim().max(100).optional(), platforms: platformList.optional(), niches: textList.optional(), goals: textList.optional(), onboardingComplete: z.boolean().optional() }).strict();
const brandStyleSchema = z.object({ voice: z.string().max(1000).optional(), audience: z.string().max(1000).optional(), colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(10).optional(), editingPace: z.string().max(200).optional(), preferences: z.string().max(3000).optional(), source: z.literal('user_confirmed') });
const workspacePatchSchema = workspaceSchema.partial().extend({ brandStyle: brandStyleSchema.optional() }).strict();
const read = workspaceAccess();
const edit = workspaceAccess(['owner', 'administrator', 'editor']);
const admin = workspaceAccess(['owner', 'administrator']);
const upload = multer({ dest: path.join(config.dataDir, 'tmp'), limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0 }, fileFilter: (_req, file, done) => {
        if (!['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo'].includes(file.mimetype))
            return done(new HttpError(415, 'Choose an MP4, MOV, WebM, MKV, or AVI video.', 'UNSUPPORTED_FILE'));
        done(null, true);
    } });
async function assetInWorkspace(workspaceId: string, assetId: string) {
    const asset = await store.get<StoredAsset>('assets', assetId);
    if (!asset || asset.workspaceId !== workspaceId)
        throw new HttpError(404, 'Video not found.', 'NOT_FOUND');
    return asset;
}
async function audit(workspaceId: string, userId: string, action: string, resourceId: string) { await store.put('auditLogs', { id: randomUUID(), workspaceId, userId, action, resourceId, createdAt: new Date().toISOString() }); }
async function latestJob(workspaceId: string, assetId: string) { return (await store.list<StoredJob>('jobs', 'workspaceId', workspaceId)).filter(j => j.assetId === assetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null; }
app.get('/api/status', async (_req, res) => {
    const workers = await store.list<any>('workers');
    res.json({ mode: config.mode, authConfigured: config.mode === 'local' || Boolean(config.firebaseConfig.apiKey && config.firebaseConfig.projectId), geminiConfigured: Boolean(process.env.GEMINI_API_KEY), storageConfigured: config.mode === 'local' || Boolean(config.bucket), workerAvailable: workers.some(w => Date.parse(w.updatedAt) > Date.now() - 30000), ...(config.mode === 'firebase' ? { firebaseConfig: config.firebaseConfig } : {}), limits: { maxUploadBytes: config.maxUploadBytes, maxDurationSeconds: config.maxDurationSeconds } });
});
app.post('/api/auth/signup', async (req, res) => {
    if (config.mode !== 'local')
        throw new HttpError(400, 'Use Firebase sign-in for this deployment.');
    const input = signupSchema.parse(req.body);
    const id = randomUUID();
    const now = new Date().toISOString();
    const credential = { id: credentialId(input.email), userId: id, passwordHash: await hashPassword(input.password) };
    if (!await store.create('credentials', credential))
        throw new HttpError(409, 'An account with this email already exists.', 'ACCOUNT_EXISTS');
    const user = { id, name: input.name, email: input.email, createdAt: now, updatedAt: now };
    await store.put('users', user);
    await createLocalSession(res, id);
    res.status(201).json({ user: { id, name: input.name, email: input.email } });
});
app.post('/api/auth/signin', async (req, res) => {
    if (config.mode !== 'local')
        throw new HttpError(400, 'Use Firebase sign-in for this deployment.');
    const { email, password } = signupSchema.pick({ email: true, password: true }).parse(req.body);
    const credential = await store.get<any>('credentials', credentialId(email));
    if (!credential || !await verifyPassword(password, credential.passwordHash))
        throw new HttpError(401, 'Email or password is incorrect.', 'INVALID_CREDENTIALS');
    const user = await store.get<User>('users', credential.userId);
    if (!user)
        throw new HttpError(401, 'Email or password is incorrect.');
    await createLocalSession(res, user.id);
    res.json({ user: { id: user.id, name: user.name, email: user.email } });
});
app.post('/api/auth/firebase', async (req, res) => {
    if (config.mode !== 'firebase')
        throw new HttpError(400, 'Firebase authentication is not configured.', 'CONFIGURATION_REQUIRED');
    const { idToken } = z.object({ idToken: z.string().min(10).max(20000) }).parse(req.body);
    try {
        const decoded = await getAuth().verifyIdToken(idToken, true);
        if (Date.now() / 1000 - decoded.auth_time > 300)
            throw new HttpError(401, 'Sign in again to start a secure session.');
        const cookie = await getAuth().createSessionCookie(idToken, { expiresIn: config.sessionTtlMs });
        setSessionCookie(res, cookie);
        res.json({ success: true });
    }
    catch (error) {
        throw error instanceof HttpError ? error : new HttpError(401, 'Firebase sign-in could not be verified.', 'INVALID_CREDENTIALS');
    }
});
app.post('/api/auth/signout', async (req, res) => { await deleteSession(req, res); res.json({ success: true }); });
app.get('/api/channels/oauth/youtube/callback', authenticate, youtubeOAuthCallback);
app.use('/api/workspaces/:workspaceId/channels', channelsRouter);
app.get('/api/me', authenticate, async (req, res) => {
    const memberships = await store.list<any>('memberships', 'userId', req.user!.id);
    const workspaces = await Promise.all(memberships.map(async (m) => { const w = await store.get<StoredWorkspace>('workspaces', m.workspaceId); return w ? { ...publicWorkspace(w), role: m.role } : null; }));
    res.json({ user: req.user, workspaces: workspaces.filter(Boolean) });
});
app.post('/api/workspaces', authenticate, async (req, res) => {
    const input = workspaceSchema.parse(req.body);
    const memberships = await store.list('memberships', 'userId', req.user!.id);
    if (memberships.length >= 10)
        throw new HttpError(429, 'This account has reached the Stage 0 limit of 10 workspaces.');
    const id = randomUUID(), now = new Date().toISOString();
    const workspace: StoredWorkspace = { id, name: input.name, ownerId: req.user!.id, role: 'owner', creatorType: input.creatorType || '', platforms: input.platforms || [], niches: input.niches || [], goals: input.goals || [], onboardingComplete: input.onboardingComplete || false, createdAt: now, updatedAt: now, version: 1, storageBytes: 0, activeJobCount: 0 };
    await store.mutate<any>('users', req.user!.id, current => { if (!current || current.deleting)
        throw new HttpError(409, 'This account is being deleted.'); return { ...current, activeWorkspaceCreates: (current.activeWorkspaceCreates || 0) + 1 }; });
    try {
        await store.batch([{ collection: 'workspaces', value: workspace }, { collection: 'memberships', value: { id: `${id}_${req.user!.id}`, workspaceId: id, userId: req.user!.id, role: 'owner', createdAt: now, updatedAt: now } }]);
    }
    finally {
        await store.mutate<any>('users', req.user!.id, current => ({ ...current!, activeWorkspaceCreates: Math.max(0, (current?.activeWorkspaceCreates || 0) - 1) }));
    }
    await audit(id, req.user!.id, 'workspace.created', id);
    res.status(201).json(publicWorkspace(workspace));
});
app.patch('/api/workspaces/:workspaceId', authenticate, admin, async (req, res) => {
    const patch = workspacePatchSchema.parse(req.body);
    const workspace = await store.mutate<StoredWorkspace>('workspaces', String(req.params.workspaceId), current => { if (!current)
        throw new HttpError(404, 'Workspace not found.'); return { ...current, ...patch, updatedAt: new Date().toISOString(), version: current.version + 1 }; });
    await audit(workspace.id, req.user!.id, 'workspace.updated', workspace.id);
    res.json({ ...publicWorkspace(workspace), role: req.role });
});
app.get('/api/workspaces/:workspaceId/assets', authenticate, read, async (req, res) => { const assets = await store.list<StoredAsset>('assets', 'workspaceId', String(req.params.workspaceId)); res.json(assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicAsset)); });
app.post('/api/workspaces/:workspaceId/assets', authenticate, edit, upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file)
        throw new HttpError(400, 'Select a video to upload.');
    const workspaceId = String(req.params.workspaceId);
    let key = '';
    try {
        if (file.size === 0)
            throw new HttpError(400, 'This file is empty.');
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(file.path))
            digest.update(chunk);
        const sha256 = digest.digest('hex');
        const duplicate = (await store.list<StoredAsset>('assets', 'workspaceId', workspaceId)).find(a => a.sha256 === sha256);
        if (duplicate)
            throw new HttpError(409, `This video is already in your Media Vault as “${duplicate.originalName}”.`, 'DUPLICATE_ASSET');
        // Cheap preflight avoids a cloud object write when the current quota is
        // already exhausted. enqueueMedia rechecks atomically after storage.
        const workspace = await store.get<StoredWorkspace>('workspaces', workspaceId);
        if (!workspace || workspace.deleting) throw new HttpError(409, 'This workspace is unavailable for uploads.');
        if (workspace.storageBytes + file.size > config.storageQuotaBytes) throw new HttpError(413, 'Workspace storage quota reached. Delete an asset before uploading more.', 'QUOTA_EXCEEDED');
        if (workspace.activeJobCount >= config.maxActiveJobs) throw new HttpError(429, 'This workspace already has the maximum number of active jobs. Try again after a job finishes.', 'JOB_LIMIT');
        const id = randomUUID(), now = new Date().toISOString();
        key = `workspaces/${workspaceId}/originals/${id}/source`;
        await putFile(key, file.path, file.mimetype);
        const job = newJob(workspaceId, id);
        const asset: StoredAsset = { id, workspaceId, uploadedBy: req.user!.id, originalName: path.basename(file.originalname).slice(0, 255), mimeType: file.mimetype, sizeBytes: file.size, status: 'uploaded', metadata: null, thumbnailReady: false, analysisId: null, activeJobId: job.id, createdAt: now, updatedAt: now, version: 1, storageKey: key, sha256 };
        await store.enqueueMedia(asset, job, true);
        key = '';
        await audit(workspaceId, req.user!.id, 'asset.uploaded', id).catch(() => console.error('Asset upload audit record unavailable'));
        res.status(202).json({ asset: publicAsset(asset), job });
    }
    catch (error) {
        if (key)
            await deleteFile(key).catch(() => { });
        throw error;
    }
    finally {
        await cleanupTemporary(file.path);
    }
});
app.get('/api/workspaces/:workspaceId/assets/:assetId', authenticate, read, async (req, res) => {
    const asset = await assetInWorkspace(String(req.params.workspaceId), String(req.params.assetId));
    const analysis = asset.analysisId ? await store.get<Analysis>('analyses', asset.analysisId) : null;
    res.json({ asset: publicAsset(asset), analysis, job: await latestJob(asset.workspaceId, asset.id) });
});
app.get('/api/workspaces/:workspaceId/assets/:assetId/:kind', authenticate, read, async (req, res, next) => {
    if (!['content', 'thumbnail'].includes(String(req.params.kind)))
        return next();
    const asset = await assetInWorkspace(String(req.params.workspaceId), String(req.params.assetId));
    const key = req.params.kind === 'thumbnail' ? asset.thumbnailKey : asset.storageKey;
    if (!key)
        throw new HttpError(404, 'This preview is not available yet.');
    const location = await mediaLocation(key);
    res.set('Cache-Control', 'private, no-store');
    if (location.url)
        res.redirect(302, location.url);
    else
        res.type(req.params.kind === 'thumbnail' ? 'image/jpeg' : asset.mimeType).sendFile(location.path!, { dotfiles: 'allow' });
});
app.post('/api/workspaces/:workspaceId/assets/:assetId/analyze', authenticate, edit, async (req, res) => {
    const asset = await assetInWorkspace(String(req.params.workspaceId), String(req.params.assetId));
    const previous = await latestJob(asset.workspaceId, asset.id);
    if (previous && ['queued', 'processing'].includes(previous.status))
        throw new HttpError(409, 'This video is already being processed.');
    if (!process.env.GEMINI_API_KEY)
        throw new HttpError(503, 'Add GEMINI_API_KEY to the server environment and restart the media worker to enable analysis.', 'CONFIGURATION_REQUIRED');
    const job = newJob(asset.workspaceId, asset.id, 'video_analysis');
    await store.enqueueMedia(asset, job, false);
    res.status(202).json({ job });
});
app.delete('/api/workspaces/:workspaceId/assets/:assetId', authenticate, edit, async (req, res) => {
    const asset = await assetInWorkspace(String(req.params.workspaceId), String(req.params.assetId));
    const jobs = (await store.list<StoredJob>('jobs', 'workspaceId', asset.workspaceId)).filter(j => j.assetId === asset.id);
    if (jobs.some(j => ['queued', 'processing'].includes(j.status)))
        throw new HttpError(409, 'Wait for processing to finish before deleting this video.');
    const deletion = await store.beginAssetDeletion(asset.workspaceId, asset.id);
    const analyses = (await store.list<Analysis>('analyses', 'workspaceId', asset.workspaceId)).filter(a => a.assetId === asset.id);
    await deleteFile(asset.storageKey);
    if (asset.thumbnailKey)
        await deleteFile(asset.thumbnailKey);
    const operations = [...jobs.map(j => ({ collection: 'jobs', id: j.id })), ...analyses.map(a => ({ collection: 'analyses', id: a.id }))];
    for (let index = 0; index < operations.length; index += 400)
        await store.batch(operations.slice(index, index + 400));
    await store.finishAssetDeletion(asset.workspaceId, asset.id, deletion.token);
    await audit(asset.workspaceId, req.user!.id, 'asset.deleted', asset.id);
    res.json({ success: true });
});
app.get('/api/workspaces/:workspaceId/jobs', authenticate, read, async (req, res) => res.json(await store.list('jobs', 'workspaceId', String(req.params.workspaceId))));
app.get('/api/workspaces/:workspaceId/providers', authenticate, read, async (_req, res) => res.json(await getProviderStatuses()));
app.get('/api/workspaces/:workspaceId/export', authenticate, admin, async (req, res) => {
    const workspaceId = String(req.params.workspaceId), workspace = await store.get<StoredWorkspace>('workspaces', workspaceId);
    const data: any = { exportedAt: new Date().toISOString(), schemaVersion: 1, workspace: workspace && publicWorkspace(workspace) };
    for (const collection of ['memberships', 'assets', 'analyses', 'jobs', 'auditLogs', 'usage', 'socialConnections', 'socialPosts', 'analyticsSnapshots', 'analyticsSnapshotParts', 'channelImports', 'channelAudits'])
        data[collection] = await store.list<any>(collection, 'workspaceId', workspaceId);
    data.assets = data.assets.map(publicAsset);
    res.set('Content-Disposition', `attachment; filename="creatorflow-${workspaceId}.json"`);
    res.json(data);
});
app.delete('/api/workspaces/:workspaceId', authenticate, workspaceAccess(['owner']), async (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    const { confirmation } = z.object({ confirmation: z.string() }).parse(req.body);
    await store.mutate<StoredWorkspace>('workspaces', workspaceId, current => {
        if (!current)
            throw new HttpError(404, 'Workspace not found.');
        if (confirmation !== current.name)
            throw new HttpError(400, 'Type the workspace name exactly to confirm deletion.', 'CONFIRMATION_REQUIRED');
        if (current.activeJobCount > 0)
            throw new HttpError(409, 'Wait for active media jobs to finish before deleting this workspace.');
        return { ...current, deleting: true };
    });
    for (const connection of await store.list<any>('socialConnections', 'workspaceId', workspaceId)) {
        if (connection.source === 'oauth' && connection.provider === 'youtube' && !connection.disconnectedAt) await revokeYouTubeConnection(connection.id, workspaceId).catch(() => {});
    }
    const assets = await store.list<StoredAsset>('assets', 'workspaceId', workspaceId);
    for (const asset of assets) {
        await deleteFile(asset.storageKey);
        if (asset.thumbnailKey)
            await deleteFile(asset.thumbnailKey);
    }
    const deletes: {
        collection: string;
        id: string;
    }[] = [];
    for (const collection of ['memberships', 'assets', 'analyses', 'jobs', 'auditLogs', 'usage', 'assetDigests', 'assetDeletions', 'socialConnections', 'socialPosts', 'analyticsSnapshots', 'analyticsSnapshotParts', 'channelImports', 'channelAudits', 'channelAuditInputs', 'channelSecrets', 'channelOAuthStates'])
        for (const record of await store.list<any>(collection, 'workspaceId', workspaceId))
            deletes.push({ collection, id: record.id });
    for (let index = 0; index < deletes.length; index += 400)
        await store.batch(deletes.slice(index, index + 400));
    await store.remove('workspaces', workspaceId);
    res.json({ success: true });
});
app.get('/api/account/export', authenticate, async (req, res) => {
    const memberships = await store.list('memberships', 'userId', req.user!.id);
    res.set('Content-Disposition', 'attachment; filename="creatorflow-account.json"');
    res.json({ schemaVersion: 1, exportedAt: new Date().toISOString(), user: req.user, memberships });
});
app.delete('/api/account', authenticate, async (req, res) => {
    const { confirmation, password, idToken } = z.object({ confirmation: z.string(), password: z.string().optional(), idToken: z.string().optional() }).parse(req.body);
    if (confirmation !== req.user!.email)
        throw new HttpError(400, 'Type your email exactly to confirm account deletion.', 'CONFIRMATION_REQUIRED');
    const memberships = await store.list<any>('memberships', 'userId', req.user!.id);
    if (memberships.some(m => m.role === 'owner'))
        throw new HttpError(409, 'Delete or transfer your owned workspaces before deleting your account.', 'OWNED_WORKSPACES');
    if (config.mode === 'local') {
        const credentials = await store.get<any>('credentials', credentialId(req.user!.email));
        if (!password || !credentials || !await verifyPassword(password, credentials.passwordHash))
            throw new HttpError(401, 'Enter your password to confirm account deletion.', 'REAUTHENTICATION_REQUIRED');
    }
    else {
        if (!idToken)
            throw new HttpError(401, 'Sign in again to confirm account deletion.', 'REAUTHENTICATION_REQUIRED');
        try {
            const token = await getAuth().verifyIdToken(idToken, true);
            if (token.uid !== req.user!.id || Date.now() / 1000 - token.auth_time > 300)
                throw new Error('Recent authentication required.');
        }
        catch {
            throw new HttpError(401, 'Sign in again to confirm account deletion.', 'REAUTHENTICATION_REQUIRED');
        }
    }
    await store.mutate<any>('users', req.user!.id, current => { if (!current)
        throw new HttpError(404, 'Account not found.'); if (current.activeWorkspaceCreates)
        throw new HttpError(409, 'Wait for workspace creation to finish before deleting your account.'); return { ...current, deleting: true }; });
    const currentMemberships = await store.list<any>('memberships', 'userId', req.user!.id);
    if (currentMemberships.some(m => m.role === 'owner')) {
        await store.mutate<any>('users', req.user!.id, current => ({ ...current!, deleting: false }));
        throw new HttpError(409, 'Delete or transfer your owned workspaces before deleting your account.', 'OWNED_WORKSPACES');
    }
    if (config.mode === 'firebase')
        await getAuth().deleteUser(req.user!.id);
    else {
        for (const session of await store.list<any>('sessions', 'userId', req.user!.id))
            await store.remove('sessions', session.id);
        await store.remove('credentials', credentialId(req.user!.email));
    }
    await store.batch([...memberships.map(m => ({ collection: 'memberships', id: m.id })), { collection: 'users', id: req.user!.id }]);
    await deleteSession(req, res);
    res.json({ success: true });
});
const dist = path.resolve('dist');
if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false }));
    app.get('/{*path}', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(dist, 'index.html')));
}
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'This API route does not exist.', 'NOT_FOUND')));
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error?.type === 'entity.parse.failed')
        return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body must contain valid JSON.' } });
    if (error?.type === 'entity.too.large')
        return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'This request exceeds the allowed size.' } });
    if (error instanceof ZodError)
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: error.issues.map(i => `${i.path.join('.') || 'Input'}: ${i.message}`).join('; ') } });
    if (error instanceof multer.MulterError)
        return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: { code: error.code, message: error.code === 'LIMIT_FILE_SIZE' ? `Video exceeds the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB upload limit.` : 'The upload could not be accepted.' } });
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500)
        console.error('Request failed:', error?.code || error?.name || 'Error');
    res.status(status).json({ error: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR', message: safeError(error) } });
});
