# CreatorFlow AI architecture

Status: Stage 0 implementation, November 2026. This document separates the target product from the implemented vertical slice. See `FEATURES.md` for completion and verification evidence.

## 1. Product structure

CreatorFlow is a multi-workspace content operating system. A workspace is the access boundary for one creator or brand; a user may belong to several workspaces. Bella's Cozy Diary is a possible pilot workspace, never an application-wide default. No brand voice, niche, visual preference, or performance result is assumed for a new workspace.

The durable workflow is:

`identity → workspace → creator profile → media asset → analysis → idea → production → edit timeline → platform version → export → publishing record → analytics → feedback`

Stage 0 implements the chain through saved media analysis. Later records reference stable IDs rather than copying mutable records or relying on a chat conversation. An idea can become a project without losing evidence, source media, or version history.

## 2. Technology choices and tradeoffs

| Layer | Choice | Reason and tradeoff |
| --- | --- | --- |
| Interface | React, TypeScript, Tailwind, Vite | Accessible component-oriented application with fast local development. It is portable source, not dependent on AI Studio hosting. |
| API | Node.js 24+, Express, Zod | Explicit validated HTTP boundaries and a familiar independent deployment path. Video work runs elsewhere. |
| Production identity | Firebase Authentication | Google sign-in with server-verified identity and HttpOnly session cookies. Provider configuration and authorized domains are deployment requirements. Local development supports separate email/password accounts. |
| Production records | Firestore through Firebase Admin | Managed durable records and transactional worker claims. Reads are scoped by the server; client SDK access is denied by rules. Query design matters for cost and indexes. |
| Production files | Private Firebase Storage / Google Cloud Storage bucket | Originals remain outside the web root and access passes through authorized API routes. Large-scale direct resumable uploads are a later improvement. |
| Local development | SQLite and private local files | A real persistent workflow without provisioned cloud services. Local identity/storage is explicitly labelled and must never silently replace production services. |
| AI | Server-side Gemini Files API and structured output | Video/audio reasoning with model and usage provenance. Outputs remain fallible and approximate; no model-generated timestamp drives frame-accurate cuts. |
| Technical media processing | FFprobe and FFmpeg | Container, stream, duration, frame rate, dimensions, audio and thumbnail extraction independently of the model. Native tools add deployment and codec maintenance work. |
| Work execution | Separate Node worker with durable job records and leases | Upload requests return before AI processing. A worker can recover from termination and retry bounded failures. Polling is deliberately simple for the pilot; a managed queue adapter can replace it. |
| Future video renderer | Adapter over canonical edit decision list | FFmpeg is the independent export path to prove first. Remotion or HyperFrames can add composition capabilities after compatibility and licensing review. CapCut cannot become the source of truth. |

