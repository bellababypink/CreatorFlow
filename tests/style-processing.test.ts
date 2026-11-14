import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { analyzeStyleReference,measurementsFromLog,measureShots,STYLE_CHARACTERISTICS,validateStyleOutput } from '../server/dna/processing.js';
import { inspectMedia } from '../server/processing/media.js';
import type { StyleReference } from '../shared/dna.js';
import type { MediaMetadata } from '../shared/types.js';

const execFileAsync=promisify(execFile);
const projectDir=fileURLToPath(new URL('../',import.meta.url));
const metadata:MediaMetadata={durationSeconds:6,width:96,height:160,fps:24,aspectRatio:'3:5',orientation:'portrait',hasAudio:false,videoCodec:'h264',format:'mov,mp4,m4a,3gp,3g2,mj2',sizeBytes:1000};
const reference:StyleReference={id:'ref-1',workspaceId:'ws-1',title:'Authorized synthetic edit',purpose:'own_work',kind:'video',assetId:'asset-1',notes:'',permission:'owned',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1};
function output(){return {summary:'Three contrasting static frames.',patterns:[{dimension:'rhythm',observation:'Strong visual changes.',suggestedPreference:'Use a small number of hard cuts.',confidence:'medium',evidence:'Dark frame changes to a light frame.',startSeconds:0.8,endSeconds:1.2}],characteristics:STYLE_CHARACTERISTICS.map(name=>({name,observation:'Not observable in this synthetic sample.',evidence:'The supplied clip contains no demonstrable example.',confidence:'low'})),limitations:['Synthetic sample only.']};}
function binary(name:'ffmpeg'|'ffprobe'){
  const configured=process.env[name==='ffmpeg'?'FFMPEG_PATH':'FFPROBE_PATH'];
  if(configured)return configured.includes(path.sep)?path.resolve(projectDir,configured):configured;
  const local=path.join(projectDir,'.tools',name);return existsSync(local)?local:name;
}

test('scene measurement parser uses source frame timestamps and never model estimates',()=>{
  const measured=measurementsFromLog('[Parsed_showinfo_3 @ 0x0] n:0 pts:24 pts_time:1 pos:1\n[Parsed_showinfo_3 @ 0x0] n:1 pts:72 pts_time:3 pos:2\n',metadata);
  assert.deepEqual(measured.cutSeconds,[1,3]);assert.deepEqual(measured.shotDurations,[1,2,3]);
  assert.equal(measured.averageShotSeconds,2);assert.equal(measured.medianShotSeconds,2);
  assert.equal(measured.shortestShotSeconds,1);assert.equal(measured.longestShotSeconds,3);
  assert.equal(measured.method,'ffmpeg_scene_threshold');assert.ok(measured.limitations.some(item=>item.includes('Flashes')));
  assert.deepEqual(measurementsFromLog('',metadata).shotDurations,[6]);
  assert.throws(()=>measurementsFromLog('',{...metadata,durationSeconds:0}),/technical metadata/);
});

test('video style output requires bounded evidence, all requested characteristics and no duplicate names',()=>{
  const value=output();assert.equal(validateStyleOutput(value,{reference,metadata}).characteristics.length,15);
  assert.throws(()=>validateStyleOutput({...value,patterns:[{...value.patterns[0],endSeconds:7}]},{reference,metadata}),/outside/);
  assert.throws(()=>validateStyleOutput({...value,patterns:[{...value.patterns[0],startSeconds:undefined,endSeconds:undefined}]},{reference,metadata}),/supporting source range/);
  assert.throws(()=>validateStyleOutput({...value,characteristics:value.characteristics.slice(1)},{reference,metadata}),/all requested/);
  assert.throws(()=>validateStyleOutput({...value,characteristics:[value.characteristics[0],...value.characteristics.slice(0,14)]},{reference,metadata}),/duplicate/);
  assert.throws(()=>validateStyleOutput({...value,patterns:[{...value.patterns[0],dimension:'audio'}]},{reference,metadata}),/without an audio stream/);
  assert.throws(()=>validateStyleOutput({...value,characteristics:value.characteristics.map((item,index)=>index===0?{...item,confidence:'high'}:item)},{reference,metadata}),/confident video characteristic/);
});

