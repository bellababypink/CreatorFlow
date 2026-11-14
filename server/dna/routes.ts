import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authenticate, workspaceAccess } from '../auth.js';
import { store } from '../store.js';
import { publicAsset, type StoredAsset, type StoredJob } from '../models.js';
import { HttpError } from '../errors.js';
import type { DNAOverview, DNAProfile, StyleReference, ReferenceAnalysis, StylePreset, PresetRevision, ProductionProject } from '../../shared/dna.js';
import { assertVersion, cleanPreferences, ensureUnlocked, getProfile, idSchema, now, owned, preferencesSchema, presetSchema, profileGuard, profileWrites, referenceFor, renderStyleGuide, resolveCreativeContext, usableAsset, versionSchema, workspaceRecord } from './service.js';

export const dnaRouter=Router({mergeParams:true});
dnaRouter.use(authenticate);
const read=workspaceAccess(), edit=workspaceAccess(['owner','administrator','editor']), admin=workspaceAccess(['owner','administrator']);
const ws=(req:any)=>String(req.params.workspaceId);
const revisionGuard=(collection:string,id:string)=>({collection,id,version:null});
const revisionWrite=(preset:StylePreset,restoredFrom?:number)=>({collection:'stylePresetRevisions',value:{...preset,id:`${preset.id}_v${preset.version}`,presetId:preset.id,revision:preset.version,...(restoredFrom?{restoredFrom}:{})}});
function changedProfile(profile:DNAProfile,userId:string):DNAProfile{return {...profile,version:profile.version+1,updatedAt:now(),updatedBy:userId};}
async function audit(workspaceId:string,userId:string,action:string,resourceId:string){await store.put('auditLogs',{id:randomUUID(),workspaceId,userId,action,resourceId,createdAt:now()});}

