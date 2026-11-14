import { z } from 'zod';
import { store, type Write } from '../store.js';
import { HttpError } from '../errors.js';
import type { StoredAsset, StoredWorkspace } from '../models.js';
import { DNA_LABELS, DNA_SECTIONS, type CreativeContext, type CreativePreferences, type DNAProfile, type StyleReference, type StylePreset } from '../../shared/dna.js';

export const now=()=>new Date().toISOString();
export const idSchema=z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
export const versionSchema=z.number().int().nonnegative();
export const preferencesSchema=z.object(Object.fromEntries(DNA_SECTIONS.map(k=>[k,z.string().trim().max(3000).optional()])) as Record<typeof DNA_SECTIONS[number],z.ZodOptional<z.ZodString>>).strict();
export const settingsSchema=z.object({pace:z.enum(['gentle','balanced','brisk']),targetShotSeconds:z.number().finite().min(.2).max(60),transition:z.enum(['cut','dissolve','fade']),captionPlacement:z.enum(['lower','center','upper']),captionStyle:z.enum(['minimal','boxed','emphasis']),aspectRatio:z.enum(['9:16','16:9','1:1','4:5']),colorMood:z.string().trim().max(500),audioDirection:z.string().trim().max(1000)}).strict();
export const presetSchema=z.object({name:z.string().trim().min(1).max(100),description:z.string().trim().max(2000),preferences:preferencesSchema,settings:settingsSchema}).strict();
export const CREATIVE_COLLECTIONS=['dnaProfiles','dnaProfileRevisions','styleReferences','styleAnalyses','stylePresets','stylePresetRevisions','productionProjects'] as const;

export async function workspaceRecord(workspaceId:string){
  const ws=await store.get<StoredWorkspace>('workspaces',workspaceId);
  if(!ws||ws.deleting)throw new HttpError(409,'This workspace is unavailable.');return ws;
}
export async function owned<T extends {workspaceId:string}>(collection:string,workspaceId:string,id:string):Promise<T>{
  idSchema.parse(id);const value=await store.get<T>(collection,id);
  if(!value||value.workspaceId!==workspaceId)throw new HttpError(404,'Creative record not found.');return value;
}
export async function usableAsset(workspaceId:string,id:string){
  const asset=await owned<StoredAsset>('assets',workspaceId,id);
  if(asset.deleting)throw new HttpError(409,'This video is being deleted.');return asset;
}
/** Existing confirmed preferences remain available until explicitly edited. Detected legacy data is never promoted. */
export function legacyProfile(ws:StoredWorkspace):DNAProfile {
  const preferences:CreativePreferences={};const provenance:DNAProfile['provenance']={};
  if(ws.brandStyle?.source==='user_confirmed'){
    const b=ws.brandStyle;
    Object.assign(preferences,{...(b.voice?{voice:b.voice}:{}),...(b.audience?{audience:b.audience}:{}),...(b.editingPace?{rhythm:b.editingPace}:{}),...(b.colors?.length?{palette:b.colors.join(', ')}:{}),...(b.preferences?{dislikes:b.preferences}:{})});
  }
  if(ws.niches.length)preferences.pillars=ws.niches.join(', ');
  if(ws.platforms.length)preferences.platforms=ws.platforms.join(', ');
  for(const key of Object.keys(preferences) as (keyof CreativePreferences)[])provenance[key]={source:'legacy'};
  return {id:ws.id,workspaceId:ws.id,preferences,provenance,status:'draft',version:0,updatedAt:ws.updatedAt,updatedBy:ws.ownerId,lockedAt:null};
}
export async function getProfile(workspaceId:string){return await store.get<DNAProfile>('dnaProfiles',workspaceId)||legacyProfile(await workspaceRecord(workspaceId));}
export function assertVersion(current:{version:number},expected:number){if(current.version!==expected)throw new HttpError(409,'This creative record changed. Refresh before saving.','CREATIVE_VERSION_CONFLICT');}
export function profileWrites(profile:DNAProfile):Write[]{return [{collection:'dnaProfiles',value:profile},{collection:'dnaProfileRevisions',value:{...profile,id:`${profile.id}_v${profile.version}`,profileId:profile.id}}];}
export function profileGuard(profile:DNAProfile){return {collection:'dnaProfiles',id:profile.id,version:profile.version||null};}
export function cleanPreferences(preferences:CreativePreferences){return Object.fromEntries(Object.entries(preferences).filter(([,v])=>v?.trim()).map(([k,v])=>[k,v!.trim()])) as CreativePreferences;}
export function ensureUnlocked(profile:DNAProfile){if(profile.status==='locked')throw new HttpError(409,'Unlock the Style Guide before changing approved preferences.','STYLE_GUIDE_LOCKED');}
export async function resolveCreativeContext(workspaceId:string,presetId?:string):Promise<{context:CreativeContext;profile:DNAProfile;preset:StylePreset|null}> {
  const profile=await getProfile(workspaceId),preset=presetId?await owned<StylePreset>('stylePresets',workspaceId,presetId):null;
  return {profile,preset,context:{workspaceId,profileVersion:profile.version,guideStatus:profile.status,preferences:{...profile.preferences,...(preset?.preferences||{})},presetId:preset?.id||null,presetVersion:preset?.version||null,...(preset?{presetName:preset.name}:{}),settings:preset?.settings||null,resolvedAt:now()}};
}
export async function approvedCreativeContext(workspaceId:string){return (await resolveCreativeContext(workspaceId)).context;}
const safeMarkdown=(s:string)=>s.replaceAll('<','&lt;').replaceAll('>','&gt;').replace(/([\\`*_\[\]#])/g,'\\$1');
export function renderStyleGuide(profile:DNAProfile,presets:StylePreset[],name:string){
  return [`# ${safeMarkdown(name)} — Editing Style Guide`,'',`Guide version: ${profile.version} · ${profile.status==='locked'?'Locked by a workspace administrator':'Draft — creator-supplied preferences'}`,`Updated: ${profile.updatedAt}`,'','Only creator-entered or explicitly adopted preferences appear here. Reference analysis is evidence, never an approved rule.','',...DNA_SECTIONS.flatMap(k=>[`## ${DNA_LABELS[k]}`,'',safeMarkdown(profile.preferences[k]||'Not defined.'),'',`Source: ${profile.provenance[k]?.source||'Not defined'}${profile.provenance[k]?.analysisId?` · analysis ${profile.provenance[k]?.analysisId}`:''}`,'']), '## Current named presets — separate from the locked base guide','','These independently versioned overrides can change without unlocking the base guide. A production stores the exact selected preset revision.','',...presets.flatMap(p=>[`### ${safeMarkdown(p.name)} · revision ${p.version}`,'',safeMarkdown(p.description),`Pace: ${p.settings.pace}; target shot: ${p.settings.targetShotSeconds}s; transition: ${p.settings.transition}; format: ${p.settings.aspectRatio}.`,'',...Object.entries(p.preferences).map(([k,v])=>`- ${DNA_LABELS[k as keyof typeof DNA_LABELS]}: ${safeMarkdown(v||'')}`),'']), 'Reference techniques can inform original work. Use only original, licensed, or authorized creative assets. Exact font and music identification is not guaranteed.',''].join('\n');
}
export async function referenceFor(workspaceId:string,referenceId:string){return owned<StyleReference>('styleReferences',workspaceId,referenceId);}
