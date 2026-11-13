import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CodeChallengeMethod } from 'google-auth-library';
import type { ChannelConnection } from '../../shared/channels.js';
import { store } from '../store.js';
import { HttpError } from '../errors.js';
import { encryptYouTubeTokens, decryptYouTubeTokens, type EncryptedChannelSecret, type YouTubeTokens } from './token-vault.js';
import { authorizedYouTubeProfile, getYouTubeIntegration, googleOAuthClient, googleYouTubeTransport, providerFailure, stableYouTubeId, YouTubeProviderError, YOUTUBE_SCOPES, youtubeOAuthConfig, type YouTubeTransport } from './youtube.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface OAuthState {
  id: string; workspaceId: string; userId: string; browserHash: string;
  verifier: EncryptedChannelSecret; status: 'pending' | 'consumed'; expiresAt: string;
  createdAt: string; usedAt?: string;
}
type SecretRecord = EncryptedChannelSecret & { revoked?: boolean };
type StoredConnection = ChannelConnection & { purgeOwner?: string | null; purgeUntil?: string | null };

async function canManage(workspaceId: string, userId: string) {
  const workspace = await store.get<any>('workspaces', workspaceId);
  const membership = await store.get<any>('memberships', `${workspaceId}_${userId}`);
  if (!workspace || workspace.deleting || !membership || !['owner', 'administrator'].includes(membership.role)) throw new HttpError(403, 'Only a workspace owner or administrator can authorize channels.', 'FORBIDDEN');
}

export async function beginYouTubeAuthorization(input: { workspaceId: string; userId: string; browserNonce: string }): Promise<{ url: string; state: string }> {
  await canManage(input.workspaceId, input.userId);
  const integration = getYouTubeIntegration();
  if (!integration.canConnect) throw new HttpError(503, integration.message, integration.status === 'Requires Developer Approval' ? 'DEVELOPER_APPROVAL_REQUIRED' : 'CONFIGURATION_REQUIRED');
  if (input.browserNonce.length < 24 || input.browserNonce.length > 256) throw new HttpError(400, 'A valid browser authorization nonce is required.', 'INVALID_OAUTH_STATE');
  const client = googleOAuthClient();
  const pending = (await store.list<OAuthState>('channelOAuthStates', 'workspaceId', input.workspaceId)).filter(s => s.userId === input.userId && s.status === 'pending' && Date.parse(s.expiresAt) > Date.now());
  if (pending.length >= 5) throw new HttpError(429, 'Several YouTube authorization requests are already open. Finish one or wait ten minutes before trying again.', 'OAUTH_REQUEST_LIMIT');
  const codes = await client.generateCodeVerifierAsync();
  const state = randomBytes(32).toString('base64url');
  const id = hash(state); const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const record: OAuthState = { id, workspaceId: input.workspaceId, userId: input.userId, browserHash: hash(input.browserNonce), verifier: await encryptYouTubeTokens({ accessToken: codes.codeVerifier, expiresAt, grantedScopes: [] }, input.workspaceId, `oauth_${id}`, 1), status: 'pending', expiresAt, createdAt: new Date().toISOString() };
  await store.commitChannelWrites(input.workspaceId, null, null, [{ collection: 'channelOAuthStates', value: record }]);
  return { state, url: client.generateAuthUrl({ access_type: 'offline', scope: YOUTUBE_SCOPES, include_granted_scopes: true, prompt: 'consent select_account', state, code_challenge: codes.codeChallenge, code_challenge_method: CodeChallengeMethod.S256 }) };
}

async function consumeState(input: { state: string; userId: string; browserNonce: string }): Promise<OAuthState> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw new HttpError(400, 'This authorization request is invalid or expired. Start a new connection.', 'INVALID_OAUTH_STATE');
  const id = hash(input.state);
  const current = await store.get<OAuthState>('channelOAuthStates', id);
  if (!current || current.userId !== input.userId || current.browserHash !== hash(input.browserNonce)) throw new HttpError(403, 'This authorization does not belong to this browser and signed-in account.', 'INVALID_OAUTH_STATE');
  await canManage(current.workspaceId, input.userId);
  return store.mutate<OAuthState>('channelOAuthStates', id, existing => {
    if (!existing || existing.userId !== input.userId || existing.browserHash !== hash(input.browserNonce) || existing.status !== 'pending' || Date.parse(existing.expiresAt) <= Date.now()) throw new HttpError(400, 'This authorization request was already used or expired. Start a new connection.', 'INVALID_OAUTH_STATE');
    return { ...existing, status: 'consumed', usedAt: new Date().toISOString() };
  });
}

