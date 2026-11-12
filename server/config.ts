import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
try {
    loadEnvFile();
}
catch (error: any) {
    if (error.code !== 'ENOENT')
        throw error;
}
const mode = process.env.APP_MODE === 'firebase' ? 'firebase' : 'local';
if (process.env.APP_MODE && !['local', 'firebase'].includes(process.env.APP_MODE))
    throw new Error('APP_MODE must be local or firebase.');
if (mode === 'local' && process.env.NODE_ENV === 'production') {
    throw new Error('Local accounts are disabled in production. Configure APP_MODE=firebase.');
}
export const config = {
    mode,
    port: Number(process.env.PORT || 3001),
    origin: process.env.APP_ORIGIN || 'http://localhost:5173',
    dataDir: path.resolve(process.env.CF_DATA_DIR || '.data'),
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024),
    maxDurationSeconds: Number(process.env.MAX_VIDEO_DURATION_SECONDS || 600),
    storageQuotaBytes: Number(process.env.WORKSPACE_STORAGE_QUOTA_BYTES || 1024 * 1024 * 1024),
    maxActiveJobs: Number(process.env.WORKSPACE_MAX_ACTIVE_JOBS || 3),
    bucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    firebaseConfig: {
        apiKey: process.env.FIREBASE_WEB_API_KEY || '',
        authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
        projectId: process.env.FIREBASE_PROJECT_ID || '',
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
        appId: process.env.FIREBASE_APP_ID || '',
    },
};
for (const key of ['port', 'maxUploadBytes', 'maxDurationSeconds', 'storageQuotaBytes', 'maxActiveJobs'] as const)
    if (!Number.isFinite(config[key]) || config[key] <= 0)
        throw new Error(`${key} must be a positive finite number.`);
if (config.mode === 'firebase' && (!config.firebaseConfig.apiKey || !config.firebaseConfig.authDomain || !config.firebaseConfig.projectId || !config.bucket || !config.firebaseConfig.appId))
    throw new Error('Firebase mode requires FIREBASE_WEB_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, FIREBASE_STORAGE_BUCKET, and FIREBASE_APP_ID.');
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true, mode: 0o700 });
