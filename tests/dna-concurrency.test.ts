import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StoredJob,StoredWorkspace } from '../server/models.js';
import type { StylePreset,StyleReference } from '../shared/dna.js';

const dataDir=await mkdtemp(path.join(os.tmpdir(),'creatorflow-dna-concurrency-'));
Object.assign(process.env,{APP_MODE:'local',NODE_ENV:'test',CF_DATA_DIR:dataDir,WORKSPACE_MAX_ACTIVE_JOBS:'3'});
const {store}=await import('../server/store.js');
after(async()=>{await rm(dataDir,{recursive:true,force:true});});
const timestamp=new Date().toISOString();
function workspace(id:string):StoredWorkspace{return {id,name:'Concurrency verification',ownerId:'test-owner',role:'owner',platforms:[],niches:[],goals:[],onboardingComplete:true,createdAt:timestamp,updatedAt:timestamp,version:1,storageBytes:0,activeJobCount:0};}
function reference(workspaceId:string,id:string):StyleReference{return {id,workspaceId,title:'Creator-supplied test instructions',purpose:'brand',kind:'document',text:'Keep captions readable.',notes:'Test fixture, not extracted style.',permission:'owned',analysisId:null,createdAt:timestamp,updatedAt:timestamp,version:1};}
function preset(workspaceId:string,id:string):StylePreset{return {id,workspaceId,name:'Creator-authored test preset',description:'Explicit store fixture',preferences:{captions:'Keep captions readable.'},settings:{pace:'balanced',targetShotSeconds:3,transition:'cut',captionPlacement:'lower',captionStyle:'minimal',aspectRatio:'9:16',colorMood:'',audioDirection:''},createdAt:timestamp,updatedAt:timestamp,updatedBy:'test-owner',version:1};}
function jobFor(ref:StyleReference):StoredJob{return {id:`style_${ref.id}`,workspaceId:ref.workspaceId,referenceId:ref.id,referenceVersion:ref.version,assetId:`style:${ref.id}`,type:'style_analysis',status:'queued',progress:0,stage:'Concurrency test only',attempts:0,maxAttempts:3,error:null,outputId:null,createdAt:timestamp,updatedAt:timestamp,version:1,slotReserved:true};}
function removeReference(ref:StyleReference){return store.commitCreativeWrites(ref.workspaceId,[],{versions:[{collection:'styleReferences',id:ref.id,version:ref.version}],inactiveJobIds:[`style_${ref.id}`]},[{collection:'styleReferences',id:ref.id}]);}

test('atomic creative limits count existing records and permit only the remaining slots',async()=>{
  const ws='creative-limits';await store.put('workspaces',workspace(ws));
  // Preexisting workspaces have no creative counters/revision. Their records
  // must count immediately without a destructive migration or a zero default.
  for(let i=0;i<99;i++)await store.put('styleReferences',reference(ws,`old-reference-${i}`));
  for(let i=0;i<49;i++)await store.put('stylePresets',preset(ws,`old-preset-${i}`));
  await store.put('styleReferences',reference('another-workspace','foreign-reference'));
  const create=(collection:'styleReferences'|'stylePresets',id:string)=>store.commitCreativeWrites(ws,[{collection,value:collection==='styleReferences'?reference(ws,id):preset(ws,id)}],{versions:[{collection,id,version:null}],createCollection:collection});
  const results=await Promise.allSettled([
    create('styleReferences','new-reference-1'),create('styleReferences','new-reference-2'),create('styleReferences','new-reference-3'),
    create('stylePresets','new-preset-1'),create('stylePresets','new-preset-2'),create('stylePresets','new-preset-3'),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,2);
  assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.code==='CREATIVE_LIMIT').length,4);
  assert.equal((await store.list('styleReferences','workspaceId',ws)).length,100);
  assert.equal((await store.list('stylePresets','workspaceId',ws)).length,50);
  assert.equal((await store.get<any>('workspaces',ws)).creativeRevision,2);
  assert.equal((await store.get<any>('workspaces',ws)).activeJobCount,0);
  await removeReference(reference(ws,'old-reference-0'));
  await create('styleReferences','replacement-reference');
  assert.equal((await store.list('styleReferences','workspaceId',ws)).length,100,'Removing source/reference records cannot leave a stale capacity counter');
});