Firebase ID tokens must be verified on the API; the Admin SDK bypasses Firestore rules, so rules alone do not authorize server routes. See [Firebase ID-token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

## 3. User journeys

### Stage 0: first useful analysis

1. Create a real account, or sign in through configured Firebase providers.
2. Create and name a workspace.
3. Complete or skip short onboarding: creator type, platforms, niches, goals, and brand preferences.
4. Open the Command Centre and upload an authorized video.
5. Persist the original privately, create the asset and ingestion job, and return a job reference.
6. Worker probes the file, extracts a thumbnail, uploads the file to Gemini, validates the analysis, and stores the result.
7. Open a playable source preview with timestamped descriptions and useful clip suggestions.
8. Refresh or sign in again and reopen the same saved analysis.

Missing Gemini configuration produces an explicit blocked/setup status. A technical metadata result is not presented as AI analysis. Failed provider requests produce a retryable error, never generated sample findings.

### Later journeys

- A user corrects detected Creator DNA and approves a versioned style preset. Inferred, confirmed and suggested values remain distinct.
- A planner combines authorized historical results, cited trend evidence, goals and media availability; the user promotes an idea to production.
- A producer reviews matched source ranges and missing shots, then edits a storyboard and canonical timeline.
- A reviewer approves each platform version before rendering or publishing.
- Verified performance records link back to the originating version, edit and idea, enabling experiments and retrospective recommendations.

## 4. Data model and invariants

All persisted records use stable generated IDs and timestamps. Workspace-owned records carry `workspaceId`; edits and inferred results include schema/version or provenance fields. Do not accept a client-supplied workspace ID in place of checking the route's workspace and current membership.

| Entity | Key relationship / purpose | Stage |
| --- | --- | --- |
| User | Authentication UID, profile; never owns other users' credentials | 0 |
| Workspace | Brand boundary, owner, onboarding, usage limits | 0 |
| Workspace member | User + workspace, owner/admin/editor/viewer role | 0 |
| Brand / style profile | Workspace voice, pillars, audience, palette, editing preferences; evidence and confirmation state | Initial onboarding in 0; rich model later |
| Media asset | Workspace, immutable original object, technical metadata, thumbnail, processing status | 0 |
| Media analysis | Asset + workspace, summary, segments, clip suggestions, model, timestamps, usage | 0 |
| Job | Workspace, input asset, status, lease, attempts, progress, errors, outputs | 0 |
| Audit event | Actor, workspace, action, target, timestamp | 0 foundation |
| Organization | Ownership and billing for related workspaces | Later |
| Social connection | Provider identity, grants, expiry, encrypted secret reference, account capabilities | Later |
| Social post / analytics snapshot | Provider post ID, authorized imported metrics, observation time and source | Later |
| Content pillar / trend evidence / inspiration | Workspace strategy, source URL, observation time, licensing/authorization context | Later |
| Media segment / collection / saved search | Asset ranges, searchable descriptors, membership | Later |
| Content idea / content plan | Rationale, audience, beats, required/matching/missing footage and evidence | Later |
| Production / shot list / storyboard | Origin idea, planned scenes and approved source references | Later |
| Edit timeline | Versioned canonical tracks, source in/out, transforms, transitions, text, captions and audio | Later |
| Video version / render job / exported asset | Shared source project, platform-specific decisions and real output references | Later |
| Publishing record | Approved output, destination post, publishing outcome | Later |
| Feedback / experiment | Hypothesis, comparator, outcome, user feedback and verified metrics | Later |
| Entitlement / usage | Workspace limits, measured units, provider attribution, billing association | Foundation only; billing later |

Indexes must follow actual query shapes. Maintain `firestore.indexes.json` alongside repository queries. Workspace filters are mandatory before listing assets, jobs, analyses, exports, strategy or analytics. A composite index never provides authorization.

Data preservation rules: originals are immutable; reanalysis creates or explicitly versions derived results; destructive operations require ownership authorization; deletion must include derived objects and jobs. Deletion/export coverage must be documented as entities are introduced.

## 5. Backend service boundaries

- **Identity:** local development sessions or production Firebase verification; user profile reads; sign-out; account lifecycle.
- **Workspace:** creation, membership lookup, role checks, switching and onboarding updates.
- **Media:** upload limits, canonical storage keys, asset records, authorized range streaming and deletion.
- **Job orchestration:** durable enqueue, transactional claim/lease, progress, retry and terminal results.
- **Processing:** local media inspection, thumbnail extraction and Gemini analysis. It does not decide user authorization.
- **Provider registry:** capability declarations and actual configuration status. A configured key does not mean a social account is connected.
- **Future strategy/editing/publishing:** separate typed services consuming the shared domain model.

API input is validated at boundaries. User IDs, workspace membership and roles come from verified identity and stored authorization records. Tokens and API keys remain server-side. No provider secrets belong in browser environment variables or application records returned to clients.

## 6. Video processing and canonical editing

Stage 0 flow:

`upload → private original → durable ingestion job → FFprobe → thumbnail → Gemini upload → provider-ready poll → structured analysis → validated stored result`

The worker owns temporary files and removes them after processing. Gemini file references are temporary provider artifacts, not the archive of the user's footage. Store originals, thumbnails/proxies, analyses, and eventual exports under separate prefixes. A job's stable input reference makes retry practical; claiming and terminal writes must not allow multiple workers to overwrite each other's output.

Gemini video understanding can reason over the audio and visual content and return timestamped observations. These are approximate suggestions, not precise cut boundaries. See [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding). FFprobe supplies measurable stream metadata. Later scene detection and editor operations must use frame/sample-aware tooling.

The future edit decision list contains source asset IDs and in/out times, ordered tracks, transforms/crop, transitions, captions, overlays, licensed audio references, output format, style preset version and revision history. Renderer adapters consume this schema. Platform versions can change hook, sequence, duration, safe areas, text and ending independently while retaining the same parent production.

## 7. Connector feasibility

| Provider | Feasible route | Required gate / fallback |
| --- | --- | --- |
| YouTube | Official Data and Analytics APIs using OAuth | Enabled APIs, approved consent configuration and granted scopes. Metrics differ by resource and grant; verified export import can be a later fallback. |
| Instagram | Official Instagram platform APIs for supported professional accounts | Account type, app permissions, review and selected login flow. No access to private consumer analytics is assumed. |
| TikTok | Login Kit and approved Display APIs for supported profile/video information | Product approval and scopes. Publishing is a separate approved capability; broad creator analytics are not assumed. |
| Google Drive | User-authorized picker / selected files | Least-privilege scopes and app verification where needed. No arbitrary-drive scan. |
| Gemini | Server credential, supported video model, files and generation endpoints | Quota, model availability, file processing errors and data-use decisions. Clear setup/error state. |
| FFmpeg | Installed binaries in worker | Codec/security updates, resource limits and licensing review for distribution. |
| Remotion / HyperFrames | Optional renderer adapter | Compatibility, deployment and commercial licensing review before enablement. |
| CapCut | Only documented authorized provider workflow | No undocumented project-format dependency; independent editor/export remains required. |

YouTube analytics access requires authorized OAuth scopes ([authorization guide](https://developers.google.com/youtube/reporting/guides/authorization)). TikTok Display API exposes profile/video operations and requires approved products and grants; it should not be treated as an unrestricted analytics feed ([overview](https://developers.tiktok.com/docs/en/display-api-overview), [setup](https://developers.tiktok.com/docs/en/display-api-get-started)). Instagram integration must follow the chosen official flow and account eligibility ([Meta documentation](https://developers.facebook.com/docs/instagram-platform/)).

Every eventual adapter declares operations, authentication, available metrics, account eligibility, rate limits, retry policy and fallback. Store actual granted capabilities per connection. No social OAuth or publishing connector is implemented by merely adding a registry entry.

## 8. Development stages

| Stage | Delivery and acceptance |
| --- | --- |
| 0 — Reliable foundation | Real accounts/workspaces/onboarding, private video upload, technical inspection, durable worker, genuine saved Gemini analysis. Pass tenant-isolation and persistence tests; complete a configured live-cloud test before declaring the full vertical slice proven. |
| 1 — Creator and media intelligence | Editable provenance-aware Creator DNA, collections, transcript/visual search, safe resumable uploads and reference analysis. |
| 2 — Evidence-backed planning | Cited or explicitly evergreen ideas, footage matching, missing shots, scripts, storyboards, idea-to-project lineage. |
| 3 — Editing and exports | Canonical timeline, meaningful preview, real rendering, revisions, platform versions and licensed assets. |
| 4 — Distribution and learning | Approved OAuth connectors, reviewed publishing, real historical metrics, experiments and explainable readiness. |
| 5 — Commercial operation | Team administration, billing/entitlements, robust deletion/export, backups, abuse controls, security/privacy reviews, cost dashboards and service objectives. Predictions only after validated, calibrated historical modelling. |

Later-stage routes can describe their status and the next useful action, but must never display fabricated performance, trend evidence, editor behavior or connections.

## 9. Risks and approximate cost drivers

Exact prices vary by region, model, billing plan and time. Forecast with measured units and current provider calculators rather than an invented flat cost per video.

| Driver | Approximation to measure | Control |
| --- | --- | --- |
| Original storage | Uploaded GiB × retention duration | Per-workspace quotas, deletion, retention choices, duplicate detection later |
| Derived media | Thumbnail/proxy/export GiB | Separate retention and regenerate expendable derivatives |
| Transfer | Upload ingress + private playback/export egress | Proxies, caching controls, region placement and bandwidth limits |
| AI | Input video/audio/text tokens + output tokens × current model rates | Duration/size caps, one active job per asset, bounded retries, usage provenance |
| Worker | CPU/memory time for probing, decoding, encoding and provider waits | Concurrency bounds, timeouts, explicit worker capacity |
| Firestore | Reads/writes, indexes, polling and retained job/audit data | Indexed queries, bounded lists, polling interval and archival |
| Operations | Auth, logs, secrets, monitoring, backups and support | Budget alerts, measured pilot workload and service limits |

An always-running worker has a baseline cost even without uploads. A task-dispatched job topology can reduce idle consumption later, but requires a real dispatcher and idempotent trigger path. Cloud Run worker pools suit continuous non-HTTP consumers; ordinary request-based instances do not guarantee useful CPU after a request finishes ([background execution guidance](https://docs.cloud.google.com/run/docs/configuring/billing-settings), [worker pools](https://docs.cloud.google.com/run/docs/deploy-worker-pools)).

Primary risks: cross-tenant access bugs, leaked credentials, oversized/malformed files, worker interruption, duplicate jobs, provider quotas, model hallucinations, codec incompatibility and incomplete deletion. Commercial launch additionally needs a privacy policy, terms, consent and licensing decisions, incident response, security testing, backup/restore exercises and platform reviews. This repository does not certify legal or platform compliance.

## 10. Stage 0 implementation plan

1. Define shared types and versioned relationships before feature work.
2. Scaffold frontend, API and independently launched worker with environment validation.
3. Implement persistent identity, workspace creation and role-aware authorization.
4. Implement skippable onboarding without social connection requirements.
5. Validate upload size/type, save a private original and record an asset/job.
6. Inspect real media, extract a thumbnail, and show measurable progress.
7. Integrate Gemini behind the worker; validate results and retain provenance/usage.
8. Build source preview, timestamped findings, clip suggestions and saved analysis reopening.
9. Provide honest configuration status, bounded retries and recovery of stale worker claims.
10. Verify authentication, tenant isolation, malformed uploads, persistence, worker behavior and configured live analysis; record unverified criteria explicitly.

Acceptance procedures are in `STAGE_0_ACCEPTANCE.md`. Every future feature must audit existing code, preserve stored data, define acceptance criteria, implement real behavior, test it and update this document, the checklist and changelog.
