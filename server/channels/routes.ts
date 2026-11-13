import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authenticate, workspaceAccess } from '../auth.js';
import { config } from '../config.js';
import { store } from '../store.js';
import { HttpError } from '../errors.js';
import type { Analysis } from '../../shared/types.js';
import type { StoredAsset } from '../models.js';
import type { ChannelAudit, ChannelConnection, ChannelIntegration, ChannelPost, ChannelPostDetail } from '../../shared/channels.js';
import { beginYouTubeAuthorization, completeYouTubeAuthorization, getYouTubeIntegration, refreshYouTubeConnection, revokeYouTubeConnection } from './oauth.js';
import { latestMetrics } from './analytics.js';
import { ANALYTICS_CSV_TEMPLATE, parseAnalyticsCsv, prepareImport } from './imports.js';
import { buildEvidenceReportMarkdown, renderAuditMarkdown } from './audits.js';
import { assertAuditReady, captureOverview, channelConnection, channelJob, filtersSchema, getChannelAudit, sameFilters } from './service.js';
import { snapshotWrites } from './snapshots.js';
import { purgeChannelData } from './lifecycle.js';

export const channelsRouter = Router({ mergeParams: true });
const read = workspaceAccess();
const edit = workspaceAccess(['owner','administrator','editor']);
const admin = workspaceAccess(['owner','administrator']);
channelsRouter.use(authenticate);
const workspaceId = (req: any) => String(req.params.workspaceId);
const oauthCookie = 'creatorflow_youtube_oauth';

export function channelIntegrations(): ChannelIntegration[] {
  return [getYouTubeIntegration(), ...(['instagram','tiktok'] as const).map(provider => ({
    provider, name: provider === 'instagram' ? 'Instagram' : 'TikTok', status: 'Unavailable' as const,
    message: 'Live adapter deferred until YouTube is verified with a real account. Manual analytics imports are available.',
    configured: false, canConnect: false, requiredScopes: [],
    setupSteps: [provider === 'instagram' ? 'Requires an eligible Instagram professional account and a configured Meta application.' : 'Requires a TikTok developer application and approved products/scopes.', 'No live adapter or account access is enabled in this YouTube-first release.'],
  }))];
}

