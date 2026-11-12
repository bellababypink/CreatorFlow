import type { ProviderStatus } from '../../shared/types.js';
import { mediaToolStatus } from '../processing/media.js';

/** Configuration is distinct from an authorized, tested provider connection. */
export async function getProviderStatuses(): Promise<ProviderStatus[]> {
  const tools = await mediaToolStatus();
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);
  const firebaseConfigured = process.env.APP_MODE === 'firebase' && Boolean(process.env.FIREBASE_PROJECT_ID);
  return [
    {
      id: 'gemini', name: 'Google Gemini', category: 'intelligence',
      status: geminiConfigured ? 'configured' : 'setup_required', configured: geminiConfigured,
      capabilities: ['video_analysis', 'approximate_transcript', 'timestamped_clip_suggestions'],
      message: geminiConfigured ? 'Server key is configured. Access is verified when a real analysis succeeds.' : 'Add a server-side GEMINI_API_KEY to enable real video analysis.',
      authRequirements: ['Server API key', 'Model access and provider quota'],
      limits: ['10-minute Stage 0 video limit', '100 MB default upload limit', 'Model timestamps require editorial verification'],
    },
    {
      id: 'ffmpeg', name: 'FFmpeg & FFprobe', category: 'media',
      status: tools.ffmpeg && tools.ffprobe ? 'available' : 'setup_required', configured: tools.ffmpeg && tools.ffprobe,
      capabilities: ['technical_metadata', 'thumbnail_extraction'],
      message: tools.ffmpeg && tools.ffprobe ? 'Both media tools are available on this server. Worker deployment must include them too.' : 'Install both tools on the worker, or set FFMPEG_PATH and FFPROBE_PATH.',
      authRequirements: [], limits: ['Rendering is planned for a later stage; this version inspects source media.'],
    },
    {
      id: 'firebase', name: 'Firebase', category: 'foundation',
      status: firebaseConfigured ? 'configured' : 'local_development', configured: firebaseConfigured,
      capabilities: ['authentication', 'workspace_records', 'private_object_storage'],
      message: firebaseConfigured ? 'Firebase mode is configured. Application credentials, enabled sign-in methods, and bucket access must be verified in deployment.' : 'Using local development accounts, SQLite records, and private disk storage. Configure Firebase for production.',
      authRequirements: ['Firebase web configuration', 'Application Default Credentials', 'Private Cloud Storage bucket'],
    },
    {
      id: 'youtube', name: 'YouTube', category: 'social', status: 'planned', configured: false,
      capabilities: [],
      message: 'Not connected. A future OAuth adapter can access authorized posts and permitted Analytics reports.',
      authRequirements: ['Google OAuth application', 'User consent', 'Approved scopes and verification where required'],
      limits: ['Metric availability depends on scopes, report type, and channel ownership.'],
    },
    {
      id: 'instagram', name: 'Instagram', category: 'social', status: 'planned', configured: false,
      capabilities: [],
      message: 'Not connected. Official professional-account authorization and Meta review are required before enabling access.',
      authRequirements: ['Meta application', 'Eligible professional account', 'User authorization', 'Required app review'],
      limits: ['Consumer accounts and unsupported metrics cannot be accessed.'],
    },
    {
      id: 'tiktok', name: 'TikTok', category: 'social', status: 'planned', configured: false,
      capabilities: [],
      message: 'Not connected. Display and publishing access are separate approved integrations.',
      authRequirements: ['TikTok developer application', 'Login Kit and applicable API approval', 'User consent'],
      limits: ['Display API does not imply full creator analytics or publishing permission.'],
    },
    {
      id: 'google_drive', name: 'Google Drive', category: 'storage', status: 'planned', configured: false,
      capabilities: [], message: 'Not connected. Stage 0 accepts explicit local video uploads. An authorized file picker is planned.',
      authRequirements: ['Google OAuth and file selection consent'],
      limits: ['No arbitrary folder scanning or background synchronization.'],
    },
    {
      id: 'remotion', name: 'Remotion', category: 'rendering', status: 'planned', configured: false,
      capabilities: [], message: 'No renderer is connected. Canonical timeline and composition rendering belong to the editing stage.',
      authRequirements: ['Deployment configuration and commercial license review'],
    },
    {
      id: 'hyperframes', name: 'HyperFrames', category: 'rendering', status: 'planned', configured: false,
      capabilities: [], message: 'Optional future composition adapter. No render is simulated.',
      authRequirements: ['Compatibility, deployment, and licensing review'],
    },
    {
      id: 'capcut', name: 'CapCut', category: 'editing', status: 'planned', configured: false,
      capabilities: [], message: 'No application integration is connected. A handoff requires a verified supported workflow and explicit user authorization.',
      authRequirements: ['Verified supported integration', 'User authorization'],
      limits: ['Undocumented draft formats are not used.'],
    },
  ];
}

export type { SocialProviderAdapter, AvailableMetric } from './social.js';
