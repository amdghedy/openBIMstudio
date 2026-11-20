# Collaboration server route audit (#92)

Source: `server/index.mjs`. Gate order per request: origin allow-list (403) → per-IP rate limit (429) → OPTIONS → token policy (401; failed-auth budget 429, see below) → route handler.

| Route | Method | Auth | Notes |
|---|---|---|---|
| /api/projects/:id | GET, PUT | Bearer | PUT body must be a JSON object: `name` ≤ 200 chars, `data` ≤ 8 MB (`OBS_MAX_PROJECT_BODY`); JSON body cap 16 MB (413), malformed JSON (400) |
| /api/rooms/:id | GET | Bearer | |
| /api/rooms/:id/sse-token | POST | Bearer | Mints a 5-min, room-bound `?sse=` token via `issueSseToken()`; 503 when the server runs tokenless (nothing to mint from); mutation-budgeted |
| /api/rooms/:id/{join,heartbeat,leave,change} | POST | Bearer | extra per-IP mutation rate limit; body must be a JSON object, presence cursor ≤ 64 KB, change payload ≤ 2 MB |
| /api/rooms/:id/events | GET (SSE) | Bearer or signed short-lived `?sse=` token | EventSource cannot set headers, so the short-lived token travels as `?sse=`; the long-lived `?token=` form is **refused** (401) since #92 item 5. Per-IP connection cap |
| /api/agent/{exec,result,status} | POST/POST/GET | Bearer | |
| /api/agent/events | GET (SSE) | Bearer or `?token=` | **The one remaining `?token=` exception.** The relay has no room to bind a short-lived token to, and `src/features/agent-bridge.ts` opens it with EventSource (no headers). Kept deliberately; revisit if the relay gains a room/subject to bind to |
| /api/central/:room/{join,leave,role,op,workset,workset-owner,borrow,relinquish,borrow-request,borrow-respond,resolve,restore} | POST | Bearer | server-authoritative worksharing ops; extra per-IP mutation rate limit; 1 MB body cap; see docs/engineering/COLLABORATION_SYNC.md |
| /api/central/:room/{state,sync,history,audit} | GET | Bearer | state / catch-up since a revision (truncated → full state) / journal history / audit trail |
| /api/convert, /api/convert/:id/{status,download} | POST/GET | Bearer | upload signature sniff, opaque ids, retention sweep; uploads have their own 200 MB bound (`OBS_MAX_UPLOAD_BODY`), separate from the 16 MB JSON cap |
| any other /api/* | any | Bearer | unauthenticated → 401 before routing, so unknown paths do not disclose existence |

Startup fails closed: a non-loopback bind needs `OBS_SERVER_TOKEN` (≥16 chars, not trivial) and an explicit `OBS_ALLOWED_ORIGINS` (no `*`).

## Budgets

- General: 300 req/min/IP (`OBS_RATE_MAX`); mutation: 120/min/IP (`OBS_RATE_MAX_MUTATION`).
- **Failed auth: 20/min per route + IP (`OBS_AUTH_FAIL_MAX`) → 429 with `Retry-After`.** Tighter than the general budget so credential guessing on one route is throttled without blocking other routes; a legitimate client that mistypes once is unaffected.
- SSE: 5 concurrent room streams / 5 agent streams per IP. Conversion: 3 concurrent.
- JSON bodies: 16 MB default (`OBS_MAX_BODY`, was 200 MB). Uploads: 200 MB default (`OBS_MAX_UPLOAD_BODY`) — RVT/NWD/NWC files routinely exceed 100 MB, and that path already sniffs signatures, caps concurrency and sweeps after 24 h.

## Tests

`tests/server-hardening.test.cjs` (pure + spawned-server integration) and `tests/server-security.test.cjs` (pure helpers), both in CI via `scripts/ci-unit-tests.mjs` (`test:server-hardening`, `test:server-security`). Coverage: ROUTE MATRIX covers every row above ×3 credential variants + `?token=` (room SSE and `sse-token` included; agent SSE excluded by design — see row); SSE accept/reject/expired/wrong-room/tampered; mint accept/reject/tokenless-503; project/room body schema + size bounds; failed-auth budget (429 + per-route isolation); limiter behaviour under a key flood; unauthenticated PUT leaves no state; startup, origin, rate, size, SSE, upload cases.

**Harness note (2026-11-20):** the async integration tests in `server-hardening.test.cjs` previously reported PASS before their bodies ran — the `t()` helper branched on `f.length`, which is 0 for `async () => {}` callbacks, so the suite printed 39/39 and exited in ~0.3 s without ever spawning a server. That means the #243 ROUTE MATRIX, merged as route-inventory evidence, had never actually executed. The helper now collects every test promise and the runner awaits them all before exiting; the `sse-tokens` loader `require` (which returned an un-awaited promise) is fixed the same way. Current counts from a run that actually executes: `server-hardening` 49 passed, `server-security` 16 passed.

Not covered: TLS (terminated by a reverse proxy), the Cloudflare worker (`worker/index.ts`: visit counter, LinkedIn/Google auth) which has its own routes and was not audited here, and a real multi-client load test.