channelsRouter.get('/', read, async (req, res) => {
  const id = workspaceId(req);
  const [connections, jobs, audits] = await Promise.all([
    store.list<ChannelConnection>('socialConnections','workspaceId',id),
    store.list<any>('jobs','workspaceId',id),
    store.list<ChannelAudit>('channelAudits','workspaceId',id),
  ]);
  res.json({ integrations: channelIntegrations(), connections, auditCapabilities:{geminiConfigured:Boolean(process.env.GEMINI_API_KEY),youtubeInferenceApproved:process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED==='true'}, jobs: jobs.filter(j => j.type === 'channel_sync' || j.type === 'channel_audit'), audits: audits.sort((a,b) => b.generatedAt.localeCompare(a.generatedAt)) });
});
channelsRouter.get('/overview', read, async (req,res) => {
  const filters = filtersSchema.parse(req.query);
  res.json((await captureOverview(workspaceId(req), filters)).overview);
});
channelsRouter.get('/posts/:postId', read, async (req,res) => {
  const id=workspaceId(req), post=await store.get<ChannelPost>('socialPosts',String(req.params.postId));
  if(!post || post.workspaceId!==id) throw new HttpError(404,'Post not found.');
  const connection=await channelConnection(id,post.connectionId);
  if(connection.disconnectedAt)throw new HttpError(404,'Post not found.');
  const asset=post.mediaAssetId?await store.get<StoredAsset>('assets',post.mediaAssetId):null;
  const linked=asset?.workspaceId===id?asset:null;
  const candidate=linked?.analysisId?await store.get<Analysis>('analyses',linked.analysisId):null;
  const analysis=candidate?.workspaceId===id&&candidate.assetId===linked?.id?candidate:null;
  const result:ChannelPostDetail={post,connection,linkedMedia:linked?{id:linked.id,originalName:linked.originalName}:null,
    mediaAnalysis:analysis?.workspaceId===id?analysis:null,
    evidenceAvailability:{metadata:true,video:!!linked,analysis:!!analysis&&analysis.workspaceId===id,
      message:analysis?.workspaceId===id?'Video observations come from the linked, analyzed workspace upload. Review approximate timestamps.':'Only post metadata is available. Link your authorized original from Media Vault to examine actual hooks, visual patterns, and spoken content.'}};
  res.json(result);
});
channelsRouter.patch('/posts/:postId', edit, async(req,res)=>{
  const id=workspaceId(req),post=await store.get<ChannelPost>('socialPosts',String(req.params.postId));
  if(!post||post.workspaceId!==id)throw new HttpError(404,'Post not found.');
  const patch=z.object({pillar:z.string().trim().min(1).max(100).nullable().optional(),mediaAssetId:z.string().min(1).max(160).nullable().optional(),contentType:z.enum(['video','short','reel','tiktok','image','carousel','unknown']).optional()}).strict().parse(req.body);
  if(patch.contentType && post.provider==='youtube' && post.source!=='manual_import')throw new HttpError(400,'YouTube API content types cannot be inferred or overridden.');
  if(patch.mediaAssetId){const asset=await store.get<StoredAsset>('assets',patch.mediaAssetId);if(!asset||asset.workspaceId!==id||asset.deleting)throw new HttpError(404,'Workspace media asset not found.');}
  const capture=await captureOverview(id);
  const currentPost=capture.overview.posts.find(p=>p.id===post.id);
  if(!currentPost)throw new HttpError(404,'Post not found.');
  const connection=await channelConnection(id,post.connectionId);
  const updated={...currentPost,...patch,...('contentType'in patch?{contentTypeSource:'user_confirmed' as const}:{}),...('pillar'in patch?{pillarSource:patch.pillar?'user_confirmed' as const:null}:{}),updatedAt:new Date().toISOString(),version:currentPost.version+1};
  await store.commitChannelWrites(id,connection.id,connection.generation,[{collection:'socialPosts',value:updated}],{dataRevision:capture.revision});res.json(updated);
});

