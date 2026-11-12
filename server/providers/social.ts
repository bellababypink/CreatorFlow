/**
 * Contract only. No social account is connected by Stage 0.
 * Provider-specific credentials must be stored encrypted server-side before
 * implementing adapters; never put tokens into these API response types.
 */
export type SocialProviderId = 'youtube' | 'instagram' | 'tiktok';
export type SocialCapability = 'profile' | 'posts' | 'metrics' | 'publish';

export interface AuthorizedSocialContext {
  workspaceId: string;
  connectionId: string;
  grantedScopes: string[];
}

export interface SocialProfile {
  providerAccountId: string;
  displayName: string;
  accountType: string;
}

export interface NormalizedPost {
  providerPostId: string;
  publishedAt: string;
  title?: string;
  url?: string;
  /** Preserve raw supported fields, rather than pretending all platforms match. */
  providerMetadata: Record<string, unknown>;
}

export interface AvailableMetric {
  providerMetricId: string;
  label: string;
  unit: 'count' | 'seconds' | 'ratio' | 'currency';
  source: 'provider_api' | 'verified_import';
  /** Undefined is unavailable, never zero-filled. */
  value?: number;
  measuredAt: string;
  unavailableReason?: string;
}

export interface Page<T> { items: T[]; nextCursor?: string }
export interface PermissionReport { granted: string[]; missing: string[]; availableCapabilities: SocialCapability[] }

export interface SocialProviderAdapter {
  readonly id: SocialProviderId;
  readonly capabilities: SocialCapability[];
  createAuthorizationUrl(input: { workspaceId: string; redirectUri: string; state: string; codeChallenge: string }): Promise<string>;
  completeAuthorization(input: { workspaceId: string; code: string; redirectUri: string; codeVerifier: string; state: string }): Promise<{ connectionId: string }>;
  disconnect(context: AuthorizedSocialContext): Promise<void>;
  refreshAuthorization(context: AuthorizedSocialContext): Promise<void>;
  readProfile(context: AuthorizedSocialContext): Promise<SocialProfile>;
  listPosts(context: AuthorizedSocialContext, cursor?: string): Promise<Page<NormalizedPost>>;
  availableMetrics(context: AuthorizedSocialContext, providerPostId?: string): Promise<AvailableMetric[]>;
  refreshAnalytics(context: AuthorizedSocialContext): Promise<{ jobId: string }>;
  permissions(context: AuthorizedSocialContext): Promise<PermissionReport>;
}

export const socialProviderReferences = {
  youtube: [
    'https://developers.google.com/youtube/reporting/guides/authorization',
    'https://developers.google.com/youtube/analytics/metrics',
  ],
  instagram: ['https://developers.facebook.com/docs/instagram-platform/'],
  tiktok: ['https://developers.tiktok.com/doc/display-api-overview/'],
} as const;
