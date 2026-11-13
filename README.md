# CreatorFlow AI

CreatorFlow is a creator workspace built around a real account → workspace → upload → background processing → saved video analysis journey. React and TypeScript provide the interface; a Node API owns authorization and uploads; a separate worker performs FFprobe/FFmpeg inspection and server-side Gemini analysis.

Stage 1 adds Channel Intelligence to the existing foundation: a real YouTube OAuth adapter, separate synchronization and audit jobs, normalized source-labelled analytics, CSV preview/import for all three platforms, post-to-footage links, and downloadable evidence/audit reports. Live YouTube acceptance and Gemini execution require server configuration; no account is connected by default. Instagram and TikTok live adapters remain gated until the first provider is verified. Advanced editing, rendering, and publishing remain later stages. No sample analysis or performance metrics substitute for real provider results.

## Run locally

Requirements: Node.js 24+, npm, FFmpeg and FFprobe. Install native media tools through your operating system package manager. Keep the API and worker on the same machine in local mode so they share the SQLite database and private `.data` directory.

```sh
npm install
cp .env.example .env
npm run dev
```

In a second terminal:

```sh
npm run worker
```

Open `http://localhost:5173`, matching `APP_ORIGIN` in `.env.example`. Create your own account and workspace; no pilot brand is preloaded. Local accounts and uploads persist in `.data` across restarts. Local mode is explicitly a development mode, not the production authentication or storage backend. Production must use Firebase and does not fall back to local storage when cloud configuration is missing.

Add `GEMINI_API_KEY` to the server environment to run genuine video analysis, then restart the worker. A key is never needed in the browser. Without it, upload/metadata behavior can be exercised but AI analysis remains blocked with an explicit setup status. Do not commit `.env`, `.data`, service account files or user footage.

## Channel Intelligence setup

Open Channel Intelligence in an existing workspace. CSV imports work without social credentials or Gemini; download the header-only template, preview your own export, and confirm it. Imported values retain their source, definitions, observation times, and reporting periods, and never appear as a live connection.

For YouTube, configure `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_REDIRECT_URI` on API and worker. The callback must exactly match `APP_ORIGIN/api/channels/oauth/youtube/callback`. Set a shared `CHANNEL_TOKEN_KEY` in production. See [Channel Intelligence setup and data semantics](docs/CHANNEL_INTELLIGENCE.md) and the [live acceptance gate](docs/STAGE_1_ACCEPTANCE.md). Tokens stay encrypted on the server. Only the worker performs synchronization and genuine Gemini audits.

The descriptive evidence report downloads without AI. A generated audit requires a configured Gemini key and actual source data. YouTube inference additionally requires the applicable provider approval; the configuration flag records an approval already obtained and does not grant permission itself.

## Verify

```sh
npm run typecheck
npm test
npm run build
```

See [Stage 0 acceptance](docs/STAGE_0_ACCEPTANCE.md) for the manual and live-provider test. Passing local tests does not prove a deployed Firebase/Gemini journey; that requires a configured project, valid provider credentials and authorized real footage.

## Production setup

Use Firebase Authentication, Firestore, a private Cloud Storage bucket and separate API/worker deployments. Read [deployment instructions](docs/DEPLOYMENT.md) before provisioning. Firebase client rules deliberately deny all direct record and object access; server authorization remains essential because Firebase Admin bypasses those rules.

The Node/FFmpeg worker cannot be deployed as a static website or Cloudflare Worker. Keep long media work outside upload HTTP requests. The supplied Docker image supports the API and a separately launched worker; cloud deployment and identity/provider configuration remain operator tasks.

## Project documents

- [Architecture and roadmap](docs/ARCHITECTURE.md)
- [Feature completion and verification checklist](docs/FEATURES.md)
- [Stage 0 acceptance procedures](docs/STAGE_0_ACCEPTANCE.md)
- [Channel Intelligence and OAuth setup](docs/CHANNEL_INTELLIGENCE.md)
- [Stage 1 acceptance procedures](docs/STAGE_1_ACCEPTANCE.md)
- [Deployment and operations](docs/DEPLOYMENT.md)
- [Changelog](CHANGELOG.md)

Before adding features, audit existing components and data, define acceptance criteria, preserve existing records, implement real behavior, run appropriate checks, and update these documents. Creator preferences belong to workspace records rather than source-code defaults.
