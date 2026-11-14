import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { DNAOverview, DNAProfile, EditingSettings, ProductionProject, ReferenceAnalysis, StylePreset, StyleReference } from '../shared/dna.js';

// Real HTTP and durable SQLite tests with isolated identities. Seeded analysis
// below is explicitly a validation fixture, never a live Gemini result.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'creatorflow-dna-http-'));
Object.assign(process.env, { APP_MODE:'local', NODE_ENV:'test', CF_DATA_DIR:dataDir,
  APP_ORIGIN:'http://localhost:5173', GEMINI_API_KEY:'', WORKSPACE_MAX_ACTIVE_JOBS:'3' });
const { app } = await import('../server/app.js');
const { store } = await import('../server/store.js');
const { processDNAJob } = await import('../server/dna/worker.js');
let server:Server, base:string;
before(async () => {
  server = await new Promise<Server>((resolve,reject) => {
    const listening = app.listen(0,'127.0.0.1',()=>resolve(listening));
    listening.once('error',reject);
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server?.listening) { server.closeAllConnections(); await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
  await rm(dataDir,{recursive:true,force:true});
});
async function request(route:string, options:{method?:string;body?:unknown;cookie?:string;origin?:string}={}) {
  const headers:Record<string,string>={};
  if(options.body!==undefined)headers['Content-Type']='application/json';
  if(options.cookie)headers.Cookie=options.cookie;
  if(options.origin)headers.Origin=options.origin;
  const response=await fetch(base+route,{method:options.method||'GET',headers,...(options.body!==undefined?{body:JSON.stringify(options.body)}:{})});
  const text=await response.text();
  return {status:response.status,data:response.headers.get('content-type')?.includes('application/json')&&text?JSON.parse(text):text,response};
}
async function signup(name:string,email:string) {
  const result=await request('/api/auth/signup',{method:'POST',body:{name,email,password:'isolated-dna-test-password'}});
  assert.equal(result.status,201);
  const cookie=result.response.headers.getSetCookie().find(c=>c.startsWith('creatorflow_session='))?.split(';')[0];
  assert.ok(cookie);
  return {id:result.data.user.id as string,cookie};
}
const settings:EditingSettings={pace:'gentle',targetShotSeconds:4,transition:'dissolve',captionPlacement:'lower',captionStyle:'minimal',aspectRatio:'9:16',colorMood:'Warm cream and muted greens',audioDirection:'Original quiet ambience; no unlicensed music'};

test('Creator DNA preserves creator authority, reusable preset revisions and workspace isolation',async t=>{
  let owner:Awaited<ReturnType<typeof signup>>, stranger:Awaited<ReturnType<typeof signup>>, member:Awaited<ReturnType<typeof signup>>;
  let workspaceId='',otherWorkspaceId='';
  let profile:DNAProfile, reference:StyleReference, preset:StylePreset, project:ProductionProject;
  const root=(suffix='')=>`/api/workspaces/${workspaceId}/dna${suffix}`;
  const mutate=(suffix:string,body:unknown,method='POST',cookie?:string)=>request(root(suffix),{method,body,cookie:cookie||owner.cookie});
  const overview=async()=>(await request(root(),{cookie:owner.cookie})).data as DNAOverview;

  await t.test('new DNA is empty, legacy creator-confirmed values survive and every route is private',async()=>{
    assert.equal((await request('/api/workspaces/unknown/dna')).status,401);
    owner=await signup('DNA Owner','dna-owner@example.test');
    stranger=await signup('DNA Stranger','dna-stranger@example.test');
    member=await signup('DNA Collaborator','dna-member@example.test');
    const created=await request('/api/workspaces',{method:'POST',cookie:owner.cookie,body:{name:'DNA isolation A',niches:['Reading'],platforms:['youtube']}});
    assert.equal(created.status,201);workspaceId=created.data.id;
    const other=await request('/api/workspaces',{method:'POST',cookie:stranger.cookie,body:{name:'DNA isolation B'}});
    assert.equal(other.status,201);otherWorkspaceId=other.data.id;
    const legacy=await request(`/api/workspaces/${workspaceId}`,{method:'PATCH',cookie:owner.cookie,body:{brandStyle:{voice:'Warm, thoughtful and concise',audience:'Readers creating a slower routine',editingPace:'Unhurried',preferences:'Avoid flashing overlays',colors:['#eee6dc'],source:'user_confirmed'}}});
    assert.equal(legacy.status,200);
    const first=await request(root(),{cookie:owner.cookie});
    assert.equal(first.status,200);assert.match(first.response.headers.get('cache-control')||'',/private.*no-store/);
    const data=first.data as DNAOverview;profile=data.profile;
    assert.equal(profile.version,0);
    assert.equal(profile.preferences.voice,'Warm, thoughtful and concise');
    assert.equal(profile.provenance.voice?.source,'legacy');
    assert.equal(data.geminiConfigured,false);
    for(const key of ['references','analyses','presets','projects','jobs'] as const)assert.deepEqual(data[key],[]);
    assert.equal((await request(root(),{cookie:stranger.cookie})).status,403);
    assert.equal((await request(root('/profile'),{method:'PATCH',cookie:owner.cookie,origin:'https://untrusted.example',body:{expectedVersion:0,preferences:{voice:'CSRF'}}})).status,403);
    // Recover the current version without relying on a cache or browser state.
    profile=(await overview()).profile;
    await store.put('memberships',{id:`${workspaceId}_${member.id}`,workspaceId,userId:member.id,role:'viewer'});
    assert.equal((await request(root(),{cookie:member.cookie})).status,200);
    assert.equal((await mutate('/profile',{expectedVersion:profile.version,preferences:{voice:'Viewer edit'}},'PATCH',member.cookie)).status,403);
  });

  await t.test('profile edits are explicit, optimistic and lockable without promoting AI patterns',async()=>{
    const update=await mutate('/profile',{expectedVersion:profile.version,preferences:{...profile.preferences,voice:'Creator-approved calm voice',pillars:'Books; daily rituals',typography:'Readable humanist sans serif',rhythm:'Hold meaningful moments; no flashing cuts'}},'PATCH');
    assert.equal(update.status,200);profile=update.data.profile;
    assert.equal(profile.provenance.voice?.source,'creator');
    const stale=await mutate('/profile',{expectedVersion:profile.version-1,preferences:{voice:'Stale writer'}},'PATCH');
    assert.equal(stale.status,409);
    assert.equal((await mutate('/profile',{expectedVersion:profile.version,preferences:{unknown:'Invalid section'}},'PATCH')).status,400);
    const locked=await mutate('/profile/lock',{expectedVersion:profile.version,locked:true});
    assert.equal(locked.status,200);profile=locked.data.profile;
    assert.equal(profile.status,'locked');assert.ok(profile.lockedAt);
    assert.equal((await mutate('/profile',{expectedVersion:profile.version,preferences:{voice:'Forbidden overwrite'}},'PATCH')).status,409);
    await store.put('memberships',{id:`${workspaceId}_${member.id}`,workspaceId,userId:member.id,role:'editor'});
    assert.equal((await mutate('/profile/lock',{expectedVersion:profile.version,locked:false},'POST',member.cookie)).status,403);
    const unlocked=await mutate('/profile/lock',{expectedVersion:profile.version,locked:false});
    assert.equal(unlocked.status,200);profile=unlocked.data.profile;
    assert.equal(profile.status,'draft');
    const guide=await request(root('/guide'),{cookie:owner.cookie});
    assert.equal(guide.status,200);assert.match(guide.response.headers.get('content-disposition')||'',/attachment/);
    assert.match(guide.data,/Creator-approved calm voice/);
    assert.match(guide.data,/Readable humanist sans serif/);
  });

  await t.test('reference library saves permitted links and documents without pretending to access a video',async()=>{
    const bad=await mutate('/references',{title:'Unsafe URL',purpose:'inspiration',kind:'link',url:'file:///etc/passwd',notes:'',permission:'link_only'});
    assert.equal(bad.status,422);
    assert.equal((await mutate('/references',{title:'Unpermitted video',purpose:'inspiration',kind:'video',assetId:'missing',notes:'',permission:'link_only'})).status,422);
    const link=await mutate('/references',{title:'Saved public reference',purpose:'inspiration',kind:'link',url:'https://www.youtube.com/@reference-fixture',notes:'A saved link only; no access permission implied',permission:'link_only'});
    assert.equal(link.status,201);reference=link.data.reference;
    assert.equal(reference.analysisId,null);
    const analyzed=await mutate(`/references/${reference.id}/analyze`,{});
    assert.equal(analyzed.status,422);assert.equal(analyzed.data.error.code,'REFERENCE_UPLOAD_REQUIRED');
    assert.equal((await overview()).analyses.length,0);
    const foreign=await request(`/api/workspaces/${otherWorkspaceId}/dna/references/${reference.id}/analyze`,{method:'POST',cookie:stranger.cookie,body:{}});
    assert.equal(foreign.status,404);
    assert.equal((await mutate('/references',{title:'Instructions',purpose:'brand',kind:'document',text:'a'.repeat(60_000),notes:'',permission:'owned'})).status,400);
    const document=await mutate('/references',{title:'Creator-written brand instructions',purpose:'brand',kind:'document',text:'Use a clear voice. Keep captions readable. Prefer original ambience.',notes:'This is supplied text, not automatically approved DNA.',permission:'owned'});
    assert.equal(document.status,201);
    assert.equal((await overview()).profile.preferences.voice,'Creator-approved calm voice');
    const job=await mutate(`/references/${document.data.reference.id}/analyze`,{});
    assert.equal(job.status,202);assert.equal(job.data.job.type,'style_analysis');
    assert.equal(job.data.job.status,'queued');
    assert.equal((await mutate(`/references/${document.data.reference.id}/analyze`,{})).status,409);
    // Run the real worker with deliberately missing configuration, not a mock
    // model response or a manually fabricated successful analysis.
    const claimed=await store.claimJob('dna-http-fixture-worker');assert.ok(claimed);
    assert.equal(claimed.id,job.data.job.id);
    await processDNAJob(claimed,'dna-http-fixture-worker');
    const blocked=await store.get<any>('jobs',claimed.id);
    assert.equal(blocked.status,'blocked_configuration');assert.match(blocked.error,/GEMINI_API_KEY/);
    assert.equal((await store.get<any>('workspaces',workspaceId)).activeJobCount,0,'Blocked style processing releases its workspace slot');
    assert.equal((await overview()).analyses.length,0,'An unconfigured queued reference cannot create inferred preferences');
  });

  await t.test('a real reference video retains measured rhythm without inventing Gemini style findings',async subtest=>{
    const projectDir=fileURLToPath(new URL('../',import.meta.url));
    const binary=(name:'ffmpeg'|'ffprobe')=>{
      const configured=process.env[name==='ffmpeg'?'FFMPEG_PATH':'FFPROBE_PATH'];
      if(configured&&configured!==name)return configured.includes(path.sep)?path.resolve(projectDir,configured):configured;
      const local=path.join(projectDir,'.tools',name);return existsSync(local)?local:name;
    };
    const ffmpeg=binary('ffmpeg'),ffprobe=binary('ffprobe'),run=promisify(execFile);
    try{await Promise.all([run(ffmpeg,['-version'],{timeout:5000}),run(ffprobe,['-version'],{timeout:5000})]);}
    catch{subtest.skip('Real style worker verification requires working FFmpeg and FFprobe.');return;}
    Object.assign(process.env,{FFMPEG_PATH:ffmpeg,FFPROBE_PATH:ffprobe});
    const fixturePath=path.join(dataDir,'authorized-style-worker-fixture.mp4');
    await run(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=0x796f65:s=180x320:r=24','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-y',fixturePath],{timeout:20000});
    const {inspectMedia}=await import('../server/processing/media.js');
    const {putFile}=await import('../server/storage.js');
    const metadata=await inspectMedia(fixturePath),timestamp=new Date().toISOString(),assetId='real-style-worker-asset';
    const storageKey=`workspaces/${workspaceId}/originals/${assetId}/source`;
    await putFile(storageKey,fixturePath,'video/mp4');
    await store.put('assets',{id:assetId,workspaceId,uploadedBy:owner.id,originalName:'authorized-style-worker-fixture.mp4',mimeType:'video/mp4',sizeBytes:metadata.sizeBytes,status:'uploaded',metadata,thumbnailReady:false,analysisId:null,storageKey,sha256:'real-style-fixture',createdAt:timestamp,updatedAt:timestamp,version:1});
    const created=await mutate('/references',{title:'Generated real MP4 for worker acceptance',purpose:'own_work',kind:'video',assetId,notes:'Synthetic solid-colour test footage; no creator content or model result.',permission:'owned'});
    assert.equal(created.status,201);
    const requested=await mutate(`/references/${created.data.reference.id}/analyze`,{});assert.equal(requested.status,202);
    const claimed=await store.claimJob('real-style-worker');assert.ok(claimed);assert.equal(claimed.id,requested.data.job.id);
    await processDNAJob(claimed,'real-style-worker');
    const result=await overview(),job=result.jobs.find(j=>j.id===claimed.id),analysis=result.analyses.find(a=>a.referenceId===created.data.reference.id);
    assert.equal(job?.status,'blocked_configuration');assert.match(job?.error||'',/GEMINI_API_KEY/);
    assert.ok(analysis);assert.equal(analysis.status,'measured_only');assert.equal(job.outputId,analysis.id);
    assert.equal(analysis.model,null);assert.deepEqual(analysis.patterns,[]);assert.deepEqual(analysis.characteristics,[]);
    assert.equal(analysis.measurements?.durationSeconds,2);assert.equal(analysis.measurements.averageShotSeconds,2);
    assert.deepEqual(analysis.measurements.cutSeconds,[]);assert.equal(analysis.measurements.method,'ffmpeg_scene_threshold');
    assert.ok(analysis.measurements.limitations.length>0);assert.ok(analysis.limitations.some(l=>/GEMINI_API_KEY/.test(l)));
    const current=result.references.find(r=>r.id===created.data.reference.id);assert.ok(current);
    assert.equal(current.version,analysis.referenceVersion);assert.equal(current.analysisId,analysis.id);
    assert.equal((await store.get<any>('workspaces',workspaceId)).activeJobCount,0);
    assert.equal((await mutate('/profile/adopt',{expectedVersion:profile.version,analysisId:analysis.id,patternIndex:0})).status,409,'Measurements-only output cannot become an inferred approved brand rule');
    const reopened=await overview();assert.deepEqual(reopened.analyses.find(a=>a.id===analysis.id)?.measurements,analysis.measurements);
    const deleted=await request(`/api/workspaces/${workspaceId}/assets/${assetId}`,{method:'DELETE',cookie:owner.cookie});
    assert.equal(deleted.status,200);
    const afterDelete=await overview();
    assert.equal(afterDelete.references.some(r=>r.id===created.data.reference.id),false,'Deleting a source video removes its library reference');
    assert.equal(afterDelete.analyses.some(a=>a.id===analysis.id),false,'Deleting a source video removes its derived style evidence');
    assert.equal(afterDelete.profile.version,profile.version,'Source deletion does not rewrite independently approved preferences');
  });

  await t.test('creative commits fence changed references and stale workers and release a slot exactly once',async()=>{
    const timestamp=new Date().toISOString();
    const job={id:'dna-guard-job',workspaceId,assetId:`style:${reference.id}`,referenceId:reference.id,referenceVersion:reference.version,type:'style_analysis' as const,status:'queued' as const,progress:0,stage:'Guard test',attempts:0,maxAttempts:3,createdAt:timestamp,updatedAt:timestamp,version:1,slotReserved:true};
    await store.enqueueChannelJob(job);const claimed=await store.claimJob('dna-guard-worker-1');assert.ok(claimed);assert.equal(claimed.id,job.id);
    const marker={collection:'auditLogs',value:{id:'dna-guard-marker',workspaceId,action:'Explicit guard-test marker',createdAt:timestamp}};
    const guard={collection:'styleReferences',id:reference.id,version:reference.version};
    await assert.rejects(store.commitCreativeWrites(workspaceId,[marker],{versions:[{...guard,version:reference.version+1}],jobId:job.id,workerId:'dna-guard-worker-1',completion:{status:'completed',progress:100}}),/changed/);
    assert.equal(await store.get('auditLogs',marker.value.id),null);
    assert.equal((await store.get<any>('workspaces',workspaceId)).activeJobCount,1,'Rejected output must not release a live job slot');
    await assert.rejects(store.commitCreativeWrites(workspaceId,[{...marker,value:{...marker.value,workspaceId:otherWorkspaceId}}],{versions:[guard],jobId:job.id,workerId:'dna-guard-worker-1'}),/workspace write/);
    await store.put('jobs',{...claimed,leaseUntil:new Date(Date.now()-1000).toISOString()});
    await assert.rejects(store.commitCreativeWrites(workspaceId,[marker],{versions:[guard],jobId:job.id,workerId:'dna-guard-worker-1',completion:{status:'completed'}}),/lease/);
    assert.equal(await store.get('auditLogs',marker.value.id),null);
    const recovered=await store.claimJob('dna-guard-worker-2');assert.ok(recovered);assert.equal(recovered.id,job.id);
    await assert.rejects(store.commitCreativeWrites(workspaceId,[marker],{versions:[guard],jobId:job.id,workerId:'dna-guard-worker-1',completion:{status:'completed'}}),/lease/);
    await store.commitCreativeWrites(workspaceId,[marker],{versions:[guard],jobId:job.id,workerId:'dna-guard-worker-2',completion:{status:'failed',stage:'Guard acceptance complete',error:'Intentional guard-only fixture; no AI result.'}});
    assert.ok(await store.get('auditLogs',marker.value.id));
    assert.equal((await store.get<any>('workspaces',workspaceId)).activeJobCount,0);
    await assert.rejects(store.commitCreativeWrites(workspaceId,[marker],{versions:[guard],jobId:job.id,workerId:'dna-guard-worker-2',completion:{status:'completed'}}),/lease/);
    await store.finishJob(job.id,'dna-guard-worker-2',{status:'completed'});
    assert.equal((await store.get<any>('workspaces',workspaceId)).activeJobCount,0,'Completion replay cannot double-release workspace quota');
    assert.equal((await store.get<any>('jobs',job.id)).status,'failed','A finished job cannot be resurrected by a stale completion');
  });

  await t.test('only explicitly adopted current evidence becomes an approved preference',async()=>{
    // Purposefully seeded fixture isolates adoption rules from the paid model.
    // It does not assert that Gemini identified this style in a real video.
    const now=new Date().toISOString();
    const source:StyleReference={id:'adoption-source',workspaceId,title:'Explicit adoption validation fixture',purpose:'own_work',kind:'document',text:'Fixture written instructions',notes:'',permission:'owned',analysisId:'adoption-analysis',createdAt:now,updatedAt:now,version:1};
    const analysis:ReferenceAnalysis={id:'adoption-analysis',workspaceId,referenceId:source.id,referenceVersion:1,status:'complete',summary:'Explicit validation fixture',patterns:[{dimension:'captions',observation:'The fixture requests legible lower captions.',suggestedPreference:'High-contrast captions in the lower safe area',confidence:'medium',evidence:'Creator-written fixture sentence'}],characteristics:[],measurements:null,limitations:['Synthetic validation fixture, not live model output.'],model:'test-fixture-only',createdAt:now,version:1,timestampPrecision:'approximate'};
    await store.put('styleReferences',source);await store.put('styleAnalyses',analysis);
    assert.notEqual((await overview()).profile.preferences.captions,analysis.patterns[0].suggestedPreference);
    const adopted=await mutate('/profile/adopt',{expectedVersion:profile.version,analysisId:analysis.id,patternIndex:0});
    assert.equal(adopted.status,200);profile=adopted.data.profile;
    assert.equal(profile.preferences.captions,analysis.patterns[0].suggestedPreference);
    assert.deepEqual(profile.provenance.captions,{source:'adopted_pattern',referenceId:source.id,analysisId:analysis.id});
    const editedOtherSection=await mutate('/profile',{expectedVersion:profile.version,preferences:{...profile.preferences,personality:'Curious, calm and welcoming'}},'PATCH');
    assert.equal(editedOtherSection.status,200);profile=editedOtherSection.data.profile;
    assert.deepEqual(profile.provenance.captions,{source:'adopted_pattern',referenceId:source.id,analysisId:analysis.id},'Editing a different section preserves adopted-evidence traceability');
    assert.equal((await mutate('/profile/adopt',{expectedVersion:profile.version,analysisId:analysis.id,patternIndex:5})).status,409);
    const foreignAnalysis={...analysis,id:'foreign-analysis',workspaceId:otherWorkspaceId};await store.put('styleAnalyses',foreignAnalysis);
    assert.equal((await mutate('/profile/adopt',{expectedVersion:profile.version,analysisId:foreignAnalysis.id,patternIndex:0})).status,404);
    await store.put('styleReferences',{...source,version:2});
    assert.equal((await mutate('/profile/adopt',{expectedVersion:profile.version,analysisId:analysis.id,patternIndex:0})).status,409);
  });

  await t.test('presets keep immutable revisions, restore as a new revision and reject foreign IDs',async()=>{
    const created=await mutate('/presets',{name:'Original reading vignette',description:'Creator-written preset for the integration test',preferences:{voice:'A quiet first-person journal',palette:'#f7f1e8, #77806b'},settings});
    assert.equal(created.status,201);preset=created.data.preset;
    assert.equal(preset.version,1);
    const edited=await mutate(`/presets/${preset.id}`,{expectedVersion:preset.version,name:preset.name,description:preset.description,preferences:{...preset.preferences,voice:'Updated direct narration'},settings:{...settings,pace:'brisk',targetShotSeconds:1.5}},'PATCH');
    assert.equal(edited.status,200);preset=edited.data.preset;assert.equal(preset.version,2);
    assert.equal((await mutate(`/presets/${preset.id}`,{expectedVersion:1,name:'Stale edit',description:'',preferences:{},settings},'PATCH')).status,409);
    const revisions=await request(root(`/presets/${preset.id}/revisions`),{cookie:owner.cookie});
    assert.equal(revisions.status,200);assert.equal(revisions.data.revisions.length,2);
    assert.equal(revisions.data.revisions.find((r:any)=>r.revision===1).preferences.voice,'A quiet first-person journal');
    const restored=await mutate(`/presets/${preset.id}/restore`,{expectedVersion:2,revision:1});
    assert.equal(restored.status,200);preset=restored.data.preset;assert.equal(preset.version,3);
    assert.equal(preset.preferences.voice,'A quiet first-person journal');assert.equal(preset.settings.targetShotSeconds,4);
    const history=await request(root(`/presets/${preset.id}/revisions`),{cookie:owner.cookie});
    assert.equal(history.data.revisions.length,3);assert.equal(history.data.revisions.find((r:any)=>r.revision===2).settings.pace,'brisk');
    assert.equal((await request(`/api/workspaces/${otherWorkspaceId}/dna/presets/${preset.id}/revisions`,{cookie:stranger.cookie})).status,404);
    const foreignRestore=await request(`/api/workspaces/${otherWorkspaceId}/dna/presets/${preset.id}/restore`,{method:'POST',cookie:stranger.cookie,body:{expectedVersion:3,revision:1}});
    assert.equal(foreignRestore.status,404);
    assert.equal((await mutate('/presets',{name:'Invalid timing',description:'',preferences:{},settings:{...settings,targetShotSeconds:-2}})).status,400);
    await store.put('memberships',{id:`${workspaceId}_${member.id}`,workspaceId,userId:member.id,role:'viewer'});
    assert.equal((await mutate('/presets',{name:'Viewer preset',description:'',preferences:{},settings},'POST',member.cookie)).status,403);
  });

  await t.test('production briefs resolve approved DNA and pin immutable context through future edits and restart',async()=>{
    const now=new Date().toISOString();
    const asset=(id:string,ws:string)=>({id,workspaceId:ws,uploadedBy:owner.id,originalName:'authorization-only-fixture.mp4',mimeType:'video/mp4',sizeBytes:0,status:'uploaded',metadata:null,thumbnailReady:false,analysisId:null,storageKey:`workspaces/${ws}/originals/${id}/source`,sha256:id,createdAt:now,updatedAt:now,version:1});
    await store.put('assets',asset('dna-local-asset',workspaceId));await store.put('assets',asset('dna-foreign-asset',otherWorkspaceId));
    assert.equal((await mutate('/projects',{title:'Invalid source',presetId:preset.id,assetIds:['dna-foreign-asset']})).status,404);
    assert.equal((await mutate('/projects',{title:'Invalid preset',presetId:'foreign-preset',assetIds:[]})).status,404);
    const context=await request(root(`/context?presetId=${preset.id}`),{cookie:owner.cookie});
    assert.equal(context.status,200);
    assert.equal(context.data.context.preferences.voice,preset.preferences.voice);
    assert.equal(context.data.context.preferences.captions,profile.preferences.captions);
    const created=await mutate('/projects',{title:'First real production brief',presetId:preset.id,assetIds:['dna-local-asset']});
    assert.equal(created.status,201);project=created.data.project;
    assert.equal(project.status,'brief');assert.deepEqual(project.assetIds,['dna-local-asset']);
    assert.equal(project.creativeContext.presetId,preset.id);assert.equal(project.creativeContext.presetVersion,3);
    assert.equal(project.creativeContext.profileVersion,profile.version);
    assert.equal(project.creativeContext.preferences.voice,'A quiet first-person journal');
    const pinned=structuredClone(project.creativeContext);
    const changed=await mutate('/profile',{expectedVersion:profile.version,preferences:{...profile.preferences,captions:'A newly approved caption rule'}},'PATCH');
    assert.equal(changed.status,200);profile=changed.data.profile;
    const changedPreset=await mutate(`/presets/${preset.id}`,{expectedVersion:3,name:preset.name,description:preset.description,preferences:{voice:'New preset voice'},settings},'PATCH');
    assert.equal(changedPreset.status,200);preset=changedPreset.data.preset;
    const reopened=await overview();assert.deepEqual(reopened.projects.find(p=>p.id===project.id)?.creativeContext,pinned);
    assert.equal((await request(root('/context'),{cookie:owner.cookie})).data.context.preferences.captions,'A newly approved caption rule');
    const childScript=`const {store}=await import('./server/store.ts');const item=await store.get('productionProjects',${JSON.stringify(project.id)});process.stdout.write(JSON.stringify(item));`;
    const independent=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',childScript],{cwd:process.cwd(),env:{...process.env},timeout:15000});
    assert.deepEqual(JSON.parse(independent.stdout).creativeContext,pinned,'A fresh process must reopen the saved project and exact style revision');
    const guide=await request(root('/guide'),{cookie:owner.cookie});assert.match(guide.data,/A newly approved caption rule/);
    assert.equal((await request(root('/context'),{cookie:stranger.cookie})).status,403);
  });

  await t.test('exports include DNA records and deletion purges only the selected workspace',async()=>{
    const exported=await request(`/api/workspaces/${workspaceId}/export`,{cookie:owner.cookie});
    assert.equal(exported.status,200);
    for(const collection of ['dnaProfiles','dnaProfileRevisions','styleReferences','styleAnalyses','stylePresets','stylePresetRevisions','productionProjects']) {
      assert.ok(Array.isArray(exported.data[collection]),`${collection} belongs in a portable workspace export`);
      assert.ok(exported.data[collection].length>0,`${collection} export contains persisted records`);
      assert.ok(exported.data[collection].every((row:any)=>row.workspaceId===workspaceId));
    }
    assert.equal((await request(`/api/workspaces/${workspaceId}/export`,{cookie:member.cookie})).status,403);
    const removed=await mutate(`/references/${reference.id}`,{expectedVersion:reference.version},'DELETE');assert.equal(removed.status,200);
    assert.equal((await overview()).references.some(r=>r.id===reference.id),false);
    const wrongConfirmation=await request(`/api/workspaces/${workspaceId}`,{method:'DELETE',cookie:owner.cookie,body:{confirmation:'wrong name'}});assert.equal(wrongConfirmation.status,400);
    const deleted=await request(`/api/workspaces/${workspaceId}`,{method:'DELETE',cookie:owner.cookie,body:{confirmation:'DNA isolation A'}});assert.equal(deleted.status,200);
    for(const collection of ['dnaProfiles','dnaProfileRevisions','styleReferences','styleAnalyses','stylePresets','stylePresetRevisions','productionProjects'])assert.deepEqual(await store.list(collection,'workspaceId',workspaceId),[],collection);
    assert.ok(await store.get('workspaces',otherWorkspaceId),'A different creator workspace survives deletion');
    assert.ok(await store.get('styleAnalyses','foreign-analysis'),'Other tenant evidence is not purged');
    assert.equal((await request(root(),{cookie:owner.cookie})).status,403);
  });
});
