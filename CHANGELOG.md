# Changelog

## 0.1.0 — Stage 0 implementation, 2026-11-12

- Established the architecture for workspace-owned identity, media, analysis and durable background jobs.
- Added product stages, provider feasibility, data relationships, cost drivers and a concrete acceptance plan.
- Added deny-by-default Firebase client rules and deployment guidance for an independent Node API and media worker.
- Added a CI workflow definition. Executed test results and cloud/provider acceptance remain separately tracked in `docs/FEATURES.md`.
- Added the responsive Command Centre, creator onboarding, editable preferences, private Media Vault, source playback, analysis view, setup registry, and privacy controls. Later-stage routes describe their actual delivery status.
- Implemented production Firebase authentication/storage/records adapters and an explicitly labelled persistent local development backend.
- Added real server-side Gemini video analysis, FFprobe metadata, FFmpeg thumbnails, durable background jobs, bounded retries, and model/usage provenance.
- Hardened atomic quota/job enqueue, duplicate rejection, worker leases, concurrent deletion, and private API caching.
- Fixed authorized media playback under hidden private storage directories.
- Verified 16 automated tests with zero skips, TypeScript, production build, local browser onboarding/upload/playback/persistence, and mobile review. Live Firebase/Gemini acceptance remains pending configuration.
