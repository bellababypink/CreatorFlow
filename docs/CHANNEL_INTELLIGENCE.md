# Channel Intelligence

Stage 1 extends the existing account, workspace, storage, and worker foundations. It does not replace Stage 0 records or media analysis. Its first provider is YouTube. Instagram and TikTok live adapters must not be enabled until the first provider's live acceptance procedure has passed; clearly attributed manual imports support creators whose approved APIs do not expose the needed data.

## Evidence and ownership

Every connection, post, observation, import, audit, and job belongs to a workspace. The API checks the authenticated user and stored membership before reading or changing it. A connection identifier alone never grants access. Owners and administrators manage authorization; the server applies role checks independently of button visibility. OAuth tokens, refresh tokens, PKCE verifiers, and browser-binding secrets never belong in public connection responses or downloadable workspace exports.

Source records use stable IDs. A normalized metric retains its provider name, original metric identifier, definition, unit, time scope, measured period, observation time, and provenance. Missing data remains unavailable rather than becoming zero. An import is user-supplied evidence; it does not prove account ownership or create an authorized provider connection.

## First provider: YouTube

The authorized flow requests read access to channel/video metadata and eligible YouTube Analytics reports. Signing into CreatorFlow through Google is separate from consenting to channel access. CreatorFlow must not assume that a Firebase sign-in grants YouTube scopes.

1. Create a Google Cloud project or select an existing project you control.
2. Enable the YouTube Data API and YouTube Analytics API in that project.
3. Configure an OAuth consent screen, the correct audience, support details, and test users when applicable.
4. Create a confidential OAuth client of type **Web application**.
5. Register the exact callback URI used by this installation: `http://localhost:5173/api/channels/oauth/youtube/callback` in local development, or the equivalent HTTPS `APP_ORIGIN` in deployment. Scheme, hostname, port, and path must match. Use the documented localhost URL consistently rather than substituting an IP address.
6. Configure `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_REDIRECT_URI` on the server. Keep the client secret outside source control and browser bundles.
7. Configure `CHANNEL_TOKEN_KEY` as a protected 32-byte base64 encryption key in production. Keep API and worker deployments on the same key. Local development may use the explicitly local private key file maintained under the configured data directory. Back up and rotate keys deliberately; changing the key without migration can require reconnection.
8. Restart the API and worker. An administrator can then start the connection flow from Channel Intelligence, review Google's requested permissions, and choose the intended channel.

The two requested Google scopes are `https://www.googleapis.com/auth/youtube.readonly` and `https://www.googleapis.com/auth/yt-analytics.readonly`. Granted scopes must be inspected, not assumed. Google consent, account eligibility, API enablement, provider quotas, and app verification still apply. External OAuth applications in Google's Testing state can have seven-day refresh-token expiry for these scopes. Production rollout requires the applicable verification process. [Google OAuth guidance](https://developers.google.com/identity/protocols/oauth2/web-server), [token lifecycle](https://developers.google.com/identity/protocols/oauth2)

The flow binds a short-lived, single-use state to the initiating user, workspace, and browser. PKCE binds the returned code to that authorization attempt. Refresh and revoke calls remain server-side. Refresh failures must produce a permission/setup state rather than a fabricated connection. Disconnect fences in-flight synchronization so stale work cannot recreate a revoked connection or its data.

## What the data means

The Data API supplies available channel metadata, uploads, video metadata, and eligible statistics. YouTube Analytics provides permitted report dimensions and metrics for a requested reporting window. The adapter records bounded pagination and incomplete coverage. It does not silently claim that a limited upload sample is the entire channel history.

| Data | Interpretation |
| --- | --- |
| Video statistics | Provider-reported cumulative observations at a stated time; not views earned in the publication-date filter window |
| Analytics report | Activity within the requested reporting bounds, with provider definitions and processing latency; YouTube uses Pacific reporting dates |
| Daily series | Provider-reported day-level observations; absent dates are not automatically zero |
| Audience data | Available only if the provider returns an authorized report; privacy thresholds can suppress it |
| Publication-date filter | Selects posts by their publication time; does not change a lifetime metric into a period metric |
| Content type | An observed provider/import value; duration alone does not establish that a YouTube video is a Short |
| Content pillar | Creator-confirmed or explicitly imported classification; an AI suggestion is not an approved rule |
| Hook or visual treatment | Requires authorized source-video analysis, a linked Stage 0 asset, or explicit supplied evidence; titles alone cannot prove video editing choices |