test('written-reference suggestions require an actual quoted passage and cannot invent video timestamps',()=>{
  const document:StyleReference={...reference,kind:'document',text:'Our voice is warm and direct. Keep captions short.',assetId:undefined};
  const value={summary:'Written brand instructions.',patterns:[{dimension:'voice',observation:'The creator requests a warm voice.',suggestedPreference:'Warm and direct.',confidence:'high',evidence:'Our voice is warm and direct.'}],characteristics:[],limitations:[]};
  assert.equal(validateStyleOutput(value,{reference:document}).patterns.length,1);
  assert.throws(()=>validateStyleOutput({...value,patterns:[{...value.patterns[0],evidence:'Use pink title cards.'}]},{reference:document}),/quotation/);
  assert.throws(()=>validateStyleOutput({...value,patterns:[{...value.patterns[0],startSeconds:0,endSeconds:1}]},{reference:document}),/timestamps/);
});

test('missing Gemini configuration never manufactures extracted creative patterns; URLs are never accessed',async()=>{
  const saved=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='';
  try{
    await assert.rejects(analyzeStyleReference({reference,filePath:'/not-accessed.mp4',metadata,measurements:measurementsFromLog('',metadata)}),(error:any)=>error.code==='CONFIGURATION_REQUIRED');
    await assert.rejects(analyzeStyleReference({reference:{...reference,kind:'link',url:'https://example.test/private-video'},measurements:null}),(error:any)=>error.code==='REFERENCE_UPLOAD_REQUIRED');
  }finally{if(saved===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=saved;}
});

test('real authorized multi-shot MP4 yields FFmpeg cut positions and useful shot statistics', {timeout:40_000},async t=>{
  const ffmpeg=binary('ffmpeg'),ffprobe=binary('ffprobe');
  try{await Promise.all([execFileAsync(ffmpeg,['-version'],{timeout:5000}),execFileAsync(ffprobe,['-version'],{timeout:5000})]);}
  catch{t.skip('Working FFmpeg and FFprobe are required for real scene extraction.');return;}
  const scratch=await mkdtemp(path.join(os.tmpdir(),'creatorflow-style-extraction-'));
  const savedFfmpeg=process.env.FFMPEG_PATH,savedFfprobe=process.env.FFPROBE_PATH;
  process.env.FFMPEG_PATH=ffmpeg;process.env.FFPROBE_PATH=ffprobe;
  try{
    const video=path.join(scratch,'original-three-shot-edit.mp4');
    await execFileAsync(ffmpeg,['-nostdin','-v','error',
      '-f','lavfi','-i','color=c=black:s=96x160:r=24:d=1',
      '-f','lavfi','-i','color=c=white:s=96x160:r=24:d=2',
      '-f','lavfi','-i','color=c=black:s=96x160:r=24:d=3',
      '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]','-map','[v]','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-y',video],{timeout:20000});
    const inspected=await inspectMedia(video);const measured=await measureShots(video,inspected);
    assert.equal(inspected.durationSeconds,6);assert.equal(inspected.hasAudio,false);
    assert.deepEqual(measured.cutSeconds,[1,3]);assert.deepEqual(measured.shotDurations,[1,2,3]);
    assert.equal(measured.averageShotSeconds,2);assert.equal(measured.medianShotSeconds,2);assert.equal(measured.analyzedFramesPerSecond,24);
    t.diagnostic('Actual H.264 video decoding and FFmpeg frame timestamps verified. This test does not claim live Gemini analysis.');
  }finally{
    if(savedFfmpeg===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=savedFfmpeg;
    if(savedFfprobe===undefined)delete process.env.FFPROBE_PATH;else process.env.FFPROBE_PATH=savedFfprobe;
    await rm(scratch,{recursive:true,force:true});
  }
});
