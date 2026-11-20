# Collaboration server route audit (#92)

Source: `server/index.mjs`. Gate order per request: origin allow-list (403) → per-IP rate limit (429, fail-closed via `safeRateCheck`) → OPTIONS → token policy (401; failed-auth budget 429, see below) → malformed-encoding check (400) → route handler. A throw anywhere in a handler is caught by the top-level guard and answered as a generic 500 — it no longer crashes the process.

| Route | Method | Auth | Authorization | Rate limit | Body bounds | Failure mode |
|---|---|---|---|---|---|---|
| /api/projects/:id | GET | Bearer | token holder (all-or-nothing) | general | — | 404 unknown id; 400 bad id |
| /api/projects/:id | PUT | Bearer | token holder | general + mutation (`project-put`) | JSON object, `name` ≤ 200 chars, `data` ≤ 8 MB (`OBS_MAX_PROJECT_BODY`); JSON cap 16 MB (413); malformed JSON (400) | 400/413, nothing persisted on auth failure |
| /api/rooms/:id | GET | Bearer | token holder | general | — | 400 bad id |
| /api/rooms/:id/sse-token | POST | Bearer | token holder | general + mutation (`sse-token`) | — | 400 bad room; 405 non-POST; 503 tokenless server (nothing to mint from) |
| /api/rooms/:id/{join,heartbeat,leave,change} | POST | Bearer | token holder | general + mutation (per action) | JSON object; presence cursor ≤ 64 KB; change payload ≤ 2 MB | 400 bad body/clientId; 413 oversize |
| /api/rooms/:id/events | GET (SSE) | Bearer or signed short-lived `?sse=` token (room scope) | token holder | general + 5 concurrent streams/IP | — | 401 invalid/expired/wrong-room/wrong-scope token; 429 stream cap |
| /api/agent/exec | POST | Bearer | token holder | general + mutation (`agent-exec`) | `cmd`/`ask` ≤ 4000 chars | 400 no cmd/ask; 409 duplicate orderId; 503 no studio connected; 503 pending-order cap (20) |
| /api/agent/result | POST | Bearer | token holder | general + mutation (`agent-result`) | `error` ≤ 2000 chars; `state` ≤ 2 MB JSON | 404 unknown/resolved orderId; 413 oversize state |
| /api/agent/status | GET | Bearer | token holder | general | — | — |
| /api/agent/sse-token | POST | Bearer | token holder | general + mutation (`agent-sse-token`) | — | 405 non-POST; 503 tokenless server |
| /api/agent/events | GET (SSE) | Bearer or signed short-lived `?sse=` token (agent scope) | token holder | general + 5 concurrent streams/IP | — | 401 invalid/expired/wrong-scope token; 429 stream cap |
| /api/central/:room/{join,leave,role,op,workset,workset-owner,borrow,relinquish,borrow-request,borrow-respond,resolve,restore} | POST | Bearer | token holder | general + mutation | 1 MB body cap | server-authoritative worksharing ops; see docs/engineering/COLLABORATION_SYNC.md |
| /api/central/:room/{state,sync,history,audit} | GET | Bearer | token holder | general | — | state / catch-up since a revision (truncated → full state) / journal history / audit trail |
| /api/convert | POST | Bearer | token holder | general + mutation (`convert`) | upload ≤ 200 MB (`OBS_MAX_UPLOAD_BODY`); signature sniffed; opaque server id | 400 bad name/signature; 413 oversize; 429 conversion capacity (3 concurrent) |
| /api/convert/:urn/status | GET | Bearer | token holder | general | — | 400 bad job id; 404 unknown job; 500 status check failed |
| /api/convert/:urn/download | GET | Bearer | token holder | general | — | 400 bad job id / not complete; 404 unknown job / no IFC derivative; 500 download failed |
| any other /api/* | any | Bearer | — | general | — | 401 before routing, so unknown paths do not disclose existence |

**No `?token=` anywhere.** The long-lived token is accepted only as an `Authorization: Bearer` header. The last exception — `/api/agent/events`, which item 5 deliberately kept because the relay had no room to bind a token to — is closed by agent-scoped SSE tokens (`POST /api/agent/sse-token` mints a 5-minute token bound to the reserved `__agent__` subject; `src/features/agent-bridge.ts` mints before opening the `EventSource` and fails closed if minting fails). A token minted for one scope never opens the other route (pure `wrong-scope` rejection, tested both directions; the issuer also refuses cross-scope minting at issuance). `server/index.mjs` no longer reads a `?token=` query parameter on any route.

**Authorization is possession of the single shared server token.** There is no per-user identity and no per-operation authorization beyond that: any holder can read/write every project and room, drive the agent relay, and trigger conversions. The §9 central-sync roles (owner/editor/viewer) are labels asserted by the client under that same shared token and are not enforced by any credential the server can verify — see `docs/security/SECURITY_GAP_CLOSURE.md`. That is the remaining authorization gap for #92.

Startup fails closed: a non-loopback bind needs `OBS_SERVER_TOKEN` (≥16 chars, not trivial) and an explicit `OBS_ALLOWED_ORIGINS` (no `*`); a wildcard origin list is refused even on loopback. A tokenless server only ever binds loopback.

## Budgets

- General: 300 req/min/IP (`OBS_RATE_MAX`); mutation: 120/min/IP (`OBS_RATE_MAX_MUTATION`), keyed per action + IP.
- **Failed auth: 20/min per route + IP (`OBS_AUTH_FAIL_MAX`) → 429 with `Retry-After`.** Tighter than the general budget so credential guessing on one route is throttled without blocking other routes; a legitimate client that mistypes once is unaffected.
- **Safe limiter failure:** all limiter checks go through `safeRateCheck()` — a throwing or garbage-returning limiter refuses (429) instead of un-limiting traffic or crashing the handler. The limiter is in-memory with no backend to fail; a 500-key flood test pins that it keeps answering.
- SSE: 5 concurrent room streams / 5 agent streams per IP. Conversion: 3 concurrent. Pending agent orders: 20 (`OBS_AGENT_MAX_PENDING`).
- JSON bodies: 16 MB default (`OBS_MAX_BODY`, was 200 MB). Uploads: 200 MB default (`OBS_MAX_UPLOAD_BODY`) — RVT/NWD/NWC files routinely exceed 100 MB, and that path already sniffs signatures, caps concurrency and sweeps after 24 h. Project PUTs: 8 MB (`OBS_MAX_PROJECT_BODY`). Room change payloads: 2 MB. Agent result state: 2 MB.

## Tests

`tests/server-hardening.test.cjs` (pure + spawned-server integration) and `tests/server-security.test.cjs` (pure helpers), both in CI via `scripts/ci-unit-tests.mjs` (`test:server-hardening`, `test:server-security`). Coverage: ROUTE MATRIX covers every row above ×3 credential variants + `?token=` (both SSE routes and both mint endpoints included — no exceptions remain); SSE accept/reject/expired/wrong-room/wrong-scope/tampered; mint accept/reject/tokenless-503 for both scopes; project/room body schema + size bounds; mutation budgets for agent/result, convert and project PUT; failed-auth budget (429 + per-route isolation); limiter failure fails closed + liveness under a key flood; error responses never echo the token; malformed URL encoding → 400; handler guard (internal failure → generic 500, server stays up); pending-order cap + duplicate orderId; unauthenticated PUT leaves no state; startup, origin, rate, size, SSE, upload cases.

**Harness note (2026-11-20):** the async integration tests in `server-hardening.test.cjs` previously reported PASS before their bodies ran — the `t()` helper branched on `f.length`, which is 0 for `async () => {}` callbacks, so the suite printed 39/39 and exited in ~0.3 s without ever spawning a server. That means the #243 ROUTE MATRIX, merged as route-inventory evidence, had never actually executed. The helper now collects every test promise and the runner awaits them all before exiting; the `sse-tokens` loader `require` (which returned an un-awaited promise) is fixed the same way. Current counts from a run that actually executes: `server-hardening` 61 passed, `server-security` 16 passed.

Not covered: TLS (terminated by a reverse proxy), the Cloudflare worker (`worker/index.ts`: visit counter, LinkedIn/Google auth) and the Vercel `api/visits.ts` proxy, which have their own routes and were not audited here (inventoried in `docs/security/SECURITY_GAP_CLOSURE.md`), and a real multi-client load test.
