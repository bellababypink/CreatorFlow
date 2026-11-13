# Stage 1 acceptance

Record implementation, automated test results, live-provider verification, and rollout approval separately. Local HTTP tests and mocked OAuth responses exercise code paths; they do not prove that Google has authorized this application or that a creator's real channel has been accessed.

## Preservation and scope

- Existing accounts, workspaces, uploaded originals, metadata, and Stage 0 analyses remain readable.
- Every new connection, post, snapshot, import, audit, and job has workspace ownership and stable references.
- YouTube is the first live adapter. Instagram and TikTok retain truthful setup states and manual imports until the YouTube live gate passes.
- No sample analytics, sample connected accounts, or fabricated AI findings appear in a new workspace.

## Local automated checks

Run the repository's type check, test suite, and production build. The Channel Intelligence HTTP suite uses isolated temporary data and distinct local users. Test fixtures must never be presented in the application as real provider data.

| Area | Required checks |
| --- | --- |
| Identity and access | Anonymous requests rejected; wrong workspace denied; viewer mutation denied; editor/admin/owner permissions follow the API contract |
| OAuth start | State is unpredictable and short-lived; authorization request uses expected scopes, exact callback, and S256 PKCE |
| OAuth callback | Wrong user/workspace/browser binding, expired state, replayed state, denied consent, and missing grants handled without a successful connection |
| Tokens | Encrypted at rest; no access/refresh token in API JSON, exports, logs, HTML, or browser storage |
| Refresh | Expired access token refreshes once; rotated values persist; invalid grant moves to a permission state; refresh cannot resurrect a disconnected generation |
| Synchronization | Bounded real API response mapping; pagination/coverage explicit; lifetime and period metrics remain distinct; no missing values zero-filled |
| Revocation | In-product revoke called; local token removed; provider-derived records/audits purged or a visible retry state retained; stale job cannot commit after disconnect |
| Import | Preview performs no write; malformed CSV rejected; confirmation preserves provenance; repeated import is idempotent; older exports cannot replace newer observations; conflicting observations are rejected; period/lifetime history and creator labels/media links survive reimport; imported account is not shown as OAuth-connected |
| Post review | Metadata visible; linked media must belong to the same workspace; unavailable footage produces an honest evidence limitation |
| Comparison | Platform/source/definition/window incompatibility never produces a combined metric; filters operate on the documented dimensions |
| Audit | Real selected evidence only; input IDs and numeric observations checked against available cited inputs; unsupported audience inference rejected; missing Gemini key does not generate a successful audit; report downloads include provenance and limitations; prose still requires human review |
| Deletion/export | Workspace deletion includes new records and secrets; exports exclude tokens/verifiers/state/browser bindings; revocation/deletion cannot leak data into another tenant |

## Manual local journey

1. Sign in and select an existing workspace. Confirm the existing Media Vault still opens.
2. Open Channel Intelligence. Confirm all three platforms display an exact integration status and an actionable reason.
3. Download the current manual-import template. Enter a small authorized analytics export with known values and explicit observation/report periods.
4. Preview the CSV. Check each parsed value, unavailable metric, source label, and warning. Cancel once and confirm no records appear.
5. Confirm the import. Refresh the browser, then confirm the same posts and metric provenance reopen.
6. Reimport the identical CSV. Confirm posts, observations, and totals do not multiply.
7. Filter by date, platform, content type, and content pillar. Check known posts enter/leave the result as expected.
8. Open a post. Link one authorized Media Vault asset from this workspace. Confirm its saved analysis is used only when actually available. Try another workspace's asset through the API and confirm denial.
9. Download the descriptive audit/evidence report. Confirm source dates, IDs, definitions, coverage, and limitations match the visible data.
10. If Gemini is unconfigured, request an AI audit and confirm an explicit blocked/error state, without an invented result.

## Required live YouTube gate

Complete this using a configured OAuth client and a channel whose owner consents. Do not place tokens or private footage in the acceptance record.

- [ ] Google Cloud project, APIs, consent audience, authorized redirect URI, and required test/production approval confirmed.
- [ ] Connect from an authenticated workspace and select the intended channel through Google's consent screen.
- [ ] Verify the returned channel name and ID against YouTube Studio; record only non-secret identifiers and the test date.
- [ ] Confirm granted/missing permissions match actual consent, including a partial/denied-consent attempt.
- [ ] Synchronize real posts. Compare a known post's title, date, duration, and available counts with the source at the observation time.
- [ ] Compare a permitted Analytics report with the same dates, definitions, and timezone. Record report latency or suppression rather than treating a difference as invented data.
- [ ] Exercise an expired access token and observe a real successful provider refresh without renewed consent.
- [ ] Restart API/worker and verify the encrypted stored connection can resume with the configured key.
- [ ] Revoke from CreatorFlow, verify the provider revocation and local purge, then reconnect only through fresh consent.
- [ ] Revoke from Google's account security page; verify the next refresh/sync detects it and required cleanup completes.
- [ ] Verify stale in-flight synchronization cannot restore revoked records.
- [ ] Test two independently signed-in real users and confirm connection, metrics, report, secret, and post isolation.
- [ ] Complete a genuine Gemini audit from actual authorized/imported records; verify every cited post and every quantitative claim manually.
- [ ] Download and inspect the saved audit report after refreshing.
- [ ] Confirm the intended retention/reconfirmation/deleted-video process and monitoring are deployed and tested.

Only then extend live authorization to another platform. The operator must also review current API policy, verification, usage restrictions, and privacy disclosures for each added provider.

## Delivery evidence

Populate this section only with executed results. Until a live test is recorded above, describe YouTube as an implemented/tested adapter requiring live acceptance, not a verified connected integration.

- Analytics/HTTP verification: `node --import tsx --test tests/channel-analytics.test.ts tests/channels.test.ts` passed all 18 tests with zero failures or skips on 2026-11-13. This includes 11 analytics/parser/audit-validation tests and the six-subtest real HTTP workflow plus its parent test. The HTTP suite uses isolated SQLite records and local accounts; it does not contact Google or Gemini.
- TypeScript: `node node_modules/typescript/bin/tsc --noEmit` passed after the analytics and API integration changes. The final full-suite/build evidence is maintained in the feature checklist by the owning implementation task.
- YouTube OAuth protocol tests and production build: pending this implementation's final verification record.
- Live YouTube connection/refresh/sync/revoke: pending configured credentials and authorized channel.
- Live Gemini channel audit: pending server configuration and real evidence.
- Instagram/TikTok live adapters: gated on first-provider verification.


Final combined local verification on 2026-11-13: all 55 tests passed with zero failures or skips; TypeScript and the production frontend build passed. This includes 16 YouTube authorization/protocol tests (injected Google responses), 5 atomic-worker/snapshot tests, 18 analytics/HTTP tests, and the existing 16 Stage 0/processing tests. Browser QA used an isolated temporary server and an explicitly labelled two-row QA CSV; no live account data or Gemini response was fabricated. CSV file selection, preview/confirm, pillar filtering, saved context after refresh, descriptive report download, and desktop/mobile layouts were verified. The QA dataset was removed after testing.
