import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

export interface YouTubeTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  grantedScopes: string[];
}
export interface EncryptedChannelSecret {
  id: string; workspaceId: string; generation: number;
  algorithm: 'aes-256-gcm'; ciphertext: string; iv: string; tag: string;
  updatedAt: string; refreshOwner?: string | null; refreshUntil?: string | null;
}

function configuredKey(): Buffer | null {
  const raw = process.env.CHANNEL_TOKEN_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) {
    throw new HttpError(503, 'CHANNEL_TOKEN_KEY must contain exactly 32 random bytes encoded as base64.', 'CONFIGURATION_REQUIRED');
  }
  return key;
}

export function tokenVaultConfigured(): boolean {
  try { return Boolean(configuredKey()) || config.mode === 'local' && process.env.NODE_ENV !== 'production'; }
  catch { return false; }
}

async function encryptionKey(): Promise<Buffer> {
  const configured = configuredKey();
  if (configured) return configured;
  if (config.mode !== 'local' || process.env.NODE_ENV === 'production') {
    throw new HttpError(503, 'Configure CHANNEL_TOKEN_KEY on the API and worker before connecting a channel.', 'CONFIGURATION_REQUIRED');
  }
  const keyPath = path.join(config.dataDir, 'channel-token.key');
  let key: Buffer;
  try {
    key = await readFile(keyPath);
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    // Publish only a fully written key. A worker must not read a zero-length
    // file while another process is creating the development key.
    const temporary = `${keyPath}.${randomBytes(12).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 });
      try { await link(temporary, keyPath); } catch (publish: any) { if (publish.code !== 'EEXIST') throw publish; }
    } finally { await unlink(temporary).catch(() => {}); }
    key = await readFile(keyPath);
  }
  if (key.length !== 32) throw new HttpError(503, 'The local channel encryption key is invalid. Restore the original key or reconnect after repairing the local key file.', 'CONFIGURATION_REQUIRED');
  return key;
}

function aad(workspaceId: string, connectionId: string, generation: number): Buffer {
  return Buffer.from(JSON.stringify({ workspaceId, connectionId, generation, format: 1 }));
}

export async function encryptYouTubeTokens(tokens: YouTubeTokens, workspaceId: string, connectionId: string, generation: number): Promise<EncryptedChannelSecret> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await encryptionKey(), iv);
  cipher.setAAD(aad(workspaceId, connectionId, generation));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return { id: connectionId, workspaceId, generation, algorithm: 'aes-256-gcm', ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), updatedAt: new Date().toISOString() };
}

export async function decryptYouTubeTokens(secret: EncryptedChannelSecret, workspaceId: string, connectionId: string, generation: number): Promise<YouTubeTokens> {
  if (secret.workspaceId !== workspaceId || secret.id !== connectionId || secret.generation !== generation || secret.algorithm !== 'aes-256-gcm') {
    throw new HttpError(403, 'This channel credential does not belong to this authorization.', 'CREDENTIAL_SCOPE_MISMATCH');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', await encryptionKey(), Buffer.from(secret.iv, 'base64'));
    decipher.setAAD(aad(workspaceId, connectionId, generation));
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
    const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken || typeof parsed.expiresAt !== 'string' || !Number.isFinite(Date.parse(parsed.expiresAt)) || !Array.isArray(parsed.grantedScopes) || parsed.grantedScopes.some((s: unknown) => typeof s !== 'string') || parsed.refreshToken !== undefined && typeof parsed.refreshToken !== 'string') throw new Error('Invalid token shape');
    return parsed as YouTubeTokens;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'The saved channel credential could not be decrypted. Restore CHANNEL_TOKEN_KEY or reconnect the channel.', 'CREDENTIAL_DECRYPTION_FAILED');
  }
}
