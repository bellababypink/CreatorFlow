import type { Job, MediaAsset } from './types.js';

export const DNA_SECTIONS = ['personality','pillars','formats','voice','writing','palette','typography','rhythm','captions','graphics','audio','platforms','audience','dislikes'] as const;
export type DNASection = typeof DNA_SECTIONS[number];
export const DNA_LABELS: Record<DNASection,string> = { personality:'Brand personality', pillars:'Content pillars', formats:'Video formats', voice:'Voice & language', writing:'Writing style', palette:'Visual palette', typography:'Typography', rhythm:'Editing rhythm', captions:'Caption presets', graphics:'Graphics & transitions', audio:'Audio preferences', platforms:'Platform preferences', audience:'Target audience', dislikes:'Creative boundaries' };
export type CreativePreferences = Partial<Record<DNASection,string>>;
export interface DNAProfile {
  id:string; workspaceId:string; preferences:CreativePreferences; status:'draft'|'locked';
  version:number; updatedAt:string; updatedBy:string; lockedAt:string|null;
  provenance:Partial<Record<DNASection,{source:'creator'|'adopted_pattern'|'legacy';referenceId?:string;analysisId?:string}>>;
}
export interface StyleReference {
  id:string; workspaceId:string; title:string; purpose:'own_work'|'inspiration'|'brand';
  kind:'video'|'link'|'document'; assetId?:string; url?:string; text?:string; notes:string;
  permission:'owned'|'authorized'|'link_only'; analysisId?:string|null;
  createdAt:string; updatedAt:string; version:number;
}
export interface ShotMeasurements {
  method:'ffmpeg_scene_threshold'; threshold:number; durationSeconds:number; cutSeconds:number[];
  shotDurations:number[]; averageShotSeconds:number; medianShotSeconds:number;
  shortestShotSeconds:number; longestShotSeconds:number; analyzedFramesPerSecond:number;
  limitations:string[];
}
export interface StylePattern {
  dimension:DNASection; observation:string; suggestedPreference:string;
  confidence:'low'|'medium'|'high'; evidence:string;
  startSeconds?:number; endSeconds?:number;
}
export interface ReferenceAnalysis {
  id:string; workspaceId:string; referenceId:string; referenceVersion:number; assetId?:string;
  status:'complete'|'measured_only'; summary:string; patterns:StylePattern[];
  characteristics: {name:string; observation:string; evidence:string; confidence:'low'|'medium'|'high';startSeconds?:number;endSeconds?:number}[];
  measurements:ShotMeasurements|null; limitations:string[]; model:string|null;
  createdAt:string; version:number; timestampPrecision:'approximate';
  usage?:{promptTokens?:number;outputTokens?:number;totalTokens?:number};
}
export interface EditingSettings {
  pace:'gentle'|'balanced'|'brisk'; targetShotSeconds:number;
  transition:'cut'|'dissolve'|'fade'; captionPlacement:'lower'|'center'|'upper';
  captionStyle:'minimal'|'boxed'|'emphasis'; aspectRatio:'9:16'|'16:9'|'1:1'|'4:5';
  colorMood:string; audioDirection:string;
}
export interface StylePreset {
  id:string; workspaceId:string; name:string; description:string; preferences:CreativePreferences;
  settings:EditingSettings; version:number; createdAt:string; updatedAt:string; updatedBy:string;
}
export interface PresetRevision extends StylePreset { presetId:string; revision:number; restoredFrom?:number }
export interface CreativeContext {
  workspaceId:string; profileVersion:number; guideStatus:'draft'|'locked';
  preferences:CreativePreferences; presetId:string|null; presetVersion:number|null;
  presetName?:string;
  settings:EditingSettings|null; resolvedAt:string;
}
export interface ProductionProject {
  id:string; workspaceId:string; title:string; status:'brief'; assetIds:string[];
  creativeContext:CreativeContext; createdAt:string; updatedAt:string; createdBy:string; version:number;
}
export interface DNAOverview {
  profile:DNAProfile; references:StyleReference[]; analyses:ReferenceAnalysis[]; presets:StylePreset[];
  projects:ProductionProject[]; jobs:Job[]; assets:MediaAsset[]; geminiConfigured:boolean;
}