test('reference deletion and analysis enqueue are mutually exclusive in both commit orderings',async()=>{
  const ws='creative-races';await store.put('workspaces',workspace(ws));
  const deletedFirst=reference(ws,'reference-delete-first');await store.put('styleReferences',deletedFirst);
  const staleInput=jobFor(deletedFirst);
  const deleteFirst=await Promise.allSettled([removeReference(deletedFirst),store.enqueueCreativeJob(staleInput)]);
  assert.equal(deleteFirst[0].status,'fulfilled');assert.equal(deleteFirst[1].status,'rejected');
  assert.equal(await store.get('styleReferences',deletedFirst.id),null);
  assert.equal(await store.get('jobs',staleInput.id),null,'A stale request cannot enqueue a job after reference removal');
  assert.equal((await store.get<any>('workspaces',ws)).activeJobCount,0);

  const enqueuedFirst=reference(ws,'reference-enqueue-first');await store.put('styleReferences',enqueuedFirst);
  const input=jobFor(enqueuedFirst);
  const queueFirst=await Promise.allSettled([store.enqueueCreativeJob(input),removeReference(enqueuedFirst)]);
  assert.equal(queueFirst[0].status,'fulfilled');assert.equal(queueFirst[1].status,'rejected');
  assert.ok(await store.get('styleReferences',enqueuedFirst.id));
  assert.equal((await store.get<any>('jobs',input.id)).status,'queued');
  assert.equal((await store.get<any>('workspaces',ws)).activeJobCount,1);
  await assert.rejects(store.enqueueCreativeJob(input),(error:any)=>error.code==='JOB_EXISTS');
  assert.equal((await store.get<any>('workspaces',ws)).activeJobCount,1);
  const claimed=await store.claimJob('creative-race-worker');assert.ok(claimed);assert.equal(claimed.id,input.id);
  await store.finishJob(input.id,'creative-race-worker',{status:'failed',stage:'Fixture complete; no model called'});
  await removeReference(enqueuedFirst);
  assert.equal((await store.get<any>('workspaces',ws)).activeJobCount,0);
  assert.equal(await store.get('styleReferences',enqueuedFirst.id),null);
});

test('atomic style enqueue rejects stale versions, foreign references and unavailable source videos',async()=>{
  const ws='creative-source-guards';await store.put('workspaces',workspace(ws));
  const stale=reference(ws,'stale-creative-reference');await store.put('styleReferences',{...stale,version:2});
  await assert.rejects(store.enqueueCreativeJob(jobFor(stale)),(error:any)=>error.code==='CREATIVE_VERSION_CONFLICT');
  const foreign=reference('foreign-workspace','foreign-creative-reference');await store.put('styleReferences',foreign);
  await assert.rejects(store.enqueueCreativeJob({...jobFor(foreign),workspaceId:ws}),(error:any)=>error.status===404);
  const video:StyleReference={...reference(ws,'deleted-source-reference'),kind:'video',text:undefined,assetId:'source-being-deleted'};
  await store.put('styleReferences',video);
  await store.put('assets',{id:video.assetId!,workspaceId:ws,deleting:true,version:1});
  await assert.rejects(store.enqueueCreativeJob(jobFor(video)),(error:any)=>error.code==='CREATIVE_VERSION_CONFLICT');
  assert.equal((await store.get<any>('workspaces',ws)).activeJobCount,0,'Rejected enqueue operations never consume workspace quota');
  assert.equal((await store.list('jobs','workspaceId',ws)).length,0);

  const source={id:'immutable-source-guard',workspaceId:ws,sha256:'original-source-digest',storageKey:'private/original/source',version:1,status:'uploaded',deleting:false};
  await store.put('assets',source);
  const guard={collection:'assets' as const,id:source.id,sourceSha256:source.sha256,storageKey:source.storageKey};
  const output=(id:string)=>({collection:'auditLogs',value:{id,workspaceId:ws,action:'Source-guard fixture only'}});
  await store.put('assets',{...source,version:2,status:'ready',metadata:{durationSeconds:6}});
  await store.commitCreativeWrites(ws,[output('metadata-only-change-accepted')],{versions:[guard]});
  assert.ok(await store.get('auditLogs','metadata-only-change-accepted'),'Metadata/status revisions do not invalidate an unchanged original source');
  for(const [name,patch] of [
    ['changed-digest',{sha256:'replacement-source-digest'}],
    ['changed-storage-key',{storageKey:'private/replacement/source'}],
    ['source-being-deleted',{deleting:true}],
  ] as const){
    await store.put('assets',{...source,...patch,version:3});
    await assert.rejects(store.commitCreativeWrites(ws,[output(name)],{versions:[guard]}),(error:any)=>error.code==='CREATIVE_VERSION_CONFLICT');
    assert.equal(await store.get('auditLogs',name),null,'Rejected source changes cannot persist any output');
  }
});