async function validatedTokens(credentials: Awaited<ReturnType<YouTubeTransport['exchange']>>, transport: YouTubeTransport, refreshToken?: string): Promise<YouTubeTokens> {
  if (!credentials.access_token) throw new HttpError(502, 'Google did not return an access token.', 'INVALID_PROVIDER_RESPONSE');
  const info = await transport.inspect(credentials.access_token);
  if (info.audience !== youtubeOAuthConfig().clientId || !Array.isArray(info.scopes) || info.scopes.some(s => typeof s !== 'string') || !Number.isFinite(info.expiresAt) || info.expiresAt <= Date.now()) throw new HttpError(403, 'Google returned a token for a different application or an expired grant.', 'INVALID_PROVIDER_RESPONSE');
  const grantedScopes = [...new Set(info.scopes)];
  if (!grantedScopes.includes(YOUTUBE_SCOPES[0])) throw new HttpError(403, 'The read-only YouTube channel permission was not granted. Reconnect and approve it to continue.', 'PERMISSION_REQUIRED');
  return { accessToken: credentials.access_token, ...(credentials.refresh_token || refreshToken ? { refreshToken: credentials.refresh_token || refreshToken } : {}), expiresAt: new Date(Math.min(credentials.expiry_date || info.expiresAt, info.expiresAt)).toISOString(), grantedScopes };
}

/** The callback validates browser, user, current role and single-use state before exchanging a code. */
export async function completeYouTubeAuthorization(input: { state: string; code?: string; error?: string; userId: string; browserNonce: string }, transport = googleYouTubeTransport): Promise<ChannelConnection> {
  const state = await consumeState(input);
  let issuedToken: string | undefined; let committed = false; let candidateConnectionId: string | undefined;
  try {
    if (input.error) throw new HttpError(400, 'Google authorization was declined or not completed. No channel was connected.', 'OAUTH_DECLINED');
    if (!input.code || input.code.length > 4096) throw new HttpError(400, 'Google did not return a valid authorization code.', 'INVALID_OAUTH_CODE');
    const verifier = await decryptYouTubeTokens(state.verifier, state.workspaceId, `oauth_${state.id}`, 1);
    const credentials = await transport.exchange(input.code, verifier.accessToken); issuedToken = credentials.access_token || undefined;
    let tokens = await validatedTokens(credentials, transport);
    const profile = await authorizedYouTubeProfile(tokens.accessToken, transport);
    const id = stableYouTubeId(state.workspaceId, profile.id, 'connection');
    candidateConnectionId = id;
    const previous = await store.get<StoredConnection>('socialConnections', id);
    if (previous && (previous.workspaceId !== state.workspaceId || previous.provider !== 'youtube' || previous.source !== 'oauth')) throw new HttpError(409, 'This connection record cannot be reused.', 'CONNECTION_CONFLICT');
    if (previous?.purgeOwner) throw new HttpError(409, 'The prior connection is still removing its authorized data. Retry disconnect to finish cleanup, then connect again.', 'CHANNEL_CLEANUP_PENDING');
    if (!tokens.refreshToken && previous && !previous.disconnectedAt) {
      const saved = await store.get<SecretRecord>('channelSecrets', id);
      if (saved && !saved.revoked) {
        const old = await decryptYouTubeTokens(saved, state.workspaceId, id, previous.generation);
        if (old.refreshToken) tokens = { ...tokens, refreshToken: old.refreshToken };
      }
    }
    const generation = (previous?.generation || 0) + 1; const now = new Date().toISOString();
    const missingScopes = YOUTUBE_SCOPES.filter(scope => !tokens.grantedScopes.includes(scope));
    const connection: ChannelConnection = { id, workspaceId: state.workspaceId, provider: 'youtube', source: 'oauth', providerAccountId: profile.id, accountName: profile.snippet!.title!, accountUrl: `https://www.youtube.com/channel/${encodeURIComponent(profile.id)}`, status: missingScopes.length || !tokens.refreshToken ? 'Needs Permission' : 'Connected', grantedScopes: tokens.grantedScopes, missingScopes, lastSyncedAt: previous?.lastSyncedAt || null, lastError: missingScopes.length ? 'YouTube Analytics permission was not granted. Authorized metadata can still be synchronized.' : !tokens.refreshToken ? 'Google did not grant renewable offline access. Reconnect with consent to enable token refresh.' : null, availableMetrics: previous?.availableMetrics || [], disconnectedAt: null, generation, createdAt: previous?.createdAt || now, updatedAt: now, version: (previous?.version || 0) + 1 };
    const encrypted = await encryptYouTubeTokens(tokens, connection.workspaceId, id, generation);
    await canManage(state.workspaceId, input.userId);
    await store.commitChannelWrites(connection.workspaceId, id, previous?.generation || 0, [{ collection: 'socialConnections', value: connection }, { collection: 'channelSecrets', value: encrypted }]);
    committed = true;
    return connection;
  } catch (error) {
    throw providerFailure(error);
  } finally {
    // A code verifier is a short-lived secret; scrub it immediately after use.
    await store.remove('channelOAuthStates', state.id).catch(() => {});
    if (issuedToken && !committed) {
      const active = candidateConnectionId ? await store.get<StoredConnection>('socialConnections', candidateConnectionId).catch(() => null) : null;
      // Google revocation can affect the application's whole account grant.
      // A lost callback race must not revoke a newer, successful connection.
      if (!active || active.disconnectedAt) await transport.revoke(issuedToken).catch(() => {});
    }
  }
}

