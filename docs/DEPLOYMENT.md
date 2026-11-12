# Deployment and operations

## Local environment

Run Node.js 24 or newer. Install FFmpeg and FFprobe and ensure both are in `PATH`, or configure their absolute paths. Copy `.env.example` to `.env`, keep it untracked, and launch the API/frontend and worker independently using the root scripts.

The API defaults to port 3001 and the Vite frontend to 5173. `APP_ORIGIN` must match the frontend origin. API and worker must use the same `CF_DATA_DIR` in local mode. SQLite/private disk is a single-machine development backend; putting it on ephemeral cloud container disks does not make it durable or suitable for a horizontally scaled SaaS.

| Variable | Purpose |
| --- | --- |
| `APP_MODE` | `local` for development; `firebase` for production |
| `NODE_ENV` | `production` on deployed API and worker; local production mode is rejected |
| `PORT` | API listen port, default 3001 |
| `APP_ORIGIN` | Exact browser origin allowed for application requests |
| `CF_DATA_DIR` | Private local database, original files and temporary data root |
| `GEMINI_API_KEY` | Server-side Gemini API key; provide to API and worker using a secret manager |
| `GEMINI_MODEL` | Configurable supported video model; default documented in `.env.example` |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Native binary paths when not in `PATH` |
| `MAX_UPLOAD_BYTES` | Upload cap, default 100 MiB |
| `MAX_VIDEO_DURATION_SECONDS` | Analysis duration cap, default 600 seconds |
| `WORKSPACE_STORAGE_QUOTA_BYTES` | Per-workspace stored-original limit, default 1 GiB |
| `WORKSPACE_MAX_ACTIVE_JOBS` | Per-workspace active job limit, default 3 |
| `FIREBASE_PROJECT_ID` | Firebase / Google Cloud project ID |
| `FIREBASE_STORAGE_BUCKET` | Private bucket name |
| `FIREBASE_WEB_API_KEY` | Firebase public web configuration, not a server secret |
| `FIREBASE_AUTH_DOMAIN` | Firebase authentication domain |
| `FIREBASE_APP_ID` | Firebase web application ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | Local development path to an untracked service-account credential, when ADC is unavailable |

Validate exact variables against `.env.example` and `server/config.ts`. Do not pass secrets in shell command arguments, commit them, or expose them with `VITE_` prefixes.

## Provision Firebase

1. Create a Google Cloud/Firebase project and select suitable regions for Firestore and storage.
2. Register a web application and obtain the public Firebase configuration values above.
3. Enable Google authentication, the production sign-in method implemented in Stage 0. Email/password accounts are available only in local development. Configure authorized domains, support details and provider consent. Add the real deployment origin.
4. Create Firestore in native mode and provision a private Cloud Storage bucket. Disable public object access; do not create public download URLs for originals.
5. Deploy `firestore.rules`, `firestore.indexes.json` and `storage.rules` using the Firebase CLI for the intended project. These rules deny all client SDK reads/writes; the Node API is the only application data path.
6. Give the API service identity only the needed authentication, Firestore and object-storage privileges. Give the worker access only to the resources it needs. Review exact IAM permissions against the enabled functions; do not distribute a project-owner key.
7. Provide credentials through workload identity/Application Default Credentials on Google infrastructure. A downloaded service account JSON file is only a local setup alternative and must remain outside source control.
8. Store Gemini credentials in Secret Manager and grant secret access to the API and worker identities. Stage 0 requires the same server-side Gemini configuration in both deployments: the API checks configuration for status/retry controls and only the worker calls the model. Future worker-capability discovery can remove the API's need for this secret. Enable billing/quotas and set budget alerts according to the actual provider plan.

The current production playback route authorizes workspace access and redirects to a five-minute signed object URL. These URLs are temporary bearer capabilities: do not log or share them. When using workload identity/ADC rather than a private signing key, configure the API service identity's narrowly scoped `iam.serviceAccounts.signBlob` permission for the signing service account (commonly through the Service Account Token Creator role on that account). Verify signing in the deployed environment. Local mode streams the file directly and supports Range requests; cloud playback relies on Cloud Storage's range support after the redirect.

