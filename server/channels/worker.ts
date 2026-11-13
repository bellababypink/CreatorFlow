import { randomUUID } from 'node:crypto';
import { store } from '../store.js';
import { HttpError } from '../errors.js';
import { ProcessingError } from '../processing/errors.js';
import type { StoredAsset, StoredJob } from '../models.js';
import type { Analysis } from '../../shared/types.js';
import type { ChannelConnection, ChannelPost } from '../../shared/channels.js';
import { getYouTubeIntegration, revokeYouTubeConnection } from './oauth.js';
import { syncYouTube } from './youtube.js';
import { generateChannelAudit } from './audits.js';
import { assertAuditReady, captureOverview, channelConnection, channelJob } from './service.js';
import { snapshotWrites } from './snapshots.js';
import { purgeChannelData } from './lifecycle.js';

export async function processChannelJob(job: StoredJob, workerId: string) {
  const progress = async (value: number, stage: string) => {
    if (job.connectionId) {
      const connection = await channelConnection(job.workspaceId, job.connectionId);
      if (connection.disconnectedAt) throw new HttpError(409, 'This channel was disconnected. No new data will be saved.');
    }
    await store.progressJob(job.id, workerId, { progress: value, stage });
  };
  try {
    if (job.type === 'channel_sync') {
      const connection = await channelConnection(job.workspaceId, job.connectionId!);
      if (connection.source !== 'oauth' || connection.provider !== 'youtube' || connection.disconnectedAt) throw new HttpError(409, 'This account has no active YouTube authorization.');
      await progress(5, 'Reading authorized YouTube channel');
      const result = await syncYouTube(connection, progress);
      const capture = await captureOverview(job.workspaceId);
      const old = new Map(capture.overview.posts.map(p => [p.id,p]));
      const posts = result.posts.map(post => {
        const previous = old.get(post.id);
        return previous ? { ...post, createdAt: previous.createdAt, version: previous.version + 1, mediaAssetId: previous.mediaAssetId,
          ...(previous.pillarSource === 'user_confirmed' ? {pillar:previous.pillar,pillarSource:previous.pillarSource} : {}) } : post;
      });
      await store.commitChannelWrites(job.workspaceId, connection.id, connection.generation, [
        { collection: 'socialConnections', value: result.connection },
        ...posts.map(value => ({ collection: 'socialPosts', value })),
        ...snapshotWrites(result.snapshot),
      ], { jobId: job.id, workerId, dataRevision: capture.revision });
      await store.finishJob(job.id,workerId,{status:'completed',progress:100,stage:'YouTube data synchronized',error:null,outputId:result.snapshot.id});
    } else {
      await progress(10, 'Capturing channel evidence');
      const capture = await captureOverview(job.workspaceId,job.filters || {});
      assertAuditReady(capture.overview);
      const mediaAnalyses: Record<string,Analysis> = {};
      for (const post of capture.overview.posts.filter(p => p.mediaAssetId)) {
        const asset = await store.get<StoredAsset>('assets',post.mediaAssetId!);
        if(asset?.workspaceId!==job.workspaceId || !asset.analysisId) continue;
        const analysis=await store.get<Analysis>('analyses',asset.analysisId);
        if(analysis?.workspaceId===job.workspaceId)mediaAnalyses[post.id]=analysis;
      }
      await progress(30, 'Gemini is reviewing the available evidence');
      const frozenOverview={...capture.overview,posts:capture.overview.posts.slice(0,100),snapshots:capture.overview.snapshots.slice(0,10).map(({postMetrics,...snapshot})=>snapshot)};
      if(Buffer.byteLength(JSON.stringify(frozenOverview),'utf8')>850_000)throw new HttpError(413,'Select a smaller evidence set before generating this audit.');
      const audit=await generateChannelAudit({workspaceId:job.workspaceId,overview:capture.overview,workspace:capture.workspace,mediaAnalyses});
      await store.commitChannelWrites(job.workspaceId,null,null,[
        {collection:'channelAudits',value:audit},
        {collection:'channelAuditInputs',value:{id:audit.id,workspaceId:job.workspaceId,overview:frozenOverview,createdAt:audit.createdAt,version:1}},
        {collection:'usage',value:{id:randomUUID(),workspaceId:job.workspaceId,jobId:job.id,provider:'gemini',model:audit.model,tokens:audit.usage||{},costStatus:'unpriced',operation:'channel_audit',createdAt:new Date().toISOString()}},
      ],{jobId:job.id,workerId,dataRevision:capture.revision});
      await store.finishJob(job.id,workerId,{status:'completed',progress:100,stage:'Evidence-based channel audit saved',error:null,outputId:audit.id});
    }
  } catch(error) {
    const status=error instanceof HttpError?error.status:Number((error as any)?.status);
    const configured=error instanceof HttpError&&error.code==='CONFIGURATION_REQUIRED' || error instanceof ProcessingError&&error.code==='CONFIGURATION_REQUIRED';
    const retry=!configured&&(status===429||status>=500||error instanceof ProcessingError&&error.retryable)&&job.attempts<job.maxAttempts;
    const message=error instanceof HttpError||error instanceof ProcessingError?error.message:'The channel task could not be completed. No result was fabricated; retry after checking configuration.';
    if(retry)await store.progressJob(job.id,workerId,{status:'queued',stage:'Waiting to retry channel task',error:message,nextAttemptAt:new Date(Date.now()+Math.pow(2,job.attempts)*5000).toISOString()});
    else await store.finishJob(job.id,workerId,{status:configured?'blocked_configuration':'failed',stage:configured?'Configuration required':'Channel task failed',error:message});
  }
}

/** Runs only in the separate worker, not in a browser request. */
export async function maintainChannels() {
  const connections=await store.list<ChannelConnection & {purgeOwner?:string;purgeUntil?:string}>('socialConnections');
  for(const state of await store.list<any>('channelOAuthStates'))if(Date.parse(state.expiresAt||'')<Date.now())await store.remove('channelOAuthStates',state.id);
  for(const connection of connections.filter(c=>c.provider==='youtube'&&c.source==='oauth'&&c.disconnectedAt&&c.purgeOwner&&Date.parse(c.purgeUntil||'')<Date.now()))await revokeYouTubeConnection(connection.id,connection.workspaceId).catch(()=>{});
  for(const connection of connections.filter(c=>c.provider==='youtube'&&c.source==='oauth'&&!c.disconnectedAt)) {
    const last=Date.parse(connection.lastSyncedAt || connection.createdAt);
    if(Date.now()-last>=30*24*60*60*1000){
      await revokeYouTubeConnection(connection.id,connection.workspaceId).catch(()=>{});
      await purgeChannelData(connection.workspaceId,connection.id);
    }else if(getYouTubeIntegration().configured && (!connection.lastSyncedAt||Date.now()-last>=24*60*60*1000)){
      await store.enqueueChannelJob(channelJob(connection.workspaceId,'channel_sync',{connectionId:connection.id})).catch(()=>{});
    }
  }
}