async function connectionInWorkspace(connectionId: string, workspaceId: string): Promise<ChannelConnection> {
  const connection = await store.get<ChannelConnection>('socialConnections', connectionId);
  if (!connection || connection.workspaceId !== workspaceId || connection.provider !== 'youtube' || connection.source !== 'oauth') throw new HttpError(404, 'YouTube connection not found.', 'NOT_FOUND');
  return connection;
}

async function redactSecret(connectionId: string, workspaceId: string, generation: number) {
  const prior = await store.get<SecretRecord>('channelSecrets', connectionId);
  if (!prior || prior.workspaceId !== workspaceId || prior.generation !== generation) return;
  await store.mutate<SecretRecord>('channelSecrets', connectionId, current => {
    if (current && (current.workspaceId !== workspaceId || current.generation !== generation)) return current;
    return { id: connectionId, workspaceId, generation, algorithm: 'aes-256-gcm', ciphertext: '', iv: '', tag: '', updatedAt: new Date().toISOString(), revoked: true };
  });
}

async function invalidate(connection: ChannelConnection, message: string) {
  const owner = randomUUID();
  const invalidated = await store.mutate<StoredConnection>('socialConnections', connection.id, current => {
    if (!current || current.workspaceId !== connection.workspaceId) throw new HttpError(404, 'YouTube connection not found.');
    if (current.generation !== connection.generation || current.disconnectedAt && !current.purgeOwner || current.purgeOwner && Date.parse(current.purgeUntil || '') > Date.now()) return current;
    return { ...current, generation: current.generation + 1, status: 'Needs Permission', disconnectedAt: new Date().toISOString(), lastError: message, grantedScopes: [], missingScopes: YOUTUBE_SCOPES,
      accountName: 'Disconnected YouTube account', providerAccountId: '', accountUrl: undefined, lastSyncedAt: null, availableMetrics: [],
      purgeOwner: owner, purgeUntil: new Date(Date.now() + 5 * 60_000).toISOString(), updatedAt: new Date().toISOString(), version: current.version + 1 };
  });
  // An old refresh failure must never erase data belonging to a new grant.
  if (invalidated.purgeOwner !== owner) return false;
  await redactSecret(connection.id, connection.workspaceId, connection.generation);
  const { purgeChannelData } = await import('./lifecycle.js');
  await purgeChannelData(connection.workspaceId, connection.id);
  await store.mutate<StoredConnection>('socialConnections', connection.id, current => {
    if (!current || current.workspaceId !== connection.workspaceId) throw new HttpError(404, 'YouTube connection not found.');
    return current.purgeOwner === owner ? { ...current, purgeOwner: null, purgeUntil: null } : current;
  });
  return true;
}

