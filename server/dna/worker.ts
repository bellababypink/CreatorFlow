import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { store, type Write } from '../store.js';
import type { StoredAsset, StoredJob } from '../models.js';
import { materializeFile } from '../storage.js';
import { inspectMedia } from '../processing/media.js';
import { ProcessingError } from '../processing/errors.js';
import { HttpError } from '../errors.js';
import type { ReferenceAnalysis, ShotMeasurements, StyleReference } from '../../shared/dna.js';
import { analyzeStyleReference, measureShots } from './processing.js';
import { now, referenceFor, usableAsset } from './service.js';

/** Reference, source, output and quota release commit together under the worker lease. */
export async function processDNAJob(job:StoredJob,workerId:string){
  const workDir=path.join(config.dataDir,'tmp',`style-${job.id}-${workerId}`);
  await mkdir(workDir,{recursive:true,mode:0o700});
  let reference:StyleReference|undefined,asset:StoredAsset|undefined,measurements:ShotMeasurements|null=null;
  const progress=(progress:number,stage:string)=>store.progressJob(job.id,workerId,{progress,stage});
  const save=async(result:Omit<ReferenceAnalysis,'id'|'workspaceId'|'referenceId'|'referenceVersion'|'assetId'|'createdAt'|'version'>,blockedError?:ProcessingError)=>{
    if(!reference)throw new Error('Reference missing.');
    const analysis:ReferenceAnalysis={...result,id:randomUUID(),workspaceId:job.workspaceId,referenceId:reference.id,referenceVersion:reference.version+1,...(asset?{assetId:asset.id}:{}),createdAt:now(),version:1};
    const next={...reference,analysisId:analysis.id,version:reference.version+1,updatedAt:now()};
    const writes:Write[]=[{collection:'styleAnalyses',value:analysis},{collection:'styleReferences',value:next}];
    if(result.model)writes.push({collection:'usage',value:{id:randomUUID(),workspaceId:job.workspaceId,jobId:job.id,referenceId:reference.id,provider:'gemini',model:result.model,videoSeconds:measurements?.durationSeconds||0,inputBytes:asset?.sizeBytes||Buffer.byteLength(reference.text||'','utf8'),tokens:result.usage||{},costStatus:'unpriced',createdAt:now()}});
    await store.commitCreativeWrites(job.workspaceId,writes,{versions:[{collection:'styleReferences',id:reference.id,version:reference.version},...(asset?[{collection:'assets' as const,id:asset.id,sourceSha256:asset.sha256,storageKey:asset.storageKey}]:[])],jobId:job.id,workerId,
      completion:{status:blockedError?(blockedError.code==='CONFIGURATION_REQUIRED'?'blocked_configuration':'failed'):'completed',progress:100,stage:blockedError?'Technical measurements saved; style extraction incomplete':'Reference style analysis saved',error:blockedError?.message||null,outputId:analysis.id}});
  };
  try{
    reference=await referenceFor(job.workspaceId,job.referenceId||'');
    if(reference.version!==job.referenceVersion)throw new HttpError(409,'The reference changed after this analysis was queued. Request a new analysis.','CREATIVE_VERSION_CONFLICT');
    if(reference.kind==='link')throw new ProcessingError('REFERENCE_UPLOAD_REQUIRED','Supply an authorized video or document before analyzing this saved link.');
    let filePath:string|undefined,metadata;
    if(reference.kind==='video'){
      asset=await usableAsset(job.workspaceId,reference.assetId||'');
      await progress(5,'Inspecting authorized reference video');
      filePath=await materializeFile(asset.storageKey,path.join(workDir,'source'));
      metadata=await inspectMedia(filePath);
      await progress(15,'Measuring scene changes with FFmpeg');
      measurements=await measureShots(filePath,metadata);
    }
    const result=await analyzeStyleReference({reference,filePath,metadata,mimeType:asset?.mimeType,measurements,onProgress:progress});
    await save(result);
  }catch(error){
    const typed=error instanceof ProcessingError?error:null;
    const blocked=typed?.code==='CONFIGURATION_REQUIRED';
    const retry=!!typed?.retryable&&!blocked&&job.attempts<job.maxAttempts;
    console.error(`Style job ${job.id}: ${typed?.code||(error instanceof HttpError?error.code:'STYLE_WORKER_ERROR')}`);
    if(retry){await store.progressJob(job.id,workerId,{status:'queued',stage:'Waiting to retry reference analysis',error:typed!.message,leaseUntil:null,nextAttemptAt:new Date(Date.now()+2**job.attempts*5000).toISOString()});}
    else if(measurements&&reference&&typed){
      try{await save({status:'measured_only',summary:'Technical scene-change measurements are available. AI creative patterns have not been extracted.',patterns:[],characteristics:[],measurements,limitations:[typed.message,...measurements.limitations],model:null,timestampPrecision:'approximate'},typed);}
      catch{await store.finishJob(job.id,workerId,{status:'failed',stage:'Reference or source changed',error:'The reference or source changed during analysis. Refresh and try again.'});}
    }else{
      await store.finishJob(job.id,workerId,{status:blocked?'blocked_configuration':'failed',stage:blocked?'Style analysis needs configuration':'Reference analysis failed',error:typed?.message||(error instanceof HttpError?error.message:'Style analysis could not finish. No inferred preferences were saved.')});
    }
  }finally{await rm(workDir,{recursive:true,force:true});}
}