Firebase Admin bypasses client security rules. Every API handler must still verify the session or token and workspace membership/role. Test this against two independently authenticated users before admitting customer data.

## Build and deploy

```sh
docker build -t creatorflow:stage0 .
```

The image's default command starts the API. Run the same image with the worker script as a separate process/deployment. Production API and worker share Firestore and Cloud Storage, not a local filesystem. Worker scratch storage can be temporary because the original remains in object storage.

Recommended pilot topology:

- A TLS frontend/API origin with the built React assets served by the Node API or a correctly configured reverse proxy. Set the production `APP_ORIGIN` exactly; do not wildcard credentialed browser access.
- A Cloud Run service for the API, with no media analysis in request handlers.
- A separately provisioned continuously running worker pool for the polling worker. Set an explicit worker count/concurrency and cost budget. A normal request-based Cloud Run service may not keep CPU available after a response; do not rely on a background loop in such a service.
- Firestore for jobs/records, private Cloud Storage for originals/derivatives, Secret Manager for the Gemini credential, and service identity credentials.

Cloud Run worker pools are intended for continuous background consumers ([deployment documentation](https://docs.cloud.google.com/run/docs/deploy-worker-pools)). An alternative later topology is a real dispatcher plus Cloud Run Jobs or an approved managed queue. Merely scheduling a container does not integrate it with the current queue; implement and test dispatch, idempotency, acknowledgements and retries first.

Choose upload ingress carefully: the application size cap must also fit the hosting platform and reverse proxy request limits. Large/resumable direct-to-storage uploads are not claimed for Stage 0. If the deployed HTTP path has a lower cap, lower `MAX_UPLOAD_BYTES` consistently or implement an authenticated resumable storage-session flow before increasing it.

## Source control and CI

The source repository is [bellababypink/CreatorFlow](https://github.com/bellababypink/CreatorFlow). Stage 0 is prepared on a review branch; use pull requests for subsequent changes. The workflow in `.github/workflows/ci.yml` installs Node 24 and FFmpeg, then runs type checking, tests and a production build.

Use a committed lockfile and `npm ci` for reproducible deployment. Keep `.env`, `.data`, credentials, logs containing secrets and footage outside commits and build contexts.

## Job operation

Monitor worker heartbeat, queued/processing age, attempts, failure codes and output references. Restarting a worker should permit stale claims to recover after the configured lease. Do not manually reset a processing job while a healthy worker owns its lease. Review quota/rate-limit errors before requesting repeated retries.

Blocked configuration is distinct from processing failure. A missing Gemini key does not justify sample analysis. Configure the worker, restart it and explicitly retry the asset when the setup is ready.

Maintain bounded retries and resource limits. FFprobe/FFmpeg parse untrusted media: update the image regularly, run without root, preserve subprocess timeouts and avoid interpolating filenames into shell commands.

Deploy the composite `jobs(status, leaseUntil)` index in `firestore.indexes.json` before starting cloud consumers. Quota reservation, source-asset lock, duplicate digest, and job enqueue commit atomically. Original object storage happens first: a process crash before the database transaction can leave an unreferenced object. Add age-based reconciliation against asset references before commercial operation. Never expire referenced originals as part of orphan cleanup. Asset deletion has a recoverable five-minute lease and atomically releases storage once.

## Data lifecycle and launch gates

Originals, thumbnails, analysis and exports are separate classes. Configure lifecycle rules only after deciding which data may safely expire. User-requested deletion must remove originals and derivatives as well as records. Never place an unconditional expiry on originals without a disclosed product policy.

Before a commercial launch, verify cloud tenant isolation, backups/restore, recovery after worker termination, account deletion/export coverage, quota behavior, monitoring, secret rotation, incident handling, privacy/terms, consent and asset licensing. This repository contains a foundation and deny-by-default client rules; it does not establish that these reviews are complete.