dnaRouter.get('/',read,async(req,res)=>{
  const id=ws(req);
  const [profile,references,analyses,presets,projects,jobs,assets]=await Promise.all([getProfile(id),store.list<StyleReference>('styleReferences','workspaceId',id),store.list<ReferenceAnalysis>('styleAnalyses','workspaceId',id),store.list<StylePreset>('stylePresets','workspaceId',id),store.list<ProductionProject>('productionProjects','workspaceId',id),store.list<StoredJob>('jobs','workspaceId',id),store.list<StoredAsset>('assets','workspaceId',id)]);
  const result:DNAOverview={profile,references:references.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),analyses:analyses.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),presets:presets.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),projects:projects.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),jobs:jobs.filter(j=>j.type==='style_analysis').map(({workerId,nextAttemptAt,slotReserved,...safe})=>safe),assets:assets.filter(a=>!a.deleting).map(publicAsset),geminiConfigured:!!process.env.GEMINI_API_KEY};
  res.json(result);
});
dnaRouter.patch('/profile',edit,async(req,res)=>{
  const {expectedVersion,preferences}=z.object({expectedVersion:versionSchema,preferences:preferencesSchema}).strict().parse(req.body);
  const current=await getProfile(ws(req));assertVersion(current,expectedVersion);ensureUnlocked(current);
  const next=changedProfile(current,req.user!.id);next.preferences=cleanPreferences(preferences);next.provenance={};
  for(const key of Object.keys(next.preferences) as (keyof typeof next.preferences)[])next.provenance[key]=next.preferences[key]===current.preferences[key]&&current.provenance[key]?current.provenance[key]:{source:'creator'};
  await store.commitCreativeWrites(ws(req),profileWrites(next),{versions:[profileGuard(current),revisionGuard('dnaProfileRevisions',`${next.id}_v${next.version}`)]});
  res.json({profile:next});
});
dnaRouter.post('/profile/lock',admin,async(req,res)=>{
  const {expectedVersion,locked}=z.object({expectedVersion:versionSchema,locked:z.boolean()}).strict().parse(req.body);
  const current=await getProfile(ws(req));assertVersion(current,expectedVersion);
  if(locked&&!Object.keys(current.preferences).length)throw new HttpError(422,'Add creator preferences before locking the Style Guide.');
  const profile={...changedProfile(current,req.user!.id),status:locked?'locked' as const:'draft' as const,lockedAt:locked?now():null};
  await store.commitCreativeWrites(ws(req),profileWrites(profile),{versions:[profileGuard(current),revisionGuard('dnaProfileRevisions',`${profile.id}_v${profile.version}`)]});
  await audit(ws(req),req.user!.id,locked?'style_guide.locked':'style_guide.unlocked',profile.id);res.json({profile});
});
dnaRouter.post('/profile/adopt',edit,async(req,res)=>{
  const {expectedVersion,analysisId,patternIndex}=z.object({expectedVersion:versionSchema,analysisId:idSchema,patternIndex:z.number().int().min(0).max(99)}).strict().parse(req.body);
  const current=await getProfile(ws(req));assertVersion(current,expectedVersion);ensureUnlocked(current);
  const analysis=await owned<ReferenceAnalysis>('styleAnalyses',ws(req),analysisId),reference=await referenceFor(ws(req),analysis.referenceId);
  const pattern=analysis.patterns[patternIndex];
  if(analysis.status!=='complete'||reference.analysisId!==analysis.id||reference.version!==analysis.referenceVersion||!pattern)throw new HttpError(409,'Select a current, complete reference analysis before adopting a pattern.');
  const profile=changedProfile(current,req.user!.id);profile.preferences={...current.preferences,[pattern.dimension]:pattern.suggestedPreference};profile.provenance={...current.provenance,[pattern.dimension]:{source:'adopted_pattern',referenceId:reference.id,analysisId:analysis.id}};
  await store.commitCreativeWrites(ws(req),profileWrites(profile),{versions:[profileGuard(current),{collection:'styleReferences',id:reference.id,version:reference.version},revisionGuard('dnaProfileRevisions',`${profile.id}_v${profile.version}`)]});
  await audit(ws(req),req.user!.id,'style_pattern.adopted',analysis.id);res.json({profile});
});
dnaRouter.get('/guide',read,async(req,res)=>{
  const [profile,presets,workspace]=await Promise.all([getProfile(ws(req)),store.list<StylePreset>('stylePresets','workspaceId',ws(req)),workspaceRecord(ws(req))]);
  res.set({'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="creatorflow-style-guide.md"'}).send(renderStyleGuide(profile,presets,workspace.name));
});
dnaRouter.get('/context',read,async(req,res)=>{
  const query=z.object({presetId:idSchema.optional()}).strict().parse(req.query);res.json({context:(await resolveCreativeContext(ws(req),query.presetId)).context});
});
const referenceSchema=z.object({title:z.string().trim().min(1).max(150),purpose:z.enum(['own_work','inspiration','brand']),kind:z.enum(['video','link','document']),assetId:idSchema.optional(),url:z.string().url().max(2000).optional(),text:z.string().trim().min(1).max(50000).optional(),notes:z.string().trim().max(3000).default(''),permission:z.enum(['owned','authorized','link_only'])}).strict();
dnaRouter.post('/references',edit,async(req,res)=>{
  const input=referenceSchema.parse(req.body),id=ws(req),versions=[];
  if(input.kind==='video'){
    if(!input.assetId||input.url||input.text||input.permission==='link_only')throw new HttpError(422,'Select an owned or authorized video from this workspace’s Media Vault.');
    const asset=await usableAsset(id,input.assetId);versions.push({collection:'assets',id:asset.id,version:asset.version});
  }else if(input.kind==='document'){
    if(!input.text||input.assetId||input.url||input.permission==='link_only'||Buffer.byteLength(input.text,'utf8')>50000)throw new HttpError(422,'Supply up to 50 KB of owned or authorized plain text or Markdown.');
  }else{
    if(!input.url||input.assetId||input.text||input.permission!=='link_only')throw new HttpError(422,'Save a reference link without claiming access to its media.');
    const url=new URL(input.url);if(url.protocol!=='https:'||url.username||url.password)throw new HttpError(422,'Use a public HTTPS reference link without embedded credentials.');
  }
  const reference:StyleReference={...input,id:randomUUID(),workspaceId:id,analysisId:null,createdAt:now(),updatedAt:now(),version:1};
  await store.commitCreativeWrites(id,[{collection:'styleReferences',value:reference}],{versions:[...versions,revisionGuard('styleReferences',reference.id)],createCollection:'styleReferences'});res.status(201).json({reference});
});
dnaRouter.delete('/references/:referenceId',edit,async(req,res)=>{
  const {expectedVersion}=z.object({expectedVersion:versionSchema}).strict().parse(req.body),reference=await referenceFor(ws(req),String(req.params.referenceId));assertVersion(reference,expectedVersion);
  const jobs=await store.list<StoredJob>('jobs','workspaceId',ws(req));if(jobs.some(j=>j.referenceId===reference.id&&['queued','processing'].includes(j.status)))throw new HttpError(409,'Wait for this reference’s analysis to finish before removing it.');
  const analyses=(await store.list<ReferenceAnalysis>('styleAnalyses','workspaceId',ws(req))).filter(a=>a.referenceId===reference.id);
  await store.commitCreativeWrites(ws(req),[],{versions:[{collection:'styleReferences',id:reference.id,version:reference.version}],inactiveJobIds:[`style_${reference.id}`]},[{collection:'styleReferences',id:reference.id},...analyses.map(a=>({collection:'styleAnalyses',id:a.id}))]);res.json({success:true});
});
dnaRouter.post('/references/:referenceId/analyze',edit,async(req,res)=>{
  z.object({}).strict().parse(req.body||{});
  const reference=await referenceFor(ws(req),String(req.params.referenceId));
  if(reference.kind==='link')throw new HttpError(422,'This link is saved for reference. Supply an authorized video upload or document to analyze its creative approach.','REFERENCE_UPLOAD_REQUIRED');
  if(reference.assetId)await usableAsset(ws(req),reference.assetId);
  const job:StoredJob={id:`style_${reference.id}`,workspaceId:ws(req),assetId:`style:${reference.id}`,referenceId:reference.id,referenceVersion:reference.version,type:'style_analysis',status:'queued',progress:0,stage:'Waiting for style analysis',attempts:0,maxAttempts:3,error:null,outputId:null,createdAt:now(),updatedAt:now(),version:1,slotReserved:true};
  res.status(202).json({job:await store.enqueueCreativeJob(job)});
});
dnaRouter.post('/presets',edit,async(req,res)=>{
  const input=presetSchema.parse(req.body),id=ws(req);
  const preset:StylePreset={...input,preferences:cleanPreferences(input.preferences),id:randomUUID(),workspaceId:id,version:1,createdAt:now(),updatedAt:now(),updatedBy:req.user!.id};
  await store.commitCreativeWrites(id,[{collection:'stylePresets',value:preset},revisionWrite(preset)],{versions:[revisionGuard('stylePresets',preset.id),revisionGuard('stylePresetRevisions',`${preset.id}_v1`)],createCollection:'stylePresets'});res.status(201).json({preset});
});
dnaRouter.patch('/presets/:presetId',edit,async(req,res)=>{
  const {expectedVersion,...input}=presetSchema.extend({expectedVersion:versionSchema}).parse(req.body),current=await owned<StylePreset>('stylePresets',ws(req),String(req.params.presetId));assertVersion(current,expectedVersion);
  if(current.version>=200)throw new HttpError(413,'This preset has reached its 200-revision limit. Create a new named preset.');
  const preset:StylePreset={...current,...input,preferences:cleanPreferences(input.preferences),version:current.version+1,updatedAt:now(),updatedBy:req.user!.id};
  await store.commitCreativeWrites(ws(req),[{collection:'stylePresets',value:preset},revisionWrite(preset)],{versions:[{collection:'stylePresets',id:current.id,version:current.version},revisionGuard('stylePresetRevisions',`${preset.id}_v${preset.version}`)]});res.json({preset});
});
dnaRouter.get('/presets/:presetId/revisions',read,async(req,res)=>{
  const preset=await owned<StylePreset>('stylePresets',ws(req),String(req.params.presetId));const revisions=(await store.list<PresetRevision>('stylePresetRevisions','workspaceId',ws(req))).filter(r=>r.presetId===preset.id).sort((a,b)=>b.revision-a.revision);res.json({revisions});
});
dnaRouter.post('/presets/:presetId/restore',edit,async(req,res)=>{
  const {expectedVersion,revision}=z.object({expectedVersion:versionSchema,revision:z.number().int().min(1).max(200)}).strict().parse(req.body),current=await owned<StylePreset>('stylePresets',ws(req),String(req.params.presetId));assertVersion(current,expectedVersion);
  if(current.version>=200)throw new HttpError(413,'This preset has reached its revision limit.');
  const saved=await owned<PresetRevision>('stylePresetRevisions',ws(req),`${current.id}_v${revision}`);
  if(saved.presetId!==current.id)throw new HttpError(404,'Preset revision not found.');
  const preset:StylePreset={...current,name:saved.name,description:saved.description,preferences:saved.preferences,settings:saved.settings,version:current.version+1,updatedAt:now(),updatedBy:req.user!.id};
  await store.commitCreativeWrites(ws(req),[{collection:'stylePresets',value:preset},revisionWrite(preset,revision)],{versions:[{collection:'stylePresets',id:current.id,version:current.version},revisionGuard('stylePresetRevisions',`${preset.id}_v${preset.version}`)]});res.json({preset});
});
dnaRouter.post('/projects',edit,async(req,res)=>{
  const input=z.object({title:z.string().trim().min(1).max(150),presetId:idSchema.optional(),assetIds:z.array(idSchema).max(30)}).strict().parse(req.body),id=ws(req);
  if(new Set(input.assetIds).size!==input.assetIds.length)throw new HttpError(422,'Select each source video once.');
  const {context,profile,preset}=await resolveCreativeContext(id,input.presetId),assets=await Promise.all(input.assetIds.map(a=>usableAsset(id,a)));
  const project:ProductionProject={id:randomUUID(),workspaceId:id,title:input.title,status:'brief',assetIds:input.assetIds,creativeContext:context,createdAt:now(),updatedAt:now(),createdBy:req.user!.id,version:1};
  await store.commitCreativeWrites(id,[{collection:'productionProjects',value:project}],{versions:[profileGuard(profile),...(preset?[{collection:'stylePresets',id:preset.id,version:preset.version}]:[]),...assets.map(a=>({collection:'assets',id:a.id,version:a.version})),revisionGuard('productionProjects',project.id)]});res.status(201).json({project});
});