YouTube does not provide a source-video download through the metadata APIs. CreatorFlow must not scrape or download YouTube audiovisual content to fill that gap. A creator can separately upload a video they are authorized to process and link that private workspace asset to a post. Audience-report suppression is an unavailable-data state. [YouTube data model](https://developers.google.com/youtube/analytics/data_model), [developer policies](https://developers.google.com/youtube/terms/developer-policies/)

YouTube report dates use Pacific time and results may stop at the latest fully processed day rather than the requested end date. Missing days are not zero-filled or described as a complete recent period. [YouTube time dimensions](https://developers.google.com/youtube/analytics/dimensions)

## Comparisons and audits

Compare metrics only when their provider definition, source, unit, time scope, and reporting window match. Lifetime aggregates also retain their UTC observation-date cohort; stale counts from one export are not silently added to newer counts from another export as if they shared an as-of date. Keep each account and platform visible. Do not present a combined cross-platform views total, a universal engagement rate, or a probability of success. Different view definitions and reporting windows are not interchangeable.

Audits distinguish observed associations from explanations or proposed experiments. A stronger-performing topic in a small sample is not evidence that the topic caused the result. Age, exposure, sample size, unavailable metrics, incomplete imports, and video availability limit the conclusions.

An AI audit must be generated from the actual selected records and preserve the IDs of supporting posts and snapshots. Reject evidence references outside that input. Numeric observations in the summary and non-experiment findings are checked against their available cited source numbers; unsupported numeric values cause the result to be rejected. Proposed experiment parameters remain explicitly prospective. These checks validate structure, references, and the presence of numbers, not every semantic implication in prose: the creator must review cited evidence and limitations before relying on a recommendation. Report unavailable hook/visual evidence explicitly. A failed or unconfigured Gemini request must not create a successful audit. The downloadable descriptive evidence report can remain useful without Gemini, but must identify itself separately from an AI-generated audit.

YouTube's policy restricts derived API metrics, and the current policy guide describes an approval path for audited analytics use cases. Do not treat an internally calculated engagement score, ratio, or other derived metric as a supported YouTube metric. Any such extension needs the relevant provider approval and clear product attribution before enablement. [Developer policy guide](https://developers.google.com/youtube/terms/developer-policies-guide)

`YOUTUBE_DERIVED_ANALYTICS_APPROVED=true` is an operator assertion that the applicable approval has actually been obtained; it does not obtain permission from Google. Keep it unset otherwise. Raw provider metrics and the descriptive evidence report remain available. Manual imports keep their supplied definitions and do not imply authorization to repurpose restricted API data.

## Manual analytics imports

Import is an explicit preview-and-confirm operation. Validate the complete CSV before writing records. Keep the platform, account label, original post identifier, publication date, measurement scope, reporting window, and observation date. Empty optional metric cells mean unavailable; an entered numeric zero is a measured zero. Reject malformed dates, non-finite or negative metrics, oversized input, duplicate/conflicting post observations, and values outside documented bounds.

The current canonical header is:

```csv
postId,title,publishedAt,durationSeconds,contentType,pillar,caption,tags,url,metricScope,periodStart,periodEnd,observedAt,views,likes,comments,shares,reach,impressions,watchTimeSeconds,averageViewDurationSeconds,engagementRatePercent,viewsDefinition
```

`postId`, `publishedAt`, `metricScope`, and `observedAt` must be present and populated. Scope is `lifetime` or `period`; period rows require `periodStart` and `periodEnd` as calendar dates. The import cap is 100,000 UTF-8 bytes and 200 data rows. Use the application's downloadable template to stay aligned with the parser. Do not infer missing period boundaries or silently rename a provider's metric. A repeated confirmed import must not multiply posts or observations. Every accepted export keeps an immutable observation snapshot; the current post retains the latest value for each distinct metric cohort. Uploading an older export does not replace a newer observation. A different value for the same metric, definition, reporting window, and observation time is rejected for reconciliation. New periods do not erase lifetime observations, and creator-confirmed pillars and authorized media links survive later imports. Imported accounts remain visibly marked **manual import** and do not show an OAuth connection or invented permissions. A new import must not overwrite an authorized provider connection's secrets or provenance.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| Connected | Successful provider authorization and a recognized account; current grants and sync time are visible |
| Needs Permission | Missing, expired, revoked, or insufficient grants require creator action |
| Requires Developer Approval | An operator/provider approval gate must be completed before the live integration can be used |
| Not Configured | Required application credentials or endpoint configuration are absent |
| Unavailable | The capability is not implemented/available for this connection or account; imported evidence is not a live connection |

Configuration alone does not prove that a user has connected a channel. A synchronization timestamp must refer to a real successful sync. Partial data includes explicit coverage limitations and missing permissions; it is not silently promoted to a full audit.

## Retention, revocation, and operations

Disconnect should revoke the provider token immediately and purge authorized API-derived data promptly. YouTube's policy sets a seven-day maximum for deletion after in-product revocation; external revocation requires authorization rechecks and associated deletion. Metadata needs refresh or deletion within the applicable 30-day limit, and longer retention of authorized statistics still needs periodic authorization and deletion checks. These requirements apply to derived audits as well as the source records. [YouTube handling requirements](https://developers.google.com/youtube/terms/developer-policies/)

An operator must implement and verify recurring refresh/reconfirmation, deleted-video reconciliation, purge retries, backup handling, and failure monitoring before a customer launch. Key rotation, provider quota management, app verification, privacy disclosures, and retention review remain deployment responsibilities. The existence of an OAuth adapter does not certify platform or legal compliance.

See [Stage 1 acceptance](STAGE_1_ACCEPTANCE.md) for local protocol tests and the separate live-provider release gate.
