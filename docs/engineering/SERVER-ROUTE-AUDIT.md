# Collaboration server route audit (#92)

Source: `server/index.mjs`. Gate order per request: origin allow-list (403) → per-IP rate limit (429) → OPTIONS → token policy (401) → route handler.

| Route | Method | Auth | Notes |
|---|---|---|---|
| /api/projects/:id | GET, PUT | Bearer | body size capped (413), JSON validated (400) |
| /api/rooms/:id | GET | Bearer | |
| /api/rooms/:id/{join,heartbeat,leave,change} | POST | Bearer | extra per-IP mutation rate limit |
| /api/rooms/:id/events | GET (SSE) | signed short-lived `?sse=` token, or Bearer / `?token=` | EventSource cannot set headers; per-IP connection cap. Documented trade-off |
| /api/agent/{exec,result,status} | POST/POST/GET | Bearer | |
| /api/agent/events | GET (SSE) | Bearer or `?token=` | same EventSource trade-off |
| /api/convert, /api/convert/:id/{status,download} | POST/GET | Bearer | upload signature sniff, opaque ids, retention sweep |
| any other /api/* | any | Bearer | unauthenticated → 401 before routing, so unknown paths do not disclose existence |

Startup fails closed: a non-loopback bind needs `OBS_SERVER_TOKEN` (≥16 chars, not trivial) and an explicit `OBS_ALLOWED_ORIGINS` (no `*`).

Tests: `tests/server-hardening.test.cjs` (ROUTE MATRIX covers every row above ×3 credential variants + `?token=`; unauthenticated PUT leaves no state; startup, origin, rate, size, SSE, upload cases).

## Cloudflare worker (`worker/index.ts`, `worker/auth.ts`)

Audited for the Google sign-in and cloud-account routes.

| Finding | Status |
|---|---|
| Google OAuth `state` was the fixed string `popup`/`app`, never bound to the browser that started the flow: login CSRF (an attacker could get a victim signed in as the attacker). | **Fixed**: `state` is `<mode>.<128-bit nonce>` and the nonce is also kept in a 10-minute HttpOnly/Secure/SameSite=Lax cookie scoped to `/api/auth/google`. The callback verifies both (constant-time) and clears the cookie on every outcome. |
| Google `email_verified` was not checked, so an unverified address could be linked to a local account with that email. | **Fixed**: callback rejects anything but `email_verified: true`. |
| Passwords use PBKDF2-SHA-256 with 100 000 iterations. | Accepted: 100 000 is the Workers runtime cap for PBKDF2; documented, not changed. |
| Login and forgot-password limits are per email address per minute, not per client IP. | Open: a credential-stuffing run across many addresses is not throttled per source. |
| `/api/visits` answers `access-control-allow-origin: *`. | Accepted: public counter, no credentials. |

Tests: `tests/worker-oauth-state.test.cjs` (9 checks on the real `auth.ts`).

Not covered: TLS (terminated by a reverse proxy), LinkedIn auth (`worker/linkedin.ts`), `api/visits.ts`, and a real multi-client load test.
