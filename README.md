# Collaborative Study Platform

Stack: React 19 + Vite, Node.js, Express 5, Socket.IO, MongoDB native driver, Cloudinary, Groq, Google Gemini, and Nodemailer SMTP.

## Run on Windows

Keep an existing `server/.env` file; only copy `server/.env.example` to `server/.env` if the file does not already exist. Configure `MONGODB_URI` before starting the server. The Vite development server proxies `/api` and Socket.IO to `http://127.0.0.1:5000`, so a stale `VITE_API_BASE_URL` does not redirect local development requests. If the backend uses another port, set `VITE_DEV_API_PROXY_TARGET` in `client/.env`.

In the first PowerShell terminal:

```powershell
Set-Location C:\Users\muham\Collaborative-Study-Platform\server
npm.cmd run dev
```

In a second PowerShell terminal:

```powershell
Set-Location C:\Users\muham\Collaborative-Study-Platform\client
$env:VITE_DEV_API_PROXY_TARGET = 'http://127.0.0.1:5000'
npm.cmd run dev
```

Open `http://localhost:5173`. Set `GROQ_API_KEY` and/or `GEMINI_API_KEY` in `server/.env` to enable those AI providers; keys are used only by the server. Resource uploads require `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. If Cloudinary returns `deny or ACL failure` for a PDF preview, allow PDF delivery and shared access in the Cloudinary account security settings. The backend health endpoint is `http://localhost:5000/api/health`.

MongoDB is accessed through the official `mongodb` driver. Shared notes, room records, users, and resource metadata are stored in MongoDB; PDFs and images are stored in Cloudinary. The server creates the `rooms` and `users` collections and a unique email index at startup, seeds the existing `study-room-1` default, and migrates room IDs found in existing notes/resources without deleting or overwriting those records.

Study rooms remain public and do not require sign-in. Create Room persists a room on the backend, and Join verifies the room exists before connecting to its Socket.IO channel. Registered users must verify their email before signing in. Sessions use an HttpOnly, expiring cookie; passwords use Node's scrypt password KDF. Verification and password-reset links are consumed by the backend; reset tokens are kept out of the frontend and exchanged for a short-lived HttpOnly reset cookie. Registration and password reset require `JWT_SECRET` (at least 32 non-placeholder characters) plus `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS` in `server/.env`. `CLIENT_URL` should be the browser URL used after email confirmation; `API_PUBLIC_URL` should be the externally reachable backend origin used by email links (it defaults to the client origin when the app proxies `/api`). `CLIENT_ORIGIN` should list permitted frontend origins. `SMTP_FROM` is optional and defaults to the SMTP user. No SMTP credential values belong in the client.

The dashboard now reports live room, non-empty note-document, and resource counts. Signed-in users see counts for rooms they created; signed-out visitors see community counts. The app does not store focus time or weekly goals, so those preview metrics have been removed rather than presented as real data. Recent activity is calculated from actual room, note, and resource timestamps.

Run backend tests with `npm.cmd test` from `server`, and build the frontend with `npm.cmd run build` from `client`.

## Production deployment: Vercel frontend and persistent API

Deploy the Vite frontend from the `client` directory as a Vercel project (framework preset **Vite**, build command `npm run build`, output directory `dist`). `client/vercel.json` provides the SPA fallback for client-side navigation. Set the Vercel build environment variable `VITE_API_BASE_URL` to the HTTPS **origin only** of the API, such as `https://api.example.com`; production builds fail rather than silently targeting localhost or the Vercel frontend for API/Socket.IO requests. This variable is public and must never contain credentials.

Run `server` as a persistent Node.js service on a host that supports long-lived HTTP and WebSocket connections. The backend creates a custom HTTP server and attaches Socket.IO to it; a normal Vercel Function is not a suitable host for that lifecycle. Room membership and the Socket.IO adapter are process-local, so run one backend instance unless you add a shared Socket.IO adapter/pub-sub service (for example Redis) and configure the host for WebSockets. The in-memory rate limiter is also per process; use a shared store before scaling backend instances.

