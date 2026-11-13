import type { Platform } from './types';

export type IntegrationStatus = 'Connected' | 'Needs Permission' | 'Requires Developer Approval' | 'Not Configured' | 'Unavailable';
export type ChannelSource = 'oauth' | 'manual_import';
export type MetricSource = 'youtube_data_api' | 'youtube_analytics_api' | 'manual_import';
export interface MetricValue {
  key: string; providerMetric: string; label: string; definition: string;
  unit: 'count' | 'seconds' | 'minutes' | 'percent'; value: number;
  scope: 'lifetime' | 'period' | 'daily'; periodStart: string | null; periodEnd: string | null;
  observedAt: string; source: MetricSource; comparisonKey: string;
}
export interface ChannelConnection {
  id: string; workspaceId: string; provider: Platform; source: ChannelSource;
  providerAccountId: string; accountName: string; accountUrl?: string;
  status: IntegrationStatus; grantedScopes: string[]; missingScopes: string[];
  lastSyncedAt: string | null; lastError: string | null; availableMetrics: string[];
  disconnectedAt?: string | null; generation: number;
  createdAt: string; updatedAt: string; version: number;
}
export interface ChannelIntegration {
  provider: Platform; name: string; status: IntegrationStatus; message: string;
  configured: boolean; canConnect: boolean; requiredScopes: string[]; setupSteps: string[];
}
export type PostContentType = 'video' | 'short' | 'reel' | 'tiktok' | 'image' | 'carousel' | 'unknown';
export interface ChannelPost {
  id: string; workspaceId: string; connectionId: string; provider: Platform;
  providerPostId: string; title: string; caption: string; publishedAt: string; url: string | null;
  thumbnailUrl: string | null; durationSeconds: number | null; contentType: PostContentType;
  contentTypeSource?: 'provider' | 'imported' | 'user_confirmed';
  pillar: string | null; pillarSource: 'user_confirmed' | 'imported' | null;
  mediaAssetId: string | null; tags: string[]; metrics: MetricValue[];
  source: MetricSource; createdAt: string; updatedAt: string; version: number;
}
export interface ChannelSnapshot {
  id: string; workspaceId: string; connectionId: string; provider: Platform;
  observedAt: string; periodStart: string; periodEnd: string;
  accountMetrics: MetricValue[]; daily: { date: string; metrics: MetricValue[] }[];
  postMetrics?: { postId: string; metrics: MetricValue[] }[];
  audience: { dimension: string; value: string; metrics: MetricValue[] }[];
  coverage: { postsFetched: number; hasMore: boolean; limitations: string[] };
  createdAt: string; version: number;
}
export interface ChannelFilters {
  startDate?: string; endDate?: string; platform?: Platform; connectionId?: string;
  contentType?: PostContentType; pillar?: string;
}
export interface ChannelGroup {
  label: string; posts: number; postsWithMetric: number; median: number | null;
  metricKey: string | null; comparisonKey: string | null; caveat: string;
}
export interface ComparisonSeries {
  connectionId: string; accountName: string; provider: Platform; source: ChannelSource;
  posts: number; postsPerWeek: number | null; metrics: { key: string; label: string; definition: string; unit: string; total: number; postsWithMetric: number; comparisonKey: string; scope: string; periodStart: string | null; periodEnd: string | null }[];
}
export interface ChannelOverview {
  posts: ChannelPost[]; snapshots: ChannelSnapshot[]; comparisons: ComparisonSeries[];
  groups: { lengths: ChannelGroup[]; pillars: ChannelGroup[]; formats: ChannelGroup[]; topics: ChannelGroup[] };
  coverage: { posts: number; accounts: number; periodStart: string | null; periodEnd: string | null; limitations: string[] };
  pillars: string[]; filters: ChannelFilters;
}
export interface AuditFinding {
  category: 'strength' | 'weakness' | 'theme' | 'pillar' | 'experiment' | 'audience' | 'limitation';
  title: string; detail: string; evidencePostIds: string[]; evidenceSnapshotIds: string[];
  confidence: 'low' | 'medium' | 'high';
}
export interface ChannelAudit {
  id: string; workspaceId: string; filters: ChannelFilters;
  summary: string; findings: AuditFinding[]; limitations: string[];
  model: string; generatedAt: string; sourcePostIds: string[]; sourceSnapshotIds: string[];
  usage?: { promptTokens?: number; outputTokens?: number; totalTokens?: number };
  createdAt: string; version: number;
}
export interface ImportPreview {
  platform: Platform; accountName: string; rows: number; posts: ChannelPost[];
  warnings: string[]; digest: string;
}
export interface ChannelPostDetail {
  post: ChannelPost; connection: ChannelConnection;
  linkedMedia: { id: string; originalName: string } | null;
  mediaAnalysis: import('./types').Analysis | null;
  evidenceAvailability: { metadata: boolean; video: boolean; analysis: boolean; message: string };
}
