import { createHash } from 'node:crypto';
import { z } from 'zod';
import { store } from '../store.js';
import { HttpError } from '../errors.js';
import type { StoredJob, StoredWorkspace } from '../models.js';
import type { ChannelAudit, ChannelConnection, ChannelFilters, ChannelOverview, ChannelPost, ChannelSnapshot } from '../../shared/channels.js';
import { buildChannelOverview } from './analytics.js';
import { auditEligibility } from './audits.js';
import { hydrateSnapshots, type SnapshotPart } from './snapshots.js';

export const filtersSchema = z.object({
  startDate: z.iso.date().optional(), endDate: z.iso.date().optional(),
  platform: z.enum(['youtube', 'instagram', 'tiktok']).optional(),
  connectionId: z.string().min(1).max(160).optional(),
  contentType: z.enum(['video','short','reel','tiktok','image','carousel','unknown']).optional(),
  pillar: z.string().trim().min(1).max(100).optional(),
}).strict().refine(f => !f.startDate || !f.endDate || f.startDate <= f.endDate, 'Start date must precede end date.');

export async function channelConnection(workspaceId: string, connectionId: string): Promise<ChannelConnection> {
  const connection = await store.get<ChannelConnection>('socialConnections', connectionId);
  if (!connection || connection.workspaceId !== workspaceId) throw new HttpError(404, 'Channel account not found.', 'CHANNEL_NOT_FOUND');
  return connection;
}

export async function captureOverview(workspaceId: string, filters: ChannelFilters = {}): Promise<{ overview: ChannelOverview; connections: ChannelConnection[]; workspace: StoredWorkspace; revision: number }> {
  if (filters.connectionId) await channelConnection(workspaceId, filters.connectionId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const workspace = await store.get<StoredWorkspace>('workspaces', workspaceId);
    if (!workspace || workspace.deleting) throw new HttpError(409, 'This workspace is unavailable.');
    const [posts, snapshots, connections, parts] = await Promise.all([
      store.list<ChannelPost>('socialPosts', 'workspaceId', workspaceId),
      store.list<ChannelSnapshot>('analyticsSnapshots', 'workspaceId', workspaceId),
      store.list<ChannelConnection>('socialConnections', 'workspaceId', workspaceId),
      store.list<SnapshotPart>('analyticsSnapshotParts','workspaceId',workspaceId),
    ]);
    const revision = workspace.channelRevision || 0;
    const after = await store.get<StoredWorkspace>('workspaces', workspaceId);
    if (after && !after.deleting && (after.channelRevision || 0) === revision) return { overview: buildChannelOverview(posts, hydrateSnapshots(snapshots,parts), connections, filters, workspace), connections, workspace, revision };
  }
  throw new HttpError(409, 'Channel data changed while loading. Please refresh.', 'CHANNEL_DATA_CHANGED');
}

export function channelJob(workspaceId: string, type: 'channel_sync' | 'channel_audit', input: { connectionId?: string; filters?: ChannelFilters }): StoredJob {
  const key = type === 'channel_sync' ? input.connectionId! : createHash('sha256').update(JSON.stringify(input.filters || {})).digest('hex').slice(0, 24);
  const timestamp = new Date().toISOString();
  return { id: `${type}_${workspaceId}_${key}`, workspaceId, assetId: `channel:${key}`, ...input, type, status: 'queued', progress: 0,
    stage: type === 'channel_sync' ? 'Waiting to synchronize YouTube' : 'Waiting for channel audit', attempts: 0, maxAttempts: 3,
    error: null, outputId: null, createdAt: timestamp, updatedAt: timestamp, version: 1, slotReserved: true };
}

export function assertAuditReady(overview: ChannelOverview) {
  if (!overview.posts.length) throw new HttpError(422, 'Connect and synchronize a channel, or import analytics, before requesting an audit.', 'NO_CHANNEL_DATA');
  if (!process.env.GEMINI_API_KEY) throw new HttpError(503, 'Configure a server-side GEMINI_API_KEY to generate a genuine channel audit. The evidence report is available without AI.', 'CONFIGURATION_REQUIRED');
  const eligibility=auditEligibility(overview);
  if(!eligibility.eligible)throw new HttpError(403,eligibility.reason!,'DEVELOPER_APPROVAL_REQUIRED');
  if (overview.posts.some(p => p.source !== 'manual_import' && p.provider === 'youtube') && process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED !== 'true') {
    throw new HttpError(403, 'Generative inference over YouTube API data requires developer approval. Raw channel analytics and the descriptive evidence report remain available.', 'DEVELOPER_APPROVAL_REQUIRED');
  }
}

export function sameFilters(a: ChannelFilters, b: ChannelFilters): boolean {
  return ['startDate','endDate','platform','connectionId','contentType','pillar'].every(k => a[k as keyof ChannelFilters] === b[k as keyof ChannelFilters]);
}
export async function getChannelAudit(workspaceId: string, auditId: string): Promise<ChannelAudit> {
  const audit = await store.get<ChannelAudit>('channelAudits', auditId);
  if (!audit || audit.workspaceId !== workspaceId) throw new HttpError(404, 'Channel audit not found.');
  return audit;
}
