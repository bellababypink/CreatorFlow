import { mkdir, copyFile, unlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getStorage } from 'firebase-admin/storage';
import { config } from './config.js';
const root = path.join(config.dataDir, 'media');
function localPath(key: string) { const full = path.resolve(root, key); if (!full.startsWith(root + path.sep))
    throw new Error('Invalid storage key.'); return full; }
export async function putFile(key: string, sourcePath: string, contentType: string) {
    if (config.mode === 'firebase') {
        await getStorage().bucket(config.bucket).upload(sourcePath, { destination: key, resumable: true, metadata: { contentType, cacheControl: 'private, no-store' } });
    }
    else {
        const dest = localPath(key);
        await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await copyFile(sourcePath, dest);
    }
}
export async function materializeFile(key: string, workingPath: string) {
    if (config.mode === 'local')
        return localPath(key);
    await mkdir(path.dirname(workingPath), { recursive: true, mode: 0o700 });
    await getStorage().bucket(config.bucket).file(key).download({ destination: workingPath });
    return workingPath;
}
export async function mediaLocation(key: string) {
    if (config.mode === 'local')
        return { path: localPath(key) };
    const [url] = await getStorage().bucket(config.bucket).file(key).getSignedUrl({ action: 'read', expires: Date.now() + 5 * 60 * 1000 });
    return { url };
}
export async function deleteFile(key: string) { if (config.mode === 'firebase')
    await getStorage().bucket(config.bucket).file(key).delete({ ignoreNotFound: true });
else
    await rm(localPath(key), { force: true }); }
export async function cleanupTemporary(filePath: string) { await unlink(filePath).catch(() => { }); }