channelsRouter.post('/youtube/authorize',admin,async(req,res)=>{
  const browserNonce=randomBytes(32).toString('base64url');
  const {url}=await beginYouTubeAuthorization({workspaceId:workspaceId(req),userId:req.user!.id,browserNonce});
  res.cookie(oauthCookie,browserNonce,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',maxAge:10*60*1000,path:'/api/channels/oauth/youtube/callback'});
  res.json({url});
});
channelsRouter.post('/connections/:connectionId/sync',edit,async(req,res)=>{
  const connection=await channelConnection(workspaceId(req),String(req.params.connectionId));
  if(connection.source!=='oauth'||connection.provider!=='youtube')throw new HttpError(409,'Imported accounts have no live authorization. Import a newer analytics file to update them.');
  if(connection.disconnectedAt)throw new HttpError(409,'Reconnect this account before synchronizing.');
  if(connection.lastSyncedAt && Date.parse(connection.lastSyncedAt)>Date.now()-60_000)throw new HttpError(429,'This channel was synchronized less than a minute ago. Please wait before synchronizing again.');
  res.status(202).json({job:await store.enqueueChannelJob(channelJob(connection.workspaceId,'channel_sync',{connectionId:connection.id}))});
});
channelsRouter.post('/connections/:connectionId/refresh',admin,async(req,res)=>{
  const connection=await channelConnection(workspaceId(req),String(req.params.connectionId));
  if(connection.source!=='oauth'||connection.provider!=='youtube')throw new HttpError(409,'Imported accounts have no authorization token to refresh.');
  await refreshYouTubeConnection(connection.id,connection.workspaceId);
  res.json({connection:await channelConnection(connection.workspaceId,connection.id)});
});
channelsRouter.delete('/connections/:connectionId',admin,async(req,res)=>{
  const connection=await channelConnection(workspaceId(req),String(req.params.connectionId));
  const {confirmation}=z.object({confirmation:z.string()}).strict().parse(req.body);
  if(confirmation!==connection.accountName)throw new HttpError(400,'Type the account name exactly to disconnect and remove its cached channel data.');
  let warning:string|undefined;
  if(connection.source==='oauth'){
    await revokeYouTubeConnection(connection.id,connection.workspaceId);
  }else{
    await store.mutate<ChannelConnection>('socialConnections',connection.id,current=>{if(!current||current.workspaceId!==connection.workspaceId)throw new HttpError(404,'Channel account not found.');return {...current,generation:current.generation+1,disconnectedAt:new Date().toISOString(),status:'Unavailable',updatedAt:new Date().toISOString()};});
    await store.remove('channelSecrets',connection.id);
  }
  await purgeChannelData(connection.workspaceId,connection.id);
  if(connection.source==='manual_import')await store.remove('socialConnections',connection.id);
  res.json({success:true,...(warning?{warning}:{})});
});

const importSchema=z.object({csv:z.string().min(1).max(102400),platform:z.enum(['youtube','instagram','tiktok']),accountName:z.string().trim().min(1).max(100),digest:z.string().max(128).optional()}).strict();
channelsRouter.get('/imports/template',read,(_req,res)=>{res.type('text/csv').set('Content-Disposition','attachment; filename="creatorflow-analytics-template.csv"').send(ANALYTICS_CSV_TEMPLATE);});
channelsRouter.post('/imports/preview',edit,async(req,res)=>{const input=importSchema.parse(req.body);res.json(parseAnalyticsCsv({...input,workspaceId:workspaceId(req)}));});
channelsRouter.post('/imports/commit',edit,async(req,res)=>{
  const input=importSchema.extend({digest:z.string().min(1).max(128)}).parse(req.body),id=workspaceId(req);
  const preview=parseAnalyticsCsv({...input,workspaceId:id});
  if(input.digest!==preview.digest)throw new HttpError(409,'The import changed after preview. Review it again before importing.');
  const prepared=prepareImport(preview,id);
  const capture=await captureOverview(id);
  const existing=capture.connections.find(c=>c.id===prepared.connection.id);
  const connection=existing?{...prepared.connection,availableMetrics:[...new Set([...existing.availableMetrics,...prepared.connection.availableMetrics])],createdAt:existing.createdAt,version:existing.version+1,generation:existing.generation}:prepared.connection;
  const previous=new Map(capture.overview.posts.map(p=>[p.id,p]));
  const posts=prepared.posts.map(p=>{
    const old=previous.get(p.id);if(!old)return p;
    for(const metric of p.metrics){const prior=old.metrics.find(m=>m.comparisonKey===metric.comparisonKey&&m.definition===metric.definition&&m.observedAt===metric.observedAt);if(prior&&prior.value!==metric.value)throw new HttpError(409,'This file conflicts with an existing observation at the same timestamp. Check the export and its observation time.','CONFLICTING_OBSERVATION');}
    const metrics=latestMetrics([...old.metrics,...p.metrics],p.provider);
    if(metrics.length>400)throw new HttpError(413,'This post has reached the limit of 400 distinct metric windows.');
    const older=Math.max(...old.metrics.map(m=>Date.parse(m.observedAt)))>Math.max(...p.metrics.map(m=>Date.parse(m.observedAt)));
    const metadata=older?{...p,title:old.title,caption:old.caption,publishedAt:old.publishedAt,durationSeconds:old.durationSeconds,contentType:old.contentType,tags:old.tags,url:old.url}:{...p,title:p.title===p.providerPostId?old.title:p.title,caption:p.caption||old.caption,durationSeconds:p.durationSeconds??old.durationSeconds,url:p.url||old.url,tags:p.tags.length?p.tags:old.tags};
    return {...metadata,metrics,...(old.contentTypeSource==='user_confirmed'?{contentType:old.contentType,contentTypeSource:old.contentTypeSource}:{}),createdAt:old.createdAt,version:old.version+1,mediaAssetId:old.mediaAssetId,...(old.pillarSource==='user_confirmed'||older?{pillar:old.pillar,pillarSource:old.pillarSource}:{})};
  });
  const writes=[{collection:'socialConnections',value:connection},...posts.map(value=>({collection:'socialPosts',value})),...snapshotWrites(prepared.snapshot),{collection:'channelImports',value:prepared.importRecord}];
  await store.commitChannelWrites(id,existing?connection.id:null,existing?connection.generation:null,writes,{importId:prepared.importRecord.id,dataRevision:capture.revision});
  res.status(201).json({connection,importedPosts:posts.length,warnings:preview.warnings});
});
channelsRouter.post('/audits',edit,async(req,res)=>{
  const {filters}=z.object({filters:filtersSchema.default({})}).strict().parse(req.body||{});
  const capture=await captureOverview(workspaceId(req),filters);assertAuditReady(capture.overview);
  res.status(202).json({job:await store.enqueueChannelJob(channelJob(workspaceId(req),'channel_audit',{filters}))});
});
channelsRouter.get('/audits/:auditId',read,async(req,res)=>res.json(await getChannelAudit(workspaceId(req),String(req.params.auditId))));
channelsRouter.get('/report',read,async(req,res)=>{
  const filters=filtersSchema.parse(req.query),id=workspaceId(req);
  const capture=await captureOverview(id,filters);
  if(!capture.overview.posts.length)throw new HttpError(422,'There is no channel evidence in this selection to export.');
  const audits=(await store.list<ChannelAudit>('channelAudits','workspaceId',id)).filter(a=>sameFilters(a.filters,filters)).sort((a,b)=>b.generatedAt.localeCompare(a.generatedAt));
  let report=buildEvidenceReportMarkdown(capture.overview,capture.connections,capture.workspace);
  if(audits[0]){const input=await store.get<any>('channelAuditInputs',audits[0].id);if(input?.workspaceId===id)report+='\n\n---\n\n'+renderAuditMarkdown(audits[0],input.overview);}
  res.type('text/markdown').set('Content-Disposition','attachment; filename="creatorflow-channel-audit.md"').send(report);
});

export const youtubeOAuthCallback: import('express').RequestHandler=async(req,res,next)=>{
  res.set('Referrer-Policy','no-referrer');
  try{
    const input=z.object({state:z.string().min(16).max(512),code:z.string().max(4096).optional(),error:z.string().max(200).optional(),scope:z.string().max(4000).optional(),authuser:z.string().max(100).optional(),prompt:z.string().max(100).optional()}).passthrough().parse(req.query);
    const connection=await completeYouTubeAuthorization({state:input.state,code:input.code,error:input.error,userId:req.user!.id,browserNonce:req.cookies?.[oauthCookie]||''});
    res.clearCookie(oauthCookie,{path:'/api/channels/oauth/youtube/callback'});
    // Linking succeeds independently of queue availability; the UI can retry sync.
    await store.enqueueChannelJob(channelJob(connection.workspaceId,'channel_sync',{connectionId:connection.id})).catch(()=>{});
    res.redirect(`${config.origin}/channels?oauth=connected`);
  }catch(error){
    res.clearCookie(oauthCookie,{path:'/api/channels/oauth/youtube/callback'});
    const message=error instanceof HttpError?error.message:'The YouTube connection could not be completed. Please try again.';
    res.redirect(`${config.origin}/channels?oauth=error&message=${encodeURIComponent(message)}`);
  }
};