/** Invalidated tokens are scrubbed before network revocation, fencing any in-flight synchronization. */
export async function revokeYouTubeConnection(connectionId: string, workspaceId: string, transport = googleYouTubeTransport): Promise<void> {
  const connection = await connectionInWorkspace(connectionId, workspaceId);
  let revokeToken: string | undefined; let decryptionFailed = false;
  const secret = await store.get<SecretRecord>('channelSecrets', connection.id);
  if (secret && !secret.revoked && secret.generation === connection.generation) {
    try { const tokens = await decryptYouTubeTokens(secret, workspaceId, connectionId, connection.generation); revokeToken = tokens.refreshToken || tokens.accessToken; }
    catch { decryptionFailed = true; }
  }
  let removed = false; let cleanupFailed = false;
  try {
    removed = await invalidate(connection, 'Disconnected from CreatorFlow. Connect again to authorize future synchronization.');
  } catch (error) {
    const current = await store.get<StoredConnection>('socialConnections', connection.id).catch(() => null);
    // The cleanup marker blocks reconnection, so the already captured token
    // still belongs to the grant that this disconnect disabled.
    if (!current || current.generation !== connection.generation + 1 || !current.disconnectedAt || !current.purgeOwner) throw error;
    removed = true; cleanupFailed = true;
  }
  if (!removed && !connection.disconnectedAt) throw new HttpError(409, 'The channel authorization changed during disconnect. Reload before trying again.', 'AUTHORIZATION_CHANGED');
  if (!removed && (connection as StoredConnection).purgeOwner) throw new HttpError(409, 'Channel data cleanup is already in progress. Retry after its lease expires if it does not finish.', 'CHANNEL_CLEANUP_PENDING');
  if (revokeToken) {
    try { await transport.revoke(revokeToken); }
    catch (error) {
      const failure = providerFailure(error);
      // invalid_grant/invalid_token means Google no longer accepts the token.
      if (failure.code !== 'AUTHORIZATION_REVOKED') throw new HttpError(503, 'CreatorFlow removed the local grant and authorized channel data, but Google revocation could not be confirmed. Remove CreatorFlow from your Google account permissions to finish revocation.', 'REVOCATION_UNCONFIRMED');
    }
  } else if (decryptionFailed || !connection.disconnectedAt && !revokeToken) throw new HttpError(503, 'CreatorFlow disabled the local connection, but no readable credential was available to confirm Google revocation. Remove the app in Google account permissions.', 'REVOCATION_UNCONFIRMED');
  if (cleanupFailed) throw new HttpError(503, 'The local authorization was disabled and Google revocation was requested, but cached channel-data cleanup did not finish. Retry disconnect after the cleanup lease expires.', 'CHANNEL_CLEANUP_PENDING');
}

