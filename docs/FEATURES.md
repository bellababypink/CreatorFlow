# Feature completion and verification

Last updated 2026-11-13 for Channel Intelligence. “Implemented” and “verified” are separate claims. This checklist is maintained with each feature; the final delivery report supplies actual executed-check results.

## Stage 0 delivery scope

- [x] Account creation, sign-in/sign-out and persistent profile
- [x] Explicit local-development identity and Firebase production identity implementation (live Firebase acceptance pending)
- [x] Workspace creation, switching and isolated onboarding preferences
- [x] Server-side membership and role enforcement on private routes
- [x] Private original uploads with size/type filters and storage quotas (content inspection is asynchronous)
- [x] Workspace-scoped SHA-256 duplicate rejection and transactional media/job/quota enqueue
- [x] Technical metadata from FFprobe and thumbnails from FFmpeg implementation
- [x] Durable jobs, separate worker, leases, retry counts and errors
- [x] Genuine Gemini integration with validated structured output (live provider acceptance pending)
- [x] Timestamped summaries, useful clip suggestions and source playback implementation
- [x] Saved analysis retrieval and reopening implementation (live generated result acceptance pending)
- [x] Honest provider configuration/status and no fake fallbacks
- [x] Workspace/account exports, asset/workspace deletion and account deletion with reauthentication
- [x] Architecture, acceptance plan, deployment guidance and changelog
- [x] Deny-all client Firestore and Storage rules for the server-only data path
- [x] CI workflow definition for type checking, tests and build

## Verification gates

- [x] Type checking passed
- [x] Automated tests passed
- [x] GitHub Actions PR verification passed on Node 24/Linux (install, type check, tests, build)
- [x] Production frontend build passed
- [x] Browser QA passed for local account, onboarding, upload and reopening (live AI results pending)
- [x] Local tenant-isolation tests passed for records and media endpoints
- [x] Local upload and real FFprobe/FFmpeg processing passed
- [x] Local queue lease recovery, stale-owner rejection and idempotent quota release verified (worker-process interruption test pending)
- [ ] Live Firebase account/storage/database workflow verified
- [ ] Live Gemini video analysis verified with authorized real footage
- [ ] Deployed production cross-tenant access tests passed

Executed automated evidence: `node --import tsx --test tests/*.test.ts server/processing/*.test.ts` passed all 16 tests with zero failures or skips. Coverage includes real HTTP identity and tenant isolation, viewer permissions, byte-range playback, limits, concurrent deletion, failed-enqueue rollback, queue lease recovery, stale-worker rejection, exhausted-lease asset status and fail-closed production configuration. Processing tests validate metadata and reject invalid model timestamps. The real-media test generates a three-second 360 × 640 H.264 video, uploads it through the API, runs a separate worker, verifies actual FFprobe metadata and an FFmpeg JPEG, checks private original bytes and ranges, then reopens persisted records. It deliberately leaves Gemini unconfigured and requires a null analysis. It also covers private dot-directory playback, which originally failed because of Express's default dotfile restriction.

Browser evidence: local account creation, two-step onboarding, video selection/upload, source playback to 0:03, saved metadata after refresh, Creator DNA preference saving, and 390-pixel mobile media review passed. No generated AI result or live cloud behavior is claimed.

TypeScript verification: `node node_modules/typescript/bin/tsc --noEmit` passed after the queue and deletion hardening changes.

## Stage 1: Channel Intelligence

- [x] Secure YouTube OAuth implementation with PKCE, single-use state bound to user/workspace/browser, verified grants, encrypted credentials, refresh leases, revocation, and generation fencing
- [x] Actual configuration/permission/approval/unavailable statuses; no default connected accounts
- [x] Separate-worker YouTube synchronization, native metadata/statistics/Analytics/audience mapping, bounded pagination, retry/error states, and explicit coverage
- [x] Provider/source/definition/unit/scope/window/observation-aware analytics and incompatible-metric separation
- [x] Date/platform/account/type/pillar filters, source-labelled comparisons, available daily history, and observable inventory frequency
- [x] Post metadata review and same-workspace original-video linking; missing video evidence remains unknown
- [x] CSV preview/confirm, immutable source observations, duplicate/conflict rejection, older-observation preservation, and retained creator-confirmed context
- [x] Genuine background Gemini audit implementation with evidence-reference and numeric-observation validation; saved frozen inputs and report download
- [x] Descriptive downloadable evidence report available without AI; never labelled a generated audit
- [x] Source data and dependent audits purged on disconnect, stale workers fenced, and secrets excluded from exports
- [x] Large snapshots split into bounded workspace-owned records without discarding observations
- [x] 55 tests passed with zero failures/skips; TypeScript and production build passed
- [x] Isolated browser walkthrough: file selection, preview/import, pillar filter, post context save/reopen, report download, honest missing-AI state, desktop/mobile review
- [ ] Live Google consent, refresh, synchronization, external revocation, and deployed isolation verified with configured credentials
- [ ] Live Gemini channel audit reviewed against actual authorized evidence
- [ ] Instagram/TikTok live adapters (intentionally gated until first-provider live verification)

Tests include injected provider-protocol responses and isolated HTTP/database fixtures; they do not represent live social data. Stage 0's genuine synthetic-video processing test still passes. Commercial rollout still requires the live acceptance and operational review in `STAGE_1_ACCEPTANCE.md`.

## Explicitly deferred

- [ ] Team invitations and complete organization administration
- [ ] Subscription billing, full entitlement enforcement and commercial usage dashboards
- [ ] Production account deletion/export across every future entity and retained backup policy
- [ ] Resumable uploads, authorized Drive picker and large media transfer architecture
- [ ] Transcript/visual embeddings, collections, saved searches and perceptual duplicate detection
- [ ] Rich provenance-aware Creator DNA and learned style presets
- [ ] Additional social OAuth adapters, provider app review, and live acceptance (YouTube implementation and manual imports now available)
- [ ] Sourced live trends and evidence-backed recommendations
- [ ] Footage matching, missing-shot planning, scripts and storyboards
- [ ] Canonical editable timeline, meaningful preview and real export rendering
- [ ] Platform-specific edits, covers and reviewed publishing
- [ ] Historical experiments and readiness scoring
- [ ] Calibrated goal forecasts based on sufficient comparable historical data
- [ ] Security/privacy/legal/platform/licensing reviews and operational launch readiness
- [ ] Reconciliation/cleanup for originals orphaned if an API process stops after object storage succeeds but before the asset/job transaction commits

Do not mark a deferred feature complete because a route or provider registry entry exists. Mark Stage 0 implementation items only after the corresponding code is present; mark verification only after the relevant check actually runs successfully.
