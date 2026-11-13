import type { ChannelSnapshot } from '../../shared/channels.js';
import type { Write } from '../store.js';

export interface SnapshotPart {
  id: string; workspaceId: string; connectionId: string; snapshotId: string;
  postMetrics: NonNullable<ChannelSnapshot['postMetrics']>;
}

/** Keep large observations below Firestore's per-document limit without dropping metrics. */
export function snapshotWrites(snapshot: ChannelSnapshot): Write[] {
  if (Buffer.byteLength(JSON.stringify(snapshot),'utf8') < 750_000) return [{collection:'analyticsSnapshots',value:snapshot}];
  const {postMetrics = [], ...base} = snapshot;
  const writes: Write[] = [{collection:'analyticsSnapshots',value:base}];
  let entries: SnapshotPart['postMetrics'] = [], bytes=0, index=0;
  const flush=()=>{
    if(!entries.length)return;
    writes.push({collection:'analyticsSnapshotParts',value:{id:`${snapshot.id}_${index++}`,workspaceId:snapshot.workspaceId,connectionId:snapshot.connectionId,snapshotId:snapshot.id,postMetrics:entries}});
    entries=[];bytes=0;
  };
  for(const entry of postMetrics){const size=Buffer.byteLength(JSON.stringify(entry),'utf8');if(bytes+size>600_000)flush();entries.push(entry);bytes+=size;}
  flush();return writes;
}

export function hydrateSnapshots(snapshots: ChannelSnapshot[], parts: SnapshotPart[]): ChannelSnapshot[] {
  return snapshots.map(snapshot=>{
    const matching=parts.filter(p=>p.workspaceId===snapshot.workspaceId&&p.connectionId===snapshot.connectionId&&p.snapshotId===snapshot.id);
    if(!matching.length)return snapshot;
    return {...snapshot,postMetrics:[...(snapshot.postMetrics||[]),...matching.sort((a,b)=>Number(a.id.slice(a.id.lastIndexOf('_')+1))-Number(b.id.slice(b.id.lastIndexOf('_')+1))).flatMap(p=>p.postMetrics)]};
  });
}
