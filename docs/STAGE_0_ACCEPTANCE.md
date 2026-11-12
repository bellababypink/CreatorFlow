# Stage 0 acceptance

Full acceptance means an authenticated user can create a workspace, upload a real authorized video, receive genuine Gemini findings, refresh, and reopen that same saved analysis. A passing build or a screenshot alone is insufficient.

## Required setup

- Node.js 24+, installed dependencies, FFmpeg and FFprobe.
- API, frontend and independently running worker.
- For the full production test: configured Firebase Auth, Firestore, private Cloud Storage, service identity permissions and a valid server-side Gemini key.
- A short video the tester owns or has permission to upload. Do not put customer footage in test fixtures or source control.

## Automated checks

Run `npm run typecheck`, `npm test` and `npm run build`. Record the exact passing commands and limitations in the delivery report. Tests using local identity/storage or provider doubles validate those boundaries; they cannot establish live Firebase/Gemini correctness.

## Manual acceptance criteria

| ID | Procedure | Required result |
| --- | --- | --- |
| A01 | Start with an empty data store; open app | No fabricated media, analytics, connected accounts or inferred brand rules |
| A02 | Create account; sign out; sign in again | Actual persistent identity; invalid credentials rejected |
| A03 | Create two workspaces with different onboarding preferences | Switching preserves each workspace's independent name/preferences/assets |
| A04 | Skip onboarding fields | Dashboard remains usable without a social connection |
| A05 | Upload authorized supported video | Original is private, asset/job IDs persist, upload request returns before AI processing completes |
| A06 | Inspect metadata | Duration/dimensions/frame rate/audio match FFprobe; thumbnail derives from the actual file |
| A07 | Process with valid Gemini key | Actual model summary and useful ranges are returned, schema validated and saved with provenance |
| A08 | Click a timestamped suggestion | Source preview seeks to the suggested range; timestamps are described as approximate |
| A09 | Refresh, then restart API/worker and reopen asset | Stored original, metadata and completed analysis are still available |
| A10 | Remove Gemini configuration | Clear blocked/setup state; no sample summary or fake successful job |
| A11 | Trigger a provider error | Error surfaced without leaked credentials; bounded retry behavior; no fabricated output |
| A12 | Stop worker during processing; restart after lease expiry | Job can recover without permanent lock or conflicting final writes |
| A13 | Upload oversized, unsupported or malformed file | Validation rejects it; no publicly accessible file or executable content |
| A14 | Sign in as a second independent user; request first workspace's IDs | Asset lists/details, streams, thumbnails, mutation, jobs and exports are denied |
| A15 | Use viewer membership where supported | Reads permitted within scope; uploads/edits/deletions rejected |
| A16 | Request media with HTTP Range | Authorized playback returns correct partial bytes; unauthenticated access denied |
| A17 | Request workspace data export | Contains only the authorized workspace's records and does not expose password hashes, sessions or provider secrets |
| A18 | Delete an asset | Original and derivatives inaccessible; associated records/jobs handled safely |
| A19 | Open all ten navigation destinations | Real routes; deferred features accurately labelled and no fake analytics/editor behavior |
| A20 | Start production with local mode or missing Firebase configuration | Startup fails closed; never silently falls back to local accounts/storage |

## Production live test evidence

Record a sanitized test date, deployment revision, workspace ID, asset ID, job ID, model, and terminal status. Record technical metadata and whether the saved result survived refresh. Do not include tokens, private footage, or user-identifying transcripts in public evidence. Confirm the storage object is private and the cross-tenant tests pass against the deployed backend.

Until these live steps pass, report “implementation present; live cloud/provider acceptance unverified.” A missing key, no source footage, absent worker or undeployed Firebase project is a setup blocker, not a successful vertical slice.
