import { store } from '../store.js';
import type { ChannelAudit, ChannelPost, ChannelSnapshot } from '../../shared/channels.js';

/** Remove authorized channel records and every saved audit containing them. */
export async function purgeChannelData(workspaceId: string, connectionId: string): Promise<void> {
  const [posts, snapshots, audits, inputs, imports, parts] = await Promise.all([
    store.list<ChannelPost>('socialPosts', 'workspaceId', workspaceId),
    store.list<ChannelSnapshot>('analyticsSnapshots', 'workspaceId', workspaceId),
    store.list<ChannelAudit>('channelAudits', 'workspaceId', workspaceId),
    store.list<any>('channelAuditInputs', 'workspaceId', workspaceId),
    store.list<any>('channelImports', 'workspaceId', workspaceId),
    store.list<any>('analyticsSnapshotParts','workspaceId',workspaceId),
  ]);
  const removedPosts = posts.filter(p => p.connectionId === connectionId);
  const removedSnapshots = snapshots.filter(s => s.connectionId === connectionId);
  const postIds = new Set(removedPosts.map(p => p.id));
  const snapshotIds = new Set(removedSnapshots.map(s => s.id));
  const affected = new Set(inputs.filter(i => i.overview?.posts?.some((p: ChannelPost) => p.connectionId === connectionId) || i.overview?.snapshots?.some((s: ChannelSnapshot) => s.connectionId === connectionId)).map(i => i.id));
  for (const audit of audits) {
    if (audit.filters.connectionId === connectionId || audit.sourcePostIds.some(id => postIds.has(id)) || audit.sourceSnapshotIds.some(id => snapshotIds.has(id))) affected.add(audit.id);
  }
  // Invalidates an in-flight AI audit before any evidence is removed.
  if (await store.get('workspaces', workspaceId)) await store.commitChannelWrites(workspaceId, null, null, [], { bumpRevision: true }).catch(() => {});
  const operations = [
    ...removedPosts.map(p => ({ collection: 'socialPosts', id: p.id })),
    ...removedSnapshots.map(s => ({ collection: 'analyticsSnapshots', id: s.id })),
    ...parts.filter(p=>p.connectionId===connectionId).map(p=>({collection:'analyticsSnapshotParts',id:p.id})),
    ...imports.filter(i => i.connectionId === connectionId).map(i => ({ collection: 'channelImports', id: i.id })),
    ...[...affected].flatMap(id => [{ collection: 'channelAudits', id }, { collection: 'channelAuditInputs', id }]),
  ];
  for (let i = 0; i < operations.length; i += 400) await store.batch(operations.slice(i, i + 400));
}