export async function refreshYouTubeConnection(connectionId: string, workspaceId: string, transport = googleYouTubeTransport): Promise<void> {
  const connection = await connectionInWorkspace(connectionId, workspaceId);
  if (connection.disconnectedAt) throw new HttpError(409, 'This YouTube channel is disconnected. Connect it again.', 'PERMISSION_REQUIRED');
  const secret = await store.get<SecretRecord>('channelSecrets', connectionId);
  if (!secret || secret.revoked) throw new HttpError(409, 'This channel has no renewable authorization. Connect it again.', 'PERMISSION_REQUIRED');
  const owner = randomUUID();
  const leased = await store.mutate<SecretRecord>('channelSecrets', connectionId, current => {
    if (!current || current.revoked || current.workspaceId !== workspaceId || current.generation !== connection.generation) throw new HttpError(409, 'The YouTube authorization changed. Retry with the current connection.', 'AUTHORIZATION_CHANGED');
    if (current.refreshOwner && Date.parse(current.refreshUntil || '') > Date.now()) throw new HttpError(409, 'Another worker is refreshing this channel. Try again shortly.', 'REFRESH_IN_PROGRESS');
    return { ...current, refreshOwner: owner, refreshUntil: new Date(Date.now() + 60_000).toISOString() };
  });
  try {
    const old = await decryptYouTubeTokens(leased, workspaceId, connectionId, connection.generation);
    if (!old.refreshToken) throw new HttpError(409, 'Google did not grant renewable offline access. Reconnect this channel.', 'PERMISSION_REQUIRED');
    const credentials = await transport.refresh(old.refreshToken);
    const refreshed = await validatedTokens(credentials, transport, old.refreshToken);
    const encrypted = await encryptYouTubeTokens(refreshed, workspaceId, connectionId, connection.generation);
    await store.mutate<SecretRecord>('channelSecrets', connectionId, current => {
      if (!current || current.revoked || current.generation !== connection.generation || current.workspaceId !== workspaceId || current.refreshOwner !== owner) throw new HttpError(409, 'The YouTube authorization changed during refresh.', 'AUTHORIZATION_CHANGED');
      return encrypted;
    });
    await store.mutate<ChannelConnection>('socialConnections', connectionId, current => {
      if (!current || current.workspaceId !== workspaceId || current.generation !== connection.generation || current.disconnectedAt) throw new HttpError(409, 'The YouTube authorization changed during refresh.', 'AUTHORIZATION_CHANGED');
      const missingScopes = YOUTUBE_SCOPES.filter(scope => !refreshed.grantedScopes.includes(scope));
      return { ...current, grantedScopes: refreshed.grantedScopes, missingScopes, status: missingScopes.length ? 'Needs Permission' : 'Connected', lastError: missingScopes.length ? 'YouTube Analytics permission is missing from the renewed grant.' : null, updatedAt: new Date().toISOString(), version: current.version + 1 };
    });
  } catch (error) {
    const failure = providerFailure(error);
    if (failure.code === 'AUTHORIZATION_REVOKED') await invalidate(connection, 'Google revoked or expired this authorization. Reconnect to authorize future access.');
    throw failure;
  } finally {
    const current = await store.get<SecretRecord>('channelSecrets', connectionId);
    if (current?.refreshOwner === owner) await store.mutate<SecretRecord>('channelSecrets', connectionId, value => value && value.refreshOwner === owner ? { ...value, refreshOwner: null, refreshUntil: null } : value!);
  }
}

async function access(connection: ChannelConnection, transport: YouTubeTransport, forceRefresh = false): Promise<YouTubeTokens> {
  const current = await connectionInWorkspace(connection.id, connection.workspaceId);
  if (current.disconnectedAt || current.generation !== connection.generation) throw new HttpError(409, 'This authorization changed. Reload the channel connection.', 'AUTHORIZATION_CHANGED');
  let secret = await store.get<SecretRecord>('channelSecrets', connection.id);
  if (!secret || secret.revoked) throw new HttpError(409, 'Reconnect this channel to grant access.', 'PERMISSION_REQUIRED');
  let tokens = await decryptYouTubeTokens(secret, connection.workspaceId, connection.id, connection.generation);
  if (forceRefresh || Date.parse(tokens.expiresAt) < Date.now() + 60_000) {
    await refreshYouTubeConnection(connection.id, connection.workspaceId, transport);
    secret = await store.get<SecretRecord>('channelSecrets', connection.id);
    if (!secret || secret.revoked) throw new HttpError(409, 'Reconnect this channel to grant access.', 'PERMISSION_REQUIRED');
    tokens = await decryptYouTubeTokens(secret, connection.workspaceId, connection.id, connection.generation);
  }
  return tokens;
}

export async function withYouTubeAccess<T>(connection: ChannelConnection, operation: (token: string) => Promise<T>, transport = googleYouTubeTransport): Promise<T> {
  let tokens = await access(connection, transport);
  try { return await operation(tokens.accessToken); }
  catch (error) {
    if (!(error instanceof YouTubeProviderError) || error.providerStatus !== 401) throw error;
    tokens = await access(connection, transport, true);
    try { return await operation(tokens.accessToken); }
    catch (retryError) {
      if (retryError instanceof YouTubeProviderError && retryError.providerStatus === 401) await invalidate(connection, 'Google no longer accepts this channel authorization. Reconnect the channel.');
      throw retryError;
    }
  }
}

export { getYouTubeIntegration } from './youtube.js';
export { purgeChannelData as purgeYouTubeData } from './lifecycle.js';
