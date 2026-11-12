# CreatorFlow AI

CreatorFlow is a creator workspace built around a real account → workspace → upload → background processing → saved video analysis journey. React and TypeScript provide the interface; a Node API owns authorization and uploads; a separate worker performs FFprobe/FFmpeg inspection and server-side Gemini analysis.

The repository is the Stage 0 foundation. Social connections, live analytics, advanced editing, rendering and publishing are later stages. Their setup states must not be interpreted as working integrations. No sample analysis or performance metrics substitute for real provider results.

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

Use the local URL printed by Vite. Create your own account and workspace; no pilot brand is preloaded. Local accounts and uploads persist in `.data` across restarts. Local mode is explicitly a development mode, not the production authentication or storage backend. Production must use Firebase and does not fall back to local storage when cloud configuration is missing.

Add `GEMINI_API_KEY` to the server environment to run genuine video analysis, then restart the worker. A key is never needed in the browser. Without it, upload/metadata behavior can be exercised but AI analysis remains blocked with an explicit setup status. Do not commit `.env`, `.data`, service account files or user footage.

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
- [Deployment and operations](docs/DEPLOYMENT.md)
- [Changelog](CHANGELOG.md)

Before adding features, audit existing components and data, define acceptance criteria, preserve existing records, implement real behavior, run appropriate checks, and update these documents. Creator preferences belong to workspace records rather than source-code defaults.
