# Creator DNA and Style Intelligence

Creator DNA is the workspace's reusable creative source of truth. It combines creator-confirmed preferences with a separate library of reference evidence. A reference analysis cannot silently become a brand rule.

## What a creator can do

1. Review the existing voice, audience, colours, pace and preferences carried forward from onboarding. Previously confirmed Stage 0 values remain available; detected values are not promoted to approved preferences.
2. Edit the profile's personality, pillars, formats, voice and language, writing style, palette, typography, rhythm, captions, graphics, audio, platforms, audience and creative boundaries.
3. Save public reference links, owned or authorized Media Vault videos, or supplied plain text and Markdown instructions. A saved link is a bookmark. CreatorFlow does not scrape a social profile, download its videos or claim that its content has been analyzed.
4. Analyze supplied video or text through the background worker. Video analysis combines FFmpeg measurements with genuine Gemini visual/audio interpretation when configured. Each interpretation has evidence, confidence and limitations. Model timestamps remain approximate.
5. Compare available reference observations. Adopt a specific suggested preference only after review. Adoption records the originating reference and analysis.
6. Create multiple named style presets with explicit creative preferences and structured editing settings. Edit a preset, review its revision history or restore an earlier revision as a new revision.
7. Download, review and lock the Style Guide. Owners and administrators can lock or unlock the guide; editors can edit unlocked preferences. A lock applies to the workspace guide, while named presets remain separately versioned creative choices.
8. Create a production brief using a named preset and selected workspace footage. The brief stores the exact resolved context and revision numbers. Subsequent guide or preset edits do not rewrite an existing brief.

## Sources and honest access states

| Source | Supported path | Evidence limitation |
| --- | --- | --- |
| Creator's own published video | Upload the authorized original to Media Vault and add it as an own-work reference | Channel metadata or a public URL alone does not provide the video to the style analyzer |
| Previously edited video or inspiration upload | Reuse a permitted Media Vault video and attest ownership or authorization | No third-party footage or branded assets are copied into a production automatically |
| Public reference profile or content link | Save an HTTPS bookmark with notes | Link content is not fetched, scraped or analyzed; supply a permitted upload for video findings |
| Brand document or written instruction | Supply plain text/Markdown, at most 50 KB of UTF-8 text | PDF, Word and other document parsing is not implemented; their text can be supplied explicitly |

Only original, licensed or user-provided assets may be used. Style extraction describes techniques; it does not grant rights to another creator's footage, artwork, typography, music or branding.

## Analysis contract

The video worker inspects the actual file before extracting style evidence. FFmpeg detects visual discontinuities using a documented scene threshold. Statistics include the detected cut times, interval durations and average/median interval lengths. These are reproducible signal measurements. Camera movement, flashes, dissolves and visually similar cuts can cause missed or false boundaries, so the result is an estimate of shot rhythm rather than a guaranteed edit decision list.

Gemini receives the actual authorized video, or the supplied document text. Its requested characteristics cover opening hook, story structure, framing, colour and lighting, transitions, overlays, captions, likely typography characteristics, voiceover/natural audio, music placement, sound design, motifs, ending and call to action. Unsupported characteristics must remain uncertain or unavailable. The product does not promise exact font, song, artist or music-licence identification. Audio findings must reflect the actual audio evidence; a silent video cannot support a music or voiceover claim.

All source media, document text and notes are treated as untrusted data rather than executable instructions. Output is validated before it is persisted. Analysis is evidence, not an approved brand rule. A creator's explicit adoption action is recorded separately.

When Gemini is unconfigured, an analysis job ends in a visible configuration state. A video may retain its successfully measured technical rhythm, clearly labelled as measurements only; inferred style patterns are not invented. Text-only jobs cannot produce an AI analysis without Gemini.

## Domain records and versioning

All new records carry workspace ownership, stable IDs, timestamps and versions. Existing accounts, media originals, content analyses and channel records retain their existing format.

