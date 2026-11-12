export type Role = 'owner' | 'administrator' | 'editor' | 'viewer';
export type Platform = 'instagram' | 'tiktok' | 'youtube';
export interface User { id: string; name: string; email: string }
export interface BrandStyle {
  voice?: string; audience?: string; colors?: string[]; editingPace?: string;
  preferences?: string; source: 'user_confirmed' | 'detected' | 'suggested';
}
export interface Workspace {
  id: string; name: string; ownerId: string; role: Role; creatorType?: string;
  platforms: string[]; niches: string[]; goals: string[]; onboardingComplete: boolean;
  brandStyle?: BrandStyle; createdAt: string; updatedAt: string; version: number;
}
export interface MediaMetadata {
  durationSeconds: number; width: number; height: number; fps: number;
  aspectRatio: string; orientation: 'portrait' | 'landscape' | 'square';
  hasAudio: boolean; videoCodec: string; audioCodec?: string; format: string; sizeBytes: number;
}
export interface AnalysisSegment {
  startSeconds: number; endSeconds: number; title: string; description: string; tags: string[];
}
export interface SuggestedClip {
  startSeconds: number; endSeconds: number; title: string; reason: string; suggestedUse: string;
}
export interface TranscriptSegment { startSeconds: number; endSeconds: number; text: string }
export interface VideoAnalysis {
  summary: string; segments: AnalysisSegment[]; suggestedClips: SuggestedClip[];
  transcript: TranscriptSegment[]; warnings: string[]; model: string; analyzedAt: string;
  timestampPrecision: 'approximate';
  usage?: { promptTokens?: number; outputTokens?: number; totalTokens?: number };
}
export interface Analysis extends VideoAnalysis {
  id: string; workspaceId: string; assetId: string; createdAt: string; version: number;
}
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'blocked_configuration';
export interface Job {
  id: string; workspaceId: string; assetId: string; type: 'media_ingestion' | 'video_analysis';
  status: JobStatus; progress: number; stage: string; attempts: number; maxAttempts: number;
  error?: string | null; outputId?: string | null; createdAt: string; updatedAt: string;
  leaseUntil?: string | null; version: number;
}
export interface MediaAsset {
  id: string; workspaceId: string; uploadedBy: string; originalName: string; mimeType: string;
  sizeBytes: number; status: 'uploaded' | 'processing' | 'ready' | 'failed';
  metadata?: MediaMetadata | null; thumbnailReady?: boolean; analysisId?: string | null;
  createdAt: string; updatedAt: string; version: number;
}
export interface ProviderStatus {
  id: string; name: string; category: string; status: string; capabilities: string[];
  message: string; configured?: boolean; authRequirements?: string[]; limits?: string[];
}
export interface SystemStatus {
  mode: 'local' | 'firebase'; authConfigured: boolean; geminiConfigured: boolean;
  storageConfigured: boolean; workerAvailable: boolean;
  firebaseConfig?: { apiKey: string; authDomain: string; projectId: string; storageBucket: string; appId: string };
  limits: { maxUploadBytes: number; maxDurationSeconds: number };
}
export interface AssetDetail { asset: MediaAsset; analysis: Analysis | null; job: Job | null }