For reliable production cookies, use HTTPS and frontend/API hostnames under the same site, for example `app.example.com` and `api.example.com`. Set the Vercel project root to `client`, and set the backend's `CLIENT_URL` to the exact frontend URL, `CLIENT_ORIGIN` to the exact allowed frontend origin(s), and `API_PUBLIC_URL` to the public API origin. The production server rejects missing or invalid required configuration and does not allow localhost CORS origins.

Configure these backend environment variables in the persistent host's secret/environment settings, not in Vercel `VITE_` variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Port supplied by the backend host; the server defaults to `5000` for local development. |
| `MONGODB_URI` | MongoDB Atlas connection URI and database selection. |
| `JWT_SECRET` | Unique random secret (at least 32 characters) used to sign expiring sessions. |
| `CLIENT_URL` | Public frontend URL used after email verification and password reset. |
| `CLIENT_ORIGIN` | Comma-separated exact HTTPS frontend origins allowed by API CORS; no paths. |
| `API_PUBLIC_URL` | Public HTTPS backend origin used to construct verification/reset links. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Authenticated SMTP transport for verification and password-reset email. |
| `SMTP_FROM` | Optional sender identity; defaults to `SMTP_USER`. |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Resource upload, delivery, and deletion. Keep existing account access settings; PDF preview behavior is unchanged by this deployment setup. |
| `GROQ_API_KEY` | Optional server-side Groq provider credential. |
| `GEMINI_API_KEY` | Optional server-side Gemini provider credential. |
| `NODE_ENV` | Set to `production` by the deployment host to enable production cookie, proxy, CORS, and configuration checks. |
| `FIREBASE_PROJECT_ID` | Firebase project used by Firebase Admin token verification. Required to use Firebase sign-in. |
| `FIREBASE_ADMIN_CREDENTIAL_MODE` | Optional `adc` or `service-account`; defaults to ADC unless service-account credential variables are present for backward compatibility. |
| `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Optional backend-only credentials when an already-approved deployment explicitly uses `service-account` mode. Private key accepts literal `\n` separators. Do not create a key to work around organization policy. |

Never expose backend credentials through `VITE_` variables. Keep `server/.env` local; use the host's secret manager for production values. The provided `.env.example` files contain placeholders for local setup only.

### Firebase Authentication

The client uses these public Firebase Web app settings from `client/.env` or the frontend host's build environment: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, and `VITE_FIREBASE_APP_ID`. These are Firebase client configuration identifiers, not Admin credentials. Never put Admin credentials in client files, `VITE_` variables, Git, logs, or chat.

In Firebase Console, select the intended project, enable **Authentication → Sign-in method → Email/Password** and **Google**, register the Vite web app, and add each local/deployed frontend hostname under **Authentication → Settings → Authorized domains**. Configure Google’s project support email and OAuth consent details as prompted by Firebase. Email/password Firebase registrations send a Firebase verification email; Firebase sign-in is refused until the verified token claim is true. Google sign-in is accepted only when Firebase's verified token claims confirm the email. Firebase email verification is independent of the existing SMTP verification link: legacy StudySphere accounts still have to complete the SMTP flow to set their MongoDB `emailVerified` flag.

After Firebase ID-token verification, StudySphere creates its existing signed HttpOnly session cookie; `/api/auth/me` remains the persistent application session. The backend trusts only verified token claims, checks token revocation, and maps the Firebase UID to the MongoDB `users` collection. A matching legacy account is linked only when both the Firebase token and the existing StudySphere record have verified email. Its password hash, verification status, and session version are preserved. An unverified legacy account must first finish its existing SMTP verification; a conflicting or already-linked identity is rejected instead of merged. Firebase-only users have no local password hash, so the legacy password-login endpoint rejects them unless the user deliberately establishes one through the existing password-reset flow.

For local Windows development, set `FIREBASE_PROJECT_ID` in `server/.env`, leave `FIREBASE_ADMIN_CREDENTIAL_MODE=adc`, and authenticate the developer account using `gcloud auth application-default login` (Google Cloud CLI). ADC is resolved lazily when the Firebase session exchange is used; Firebase sign-in reports a safe configuration error if credentials are unavailable. Do not copy the resulting local ADC files into the repository.

The backend in this repository is a standalone Node.js process (`node server.js`) with a custom HTTP server and Socket.IO. The repo contains a Vercel config for the frontend, but no backend Vercel Function configuration; no actual production backend host is configured here. For production, prefer a persistent Node.js runtime that supports an attached Google Cloud runtime identity (for example, Cloud Run with a dedicated service account) and ADC, plus the required Firebase Authentication Admin API permissions. Set `FIREBASE_PROJECT_ID` and `FIREBASE_ADMIN_CREDENTIAL_MODE=adc` on that host. Do not create service-account keys to work around key-creation restrictions.

If the backend is intentionally deployed as a Vercel Function, Vercel does not automatically provide Google ADC. Google Cloud Workload Identity Federation using Vercel OIDC may be a compatible option, but it requires explicit Google Cloud workload identity pool/provider configuration, trusted issuer/audience/subject claims, narrowly scoped service-account impersonation, and a supported external-account ADC credential setup in the backend runtime. None of that is configured or implemented by this project, so configure and verify that identity flow with the hosting and Google Cloud administrators before relying on Firebase Admin there. A Vercel Function is also not suitable for this existing long-lived Socket.IO server.

The explicit `service-account` mode remains only for deployments that already have an organization-approved credential source; its private key is backend-only, never committed, and is not a workaround for restricted key creation. The Firebase session-exchange endpoint is rate-limited and shares the existing account session and cookie lifecycle. Study rooms, notes, resources, and Socket.IO room joining remain public as before; Firebase sign-in does not implicitly make room content private.

## GitHub and Vercel deployment on Windows

1. Review `git status --short` and `git ls-files`; this workspace currently has no files tracked in the Git index. Review the intended project files and ensure `.env` files, dependencies, and build output are absent from the files you plan to stage.
2. From the repository root, initialize Git only if `git rev-parse --is-inside-work-tree` fails. Create a GitHub repository without adding a generated README/license if you intend to push this existing project.
3. Stage reviewed paths explicitly (do not use `git add .`), for example:

   ```powershell
   Set-Location C:\Users\muham\Collaborative-Study-Platform
   git add .gitignore README.md client/.env.example client/index.html client/package.json client/package-lock.json client/vite.config.js client/vercel.json client/src server/.env.example server/authSecurity.js server/authSecurity.test.js server/package.json server/package-lock.json server/providerErrors.js server/providerErrors.test.js server/server.js
   git status --short
   git diff --cached --check
   git diff --cached --name-only
   ```

   Confirm that `server/.env`, any `.env.local`, `node_modules`, `dist`, generated test output, and secrets are not staged. Then create a reviewed commit and push the branch to GitHub. Do not rewrite history or force-push.
4. In Vercel, import the GitHub repository, set **Root Directory** to `client`, preset to **Vite**, and configure `VITE_API_BASE_URL` for the Production environment using the persistent backend's HTTPS origin. Deploy only after the backend host, database access, CORS origin, email links, and Vercel environment variable are configured.
5. Add the Vercel production frontend origin to the backend's `CLIENT_URL` and `CLIENT_ORIGIN`; set `API_PUBLIC_URL` to the backend origin. Configure the remaining production backend variables listed above in the backend host, then restart/redeploy it.

Local tests/builds do not constitute a deployed production test. After deployment, verify `/api/health`, a real WebSocket connection, room creation/joining, notes persistence, auth cookie/login/logout, email links, AI requests, Cloudinary resources/PDF previews, and dashboard data against the deployed services.