| Collection | Purpose |
| --- | --- |
| `dnaProfiles` | Current creator-approved workspace preferences, provenance and guide lock |
| `dnaProfileRevisions` | Immutable guide revisions |
| `styleReferences` | Permitted source-media references, document text, bookmarks and notes |
| `styleAnalyses` | Detected patterns, characteristic evidence, measurements, confidence, model provenance and limitations |
| `stylePresets` | Current named presets with structured editing settings |
| `stylePresetRevisions` | Immutable preset history; restoring creates a new revision |
| `productionProjects` | Real production briefs with source asset IDs and a pinned creative-context snapshot |

The existing `jobs`, `usage` and `auditLogs` collections also record background processing, provider usage and sensitive guide actions. Workspace export includes creative records; workspace deletion purges them. Backend authorization remains mandatory for all reads and writes. The browser has no direct Firestore access to another tenant's data.

Mutation requests carry an expected version. Atomic workspace commits reject stale versions, foreign ownership, deleted workspaces, invalid job leases and oversized records. A restore never overwrites an earlier revision.

## Reusable creative context

`GET /api/workspaces/:workspaceId/dna/context` resolves only confirmed workspace preferences. Supplying `presetId` overlays that named preset's explicit preferences and includes its structured settings. Unadopted reference patterns are never included.

The context includes workspace ID, guide version/status, preset ID/name/revision, resolved preferences, structured editing settings and resolution time. A production brief copies this context so later planning, writing, editing and publishing can use the same interpretation. The existing media and channel AI entry points use this shared resolver instead of inferring brand rules from library references.

The Stage 2 production brief is a data handoff, with real persisted source and style references. Timeline editing, playable composed previews, rendering and publishing are later stages and are not simulated here.

## API outline

All routes below are under `/api/workspaces/:workspaceId/dna` and require authenticated workspace membership.

| Method and path | Role | Result |
| --- | --- | --- |
| `GET /` | Viewer and above | Profile, references, actual analyses, presets, briefs, relevant jobs and authorized asset choices |
| `PATCH /profile` | Editor and above | Explicit preferences saved against `expectedVersion` while unlocked |
| `POST /profile/lock` | Administrator or owner | Guide lock/unlock with a new revision |
| `POST /profile/adopt` | Editor and above | One current complete analysis pattern explicitly adopted |
| `GET /guide` | Viewer and above | Downloadable Markdown Style Guide |
| `GET /context?presetId=…` | Viewer and above | Approved reusable creative context |
| `POST /references` | Editor and above | Validated video, document or bookmark record |
| `DELETE /references/:id` | Editor and above | Reference and its analyses removed after active jobs finish |
| `POST /references/:id/analyze` | Editor and above | Queue-backed style analysis; links require a supplied source |
| `POST /presets` | Editor and above | Named preset and immutable first revision |
| `PATCH /presets/:id` | Editor and above | New preset revision |
| `GET /presets/:id/revisions` | Viewer and above | Same-workspace revision history |
| `POST /presets/:id/restore` | Editor and above | New revision copied from an earlier revision |
| `POST /projects` | Editor and above | Persisted production brief and pinned creative context |

## Operator setup and cost drivers

Run the API and asynchronous worker using the existing deployment instructions. Set `GEMINI_API_KEY` only on the server/worker; `GEMINI_STYLE_MODEL`, or the shared `GEMINI_MODEL` fallback, selects a video-capable supported model. FFmpeg and FFprobe must be available to the worker, through the executable path or `FFMPEG_PATH`/`FFPROBE_PATH`. Keep object storage private and do not expose provider keys in frontend configuration.

Existing video duration, file-size, storage and concurrent-job quotas still apply. The reference library is limited to 100 records, named presets to 50 and a preset to 200 revisions. Supplied document text is bounded to 50 KB. Model input/output tokens, file storage, media decoding and repeated analyses are the main cost drivers. A style reference reuses an existing authorized original rather than duplicating its stored video.

No live Gemini extraction is verified until the acceptance journey is completed with a configured key and authorized real content. Local protocol validation and generated test videos do not replace that live verification.
