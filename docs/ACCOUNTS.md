# Accounts and cloud projects

Optional. Signing in lets a person save the open project to their account and open it from a phone or another computer. Everything still works without an account (browser storage and `.obsproj` files).

## What it is

* **Sign-in:** Google (Google Identity Services) and Microsoft (personal, work and school accounts, OpenID Connect popup). The browser receives a signed ID token from the provider; the edge worker verifies it (RS256 signature against the provider's published keys, issuer, audience, expiry, nonce) and sets an `HttpOnly`, `SameSite=Lax`, `Secure` session cookie valid 30 days. No password is ever handled by this app.
* **Storage:** one Cloudflare R2 object per project, under `u/{opaque user key}/{project id}`. The user key is a SHA-256 of provider + subject, never the e-mail address. A user can only address keys under their own prefix.
* **API:** `GET /api/auth/config`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `GET /api/cloud/projects`, `PUT|GET|DELETE /api/cloud/projects/:id`. Changing requests need the `x-obs-csrf: 1` header and a same-origin `Origin`.
* **Limits:** 100 MB per project, 200 projects per user. If the cloud copy changed after this device last saw it, the save is refused (409) and the person chooses to overwrite or keep the cloud copy. There is no automatic merge.
* Cloud responses are never cached by the service worker.

## Operator setup (Cloudflare deployment)

1. **R2 bucket**: `npx wrangler r2 bucket create obs-projects`, then add to `wrangler.jsonc`:
   ```jsonc
   "r2_buckets": [{ "binding": "PROJECTS", "bucket_name": "obs-projects" }]
   ```
   (Not enabled by default so deployments without R2 keep working; the API answers 501 until it is bound.)
2. **Session secret**: `npx wrangler secret put SESSION_SECRET` (at least 24 random characters, e.g. `openssl rand -base64 48`). Rotating it signs everyone out.
3. **Google**: Google Cloud Console → APIs & Services → Credentials → OAuth client ID → *Web application*. Add your site origin (e.g. `https://studio.example.com`) under *Authorized JavaScript origins*. Then `npx wrangler secret put GOOGLE_CLIENT_ID` (a client ID is public, a variable also works).
4. **Microsoft** (optional): Entra ID → App registrations → New (accounts in any directory and personal accounts) → Authentication → add a *Single-page application* redirect URI `https://studio.example.com/auth-callback.html` and tick *ID tokens* under implicit grant. Then `npx wrangler secret put MICROSOFT_CLIENT_ID`.
5. Deploy. The File tab → **Account & Cloud**, the Home screen **Account & cloud…** button and the command palette ("Account: …") open the dialog.

Providers whose client ID is not set are simply not offered. Hosts without the worker (e.g. a plain static deployment) show "Accounts are not available on this deployment".

## Privacy notes

* Projects in the bucket are stored as plain `.obsproj` files, readable by whoever administers the bucket. For sensitive work use *Save encrypted* (password) and upload that file, or keep to local files.
* Name, e-mail and picture from the ID token are kept only inside the session cookie, not in the bucket.
* Deleting a cloud project does not touch copies on devices.

## Verification status

Covered by `tests/account-cloud.test.cjs` (token checks with generated RSA keys, session tampering and expiry, CSRF/origin, isolation between users, path traversal, limits, conflicts) and `tests/account-client.test.cjs` (client with a fake fetch). **Not** yet exercised against live Google, Microsoft or Cloudflare R2, and the dialogs have not been run in a real browser.
