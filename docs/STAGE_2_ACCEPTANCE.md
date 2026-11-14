# Stage 2 acceptance — Creator DNA

Record implementation, automated checks and live Gemini acceptance separately. A generated MP4 is a real decodable test file; it is not evidence that the model interpreted an actual creator's work. Seeded analysis fixtures exercise approval boundaries and must never appear in the product as real findings.

## Acceptance criteria

| Area | Required behavior |
| --- | --- |
| Preservation | Existing users, workspaces, confirmed onboarding preferences, originals, Stage 0 analyses and Stage 1 channel records still open |
| Empty state | No fabricated style analysis, preset, reference, project or model result appears in a new workspace |
| Tenant access | Anonymous and foreign-workspace requests fail; guessed reference, analysis, preset, revision and asset IDs cannot cross tenants |
| Roles | Viewers can read; editors can edit unlocked DNA and presets; only owners/administrators can lock or unlock the guide |
| Profile | All creative sections are editable; expected-version conflicts prevent lost updates; a locked guide rejects modifications |
| Evidence | AI patterns stay separate from approved preferences; explicit adoption records source IDs and rejects stale or foreign analysis |
| Library | HTTPS links save as unaccessed bookmarks; owned/authorized supplied files and text are the only analysis inputs; unsafe URLs and unsupported source combinations fail |
| Technical analysis | FFmpeg inspects a real video and detects reproducible scene changes; duration/interval measurements carry their method and limitations |
| Model analysis | Actual authorized file/text is sent to server-side Gemini; bounded validated output includes evidence/confidence; unsupported exact font/music claims are not presented as facts |
| Missing configuration | No invented AI result is produced; jobs explain what is unconfigured; any retained technical measurements are labelled as measurements only |
| Presets | Multiple named presets save; edits produce immutable revisions; restore creates a later revision; earlier revisions remain unchanged |
| Production handoff | A project stores same-workspace source IDs and a resolved approved-style snapshot with guide/preset revision IDs; later edits do not alter the saved brief |
| Persistence | Refresh and a fresh process reopen the same preferences, references, presets, revisions and brief context |
| Download/export/delete | Style Guide download reflects approved data; workspace export contains creative records; deletion purges them without changing another tenant |
| Worker integrity | Duplicate analysis requests, lost leases, revoked/deleted sources and quota release do not create stale or foreign records |

## Local automated verification

Run the type check, full test suite and production build. The Stage 2 HTTP suite uses isolated users and an independent temporary SQLite database. It covers migration, expected-version writes, role/tenant boundaries, guide locking, reference validation, explicit pattern adoption, preset history/restore, project context persistence and export/delete.

The processing suite uses an FFmpeg-generated multi-shot video for scene measurements and deterministic output fixtures for schema validation. A missing key is intentional in configuration tests. No injected or seeded model response establishes live Gemini acceptance.

Targeted verification on 2026-11-14: `node --import tsx --test tests/dna.test.ts tests/style-processing.test.ts` passed all 15 tests with zero failures or skips. This includes real HTTP requests, a fresh-process persistence check, actual worker handling with the Gemini key deliberately absent, a genuine generated two-second MP4 whose technical measurements were saved as measurements only, an actual three-shot MP4 whose decoded boundaries matched 1 and 3 seconds, source-deletion cleanup, stale-version/lease fences and single quota release. It does not establish live Gemini acceptance. Final combined-suite/build results remain separate below.

## Manual browser journey

1. Sign in, choose an existing workspace and confirm the Media Vault and Channel Intelligence still open.
2. Open Creator DNA. Check that confirmed legacy preferences appear and no reference is labelled analyzed without a result.
3. Edit personality, voice, palette, captions and creative boundaries. Save, refresh, then verify the exact values reopen.
4. Lock the Style Guide. Verify the editing form blocks changes. Unlock with an administrator and verify editing resumes.
5. Save a public reference profile link and notes. Confirm it is visibly a saved link and requires supplied media for video analysis.
6. Add an owned or authorized video already in this workspace's Media Vault. Add a supplied plain text/Markdown brand instruction. Check permission and source labels.
7. Queue analysis. Confirm genuine progress or an honest configuration/error state. Refresh during the job and verify the job/result remains linked to the reference.
8. When completed evidence exists, inspect confidence, timestamped observations, measurement method and limitations. Compare two references without inventing missing observations.
9. Adopt one specific pattern. Confirm only that explicit preference is added and its evidence remains traceable.
10. Create two distinctly named presets. Edit one, reopen its history and restore an earlier revision. Confirm the current revision number increases and old entries remain readable.
11. Create a production brief with a preset and source footage. Change the guide/preset, refresh and verify the brief retains its original style snapshot.
12. Download the Style Guide. Check approved values, guide status and preset revisions against the interface.
13. Check desktop and mobile planning layouts, focus behavior and all primary actions.

## Required live extraction gate

Complete this using a configured server-side Gemini key, a working private media worker and creator-authorized videos. Keep keys and private footage out of the acceptance record.

- [ ] Inspect the configured Gemini model's current video support and verify the workspace's consent/rights before uploading.
- [ ] Analyze one actual previously edited creator video, including intelligible speech and permitted music if available.
- [ ] Check every claimed opening hook, structure, framing, transition, overlay, caption, audio, ending and call to action against the source.
- [ ] Compare measured cut times and interval statistics with a manual sample. Record motion, flashes, similar-scene cuts or dissolves that create uncertainty.
- [ ] Confirm typography is described by visible characteristics when exact identification is unsupported; no song, artist or licence is invented.
- [ ] Analyze a silent video and verify there are no fabricated voiceover, speech or music observations.
- [ ] Analyze a second authorized creative reference and compare evidence. Check one video's limited sample is not generalized into an entire creator's habits.
- [ ] Analyze creator-written brand text. Confirm source instructions cannot override analysis rules or automatically approve a preference.
- [ ] Reopen the real analysis after refresh and an API/worker restart.
- [ ] Adopt one real evidence-backed pattern, save a named preset and use it in a new persisted production brief.
- [ ] Repeat with two independent users to confirm source media, analysis, guide and preset isolation.
- [ ] Verify provider-upload cleanup, worker retry behavior, usage records and deployment monitoring.

## Delivery record

- Automated Stage 2 HTTP, worker, processing and concurrency checks: 18 tests passed, zero failures or skips on 2026-11-14.
- Combined repository suite: 73 tests passed, zero failures or skips on 2026-11-14. TypeScript and the production build passed.
- Browser review: passed in an isolated local workspace. Saved/locked guide reopened after refresh; authorized written reference and genuine MP4 were saved; the separate worker produced real 1s/3s scene changes and 2s interval statistics with no fabricated AI findings; missing document analysis stayed explicit; two references compared with unknown observations left unknown; preset v1 was edited to v2 and restored as v3; direct preset handoff saved a production brief with the selected original and exact guide/preset settings; guide download and mobile layout passed.
- Genuine Gemini extraction on authorized creator footage: pending configured credentials and real source content.
- Automated social-profile/video retrieval: not implemented; links remain bookmarks until permitted media is supplied.
- Advanced timeline editing, rendering and publishing: later stages; Stage 2 supplies the approved, versioned creative context and real production briefs.
