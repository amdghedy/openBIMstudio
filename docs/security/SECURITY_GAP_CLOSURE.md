# Security gap closure — collaboration server (#92)

Branch: `fix/server-security-hardening` · Base: `e8e5afb` (verified current
main, 2026-11-20) · Date: 2026-11-20

This is the §20 deliverable for reassessment §10 (Priority One — security
hardening, issue #92). It records what was verified, what changed, the
evidence for each control, and what remains open. The living per-route
reference is `docs/engineering/SERVER-ROUTE-AUDIT.md`; this document is
the closure record for this branch.

## 1. Scope and threat model

**In scope:** the collaboration server (`server/index.mjs` + `server/*.mjs`
helpers) and its two browser clients that speak to it
(`src/modules/collaboration/realtime-client.ts`,
`src/features/agent-bridge.ts`).

**Threat model.** The server is a local-first, single-shared-token API. The
adversaries considered are: a malicious web page trying to drive the server
through the user's browser (CSRF / cross-origin abuse); a network observer
or log reader harvesting credentials from URLs, logs or error responses; a
remote credential-guesser; a client flooding the server (rate / memory /
disk exhaustion); a client uploading a hostile file; and a misconfigured
deployment that silently serves an open server on a network interface. TLS
is out of scope — it is terminated by a reverse proxy in network
deployments, and the server binds loopback by default.

**What the model does NOT cover:** per-user identity. There is exactly one
credential (`OBS_SERVER_TOKEN`). Authorization is possession of that token.
See §5, open item O1 — this is the honest boundary of #92 on this
architecture.

## 2. Route security inventory

Gate order per request: origin allow-list (403) → general rate limit
(429, fail-closed) → OPTIONS → token policy (401; failed-auth budget 429)
→ malformed-encoding check (400) → route handler. A throw anywhere in a
handler is caught by the top-level guard and answered as a generic 500.

| # | Method | Path | Auth | Authorization | Rate limit | Body bounds | Failure mode |
|---|---|---|---|---|---|---|---|
| 1 | GET | /api/projects/:id | Bearer | token holder (all-or-nothing) | general 300/min/IP | — | 400 bad id; 404 unknown |
| 2 | PUT | /api/projects/:id | Bearer | token holder | general + mutation `project-put` 120/min/IP | JSON object; `name` ≤ 200 chars; `data` ≤ 8 MB; JSON cap 16 MB | 400 bad shape/JSON; 413 oversize; nothing persisted on auth failure |
| 3 | GET | /api/rooms/:id | Bearer | token holder | general | — | 400 bad id |
| 4 | POST | /api/rooms/:id/sse-token | Bearer | token holder | general + mutation `sse-token` | — | 400 bad room; 405 non-POST; 503 tokenless server |
| 5 | POST | /api/rooms/:id/join | Bearer | token holder | general + mutation `join` | JSON object; cursor ≤ 64 KB | 400 bad body/clientId; 413 oversize cursor |
| 6 | POST | /api/rooms/:id/heartbeat | Bearer | token holder | general + mutation `heartbeat` | JSON object; cursor ≤ 64 KB | 400/413 as join |
| 7 | POST | /api/rooms/:id/leave | Bearer | token holder | general + mutation `leave` | JSON object | 400 bad body/clientId |
| 8 | POST | /api/rooms/:id/change | Bearer | token holder | general + mutation `change` | JSON object; change payload ≤ 2 MB | 400 bad body/clientId; 413 oversize payload |
| 9 | GET (SSE) | /api/rooms/:id/events | Bearer header **or** minted short-lived `?sse=` token (room scope) | token holder | general + 5 concurrent streams/IP | — | 401 invalid/expired/wrong-room/wrong-scope/tampered; 429 stream cap |
| 10 | POST | /api/agent/exec | Bearer | token holder | general + mutation `agent-exec` | `cmd`/`ask` ≤ 4000 chars | 400 no cmd/ask; 409 duplicate orderId; 503 no studio; 503 pending-order cap (20) |
| 11 | POST | /api/agent/result | Bearer | token holder | general + mutation `agent-result` | `error` ≤ 2000 chars; `state` ≤ 2 MB JSON | 404 unknown/resolved orderId; 413 oversize state |
| 12 | GET | /api/agent/status | Bearer | token holder | general | — | — |
| 13 | POST | /api/agent/sse-token | Bearer | token holder | general + mutation `agent-sse-token` | — | 405 non-POST; 503 tokenless server |
| 14 | GET (SSE) | /api/agent/events | Bearer header **or** minted short-lived `?sse=` token (agent scope) | token holder | general + 5 concurrent streams/IP | — | 401 invalid/expired/wrong-scope/tampered; 429 stream cap |
| 15 | POST | /api/convert | Bearer | token holder | general + mutation `convert` | upload ≤ 200 MB; signature sniffed; opaque server id | 400 bad name/signature; 413 oversize; 429 conversion capacity (3 concurrent) |
| 16 | GET | /api/convert/:urn/status | Bearer | token holder | general | — | 400 bad job id; 404 unknown job; 500 status check failed |
| 17 | GET | /api/convert/:urn/download | Bearer | token holder | general | — | 400 bad job id / not complete; 404 unknown job / no IFC derivative; 500 download failed |
| 18 | any | any other /api/* | Bearer | — | general | — | 401 before routing (no existence disclosure) |

Non-API paths: the server serves no static files; anything outside `/api/`
falls through to the same 404 (after the auth gate for `/api/` only —
non-API paths are not authenticated, but they expose nothing: the 404 body
is a static route list).

## 3. Control verdicts

| Control (§10) | Verdict | Evidence |
|---|---|---|
| Explicit origin allow-list | **Closed.** `parseAllowedOrigins` / `originAllowed` / `corsHeaders` (`server/security.mjs`); non-loopback bind requires an explicit list, no `*`; disallowed Origin → 403; CORS echoes only an allowed origin, never `*`; no `Access-Control-Allow-Credentials`. | `server-hardening` origin test (403 evil / 200 allowed); `server-security` pure origin/CORS tests. |
| Header-only credential handling | **Closed.** No route reads a credential from anywhere but the `Authorization: Bearer` header, except the short-lived `?sse=` tokens (see SSE row). `server/index.mjs` contains no `searchParams.get("token")` call. | ROUTE MATRIX (every route × no/wrong/Basic/`?token=` → 401); `ai-agent-bridge` test asserts the server string is absent. |
| Query-string token rejection | **Closed on every route.** The last exception (`/api/agent/events`, kept deliberately by item 5 because the relay had no room to bind to) is closed by agent-scoped SSE tokens — see §4. | ROUTE MATRIX now includes both SSE routes and both mint endpoints; dedicated agent-SSE test (`?token=` → 401 even when valid). |
| Authentication | **Closed** for the shared-token model. Constant-time comparison (`crypto.timingSafeEqual` over SHA-256 digests, `tokenOk`); linear header parsing (no ReDoS); missing/wrong/Basic-scheme tokens → 401; unauthenticated writes persist nothing. | ROUTE MATRIX; `server-security` token tests; unauthenticated-PUT-leaves-no-state test. |
| Authorization | **Open — see O1.** Possession of the single shared token authorizes everything. No per-user, per-project or per-operation authorization exists. §9 central-sync roles are client-asserted labels under the same token and are not server-verifiable. | Stated in `SERVER-ROUTE-AUDIT.md`; no test can prove authorization that does not exist. |
| Rate limiting | **Closed, and extended.** General 300/min/IP; mutation 120/min/IP keyed per action + IP; failed-auth 20/min per route + IP; SSE 5/IP per stream type; conversions 3 concurrent; pending agent orders 20. New in this branch: mutation budgets for `agent/result` (previously unbounded), `convert` uploads, and project PUTs (write amplification). | Flooding test (429 + `Retry-After`); failed-auth test (429 + per-route isolation); mutation-budget test (`agent/result`, convert, PUT → 429 on the 4th call at max 3); pending-cap test (503). |
| Safe limiter failure behavior | **Closed.** All limiter checks go through `safeRateCheck()` (`server/rate-limit.mjs`): a throwing or garbage-returning limiter refuses (429) instead of un-limiting traffic or crashing the handler. Liveness under a 500-key flood is pinned. | Pure test: throwing limiter → `allowed: false` + `retryAfterMs > 0`; garbage return → refused; healthy limiter passes through; key-flood test. |
| Session security | **Closed for this architecture.** The server is stateless: no sessions, no cookies, no server-side session store to hijack or fixate. SSE streams are per-connection, capped per IP, and die with the connection; pending agent orders time out (20 s default) and are single-use (duplicate orderId → 409). | Pending-cap + duplicate-orderId test; SSE cap test. |
| Token storage | **Closed as far as the codebase controls it.** The long-lived token lives only in the server process environment (`OBS_SERVER_TOKEN`) and, on the client, in the in-memory `__OPENBIM_COLLAB_TOKEN__` global — the app never writes it to `localStorage`, `sessionStorage`, cookies or disk (verified by grep: no token persistence in `src/`). The APS credential (`APS_CLIENT_SECRET`) likewise lives only in server env; APS access tokens are held only in the in-memory `conversionJobs` map and swept after 24 h. Residual: the token is a single long-lived bearer secret with no rotation story — see O2. | Grep audit; mint-endpoint 503-on-tokenless behavior proves the server mints from env only. |
| SSE / WebSocket authentication | **Closed.** No WebSocket exists. Both SSE routes accept Bearer or a minted short-lived (5-min TTL) HMAC token (`?sse=`), scope-bound to room or agent; long-lived `?token=` refused everywhere. Tokens are verified for signature, expiry, room and scope; replay window == TTL (stateless). | SSE accept/reject/expired/wrong-room/wrong-scope/tampered tests (both routes, both directions); scope pure tests incl. legacy scopeless tokens; mint tests for both scopes. |
| Sensitive log redaction | **Closed for the server.** `securityLog()` truncates values to 120 chars and callers pass pre-sanitized fields only; file names are redacted to extension + length; error responses never echo the token (tested); the APS token is never logged; startup prints `(token required)`, never the token. No request URL is ever logged (the one place a `?token=` could have leaked). | Log-hygiene pure tests; token-never-echoed integration test (6 probes, raw and URL-encoded). |
| Upload security | **Closed with a documented limitation.** Extension allow-list + base-name sanitization (`safeUploadName` — traversal and header injection neutralized); content-signature sniffing for IFC/DXF/DWG; opaque server-generated storage ids (client name is metadata only, never a key or path); 200 MB bound separate from the 16 MB JSON cap; conversion concurrency cap; 24 h retention sweep + deletion after download. **Limitation:** RVT/NWD/NWC are closed formats with no public magic — accepted as `signatureChecked: false` (documented in `server/upload-store.mjs`, pinned by test). | Upload pure tests (signatures, traversal, round-trip, sweep); upload integration tests; mutation-budget test. |
| Error handling | **Closed, and hardened.** All client errors are generic (`Invalid JSON body`, `Payload too large`, …) with no parser internals, stack traces or filesystem paths; malformed URL encoding → 400; **new:** a top-level handler guard answers a generic 500 (error class logged, never the message/stack) instead of crashing the process — a live crash found by this work (a `ReferenceError` in the convert handler killed the server mid-test) is the regression case. | Malformed-JSON test; handler-guard test (forced internal failure → 500 generic, server answers normally afterwards); malformed-encoding test. |
| Fail-closed startup | **Closed.** Non-loopback bind without a strong token (≥16 chars, not trivial) and an explicit origin list → process exit; wildcard origins refused even on loopback; malformed origin lists refused. A tokenless server only ever binds loopback. | Pure config tests; spawned-server refusal tests (no token / weak token / no origins / wildcard origins), each asserting exit non-zero + `STARTUP REFUSED`. |
| Body bounds | **Closed.** JSON 16 MB (was 200 MB), uploads 200 MB, project PUTs 8 MB schema-bound, room change payloads 2 MB, presence cursors 64 KB, agent orders 4000 chars, agent result state 2 MB, agent result error 2000 chars. Oversize → 413 with the connection answered, not reset. | Schema/size tests; 16 MB default test (17 MB JSON → 413, 17 MB upload → 200); oversized-body test. |

## 4. What changed in this branch

Commit 1 — `fbbeb4e` (cherry-pick of item-5 branch `fix/fail-closed-sse`
`9414ea8`, verified here before committing): room SSE mint endpoint,
room-SSE `?token=` removal, `MAX_BODY` 200 MB → 16 MB split with a
separate 200 MB upload bound, failed-auth budget, project/room body schema
validation, dead `server/middleware/failClosed.ts` deletion, and the
server-hardening harness fix (async tests had never actually run).

Commit 2 — this work:

1. **Agent SSE `?token=` exception closed with a real mechanism.** SSE
   tokens gained a `scope` (`server/sse-tokens.mjs`): room tokens
   (`scope: "room"`, room-bound) and agent tokens (`scope: "agent"`,
   bound to the reserved subject `__agent__`, which can never be a real
   room id — `validId` rejects a leading underscore — and which the room
   mint endpoint cannot produce). The issuer refuses cross-scope minting;
   the verifier returns `wrong-scope`; legacy scopeless tokens verify as
   room scope. New `POST /api/agent/sse-token` (Bearer-only,
   mutation-budgeted, 503 when tokenless). `src/features/agent-bridge.ts`
   `connectRelay()` is now async mint-then-stream and fails closed if
   minting fails — no `?token=` fallback. No route reads `?token=` any
   more (verified by grep and by test).
2. **Mutation budgets for the three unbudgeted writes:** `agent/result`
   (was unbounded), `convert` uploads, project PUTs.
3. **Safe limiter failure:** `safeRateCheck()` wraps every limiter call;
   a throwing limiter refuses instead of un-limiting or crashing.
4. **Agent relay integrity:** pending-order cap (20, `OBS_AGENT_MAX_PENDING`,
   503 + `Retry-After`) and duplicate-`orderId` rejection (409) — a reused
   id previously overwrote the earlier waiter's resolver. Agent result
   `state` is now bounded to 2 MB (it was relayed verbatim under only the
   16 MB body cap).
5. **Handler crash DoS closed:** top-level guard (generic 500, error class
   logged, server stays up) + malformed URL encoding → 400. Found live: a
   `ReferenceError` in the convert handler (missing `key` in
   `handleConvert`'s scope) killed the whole server process mid-test.
6. **Record corrections:** `docs/engineering/BASELINE.md` §8 item 3, the
   Collaboration maturity row (which claimed "signed SSE tokens shipped
   (Stage 2)" and "Yjs"), and the Stage 2 row (37/37 from a harness that
   never executed the integration tests) are corrected with dated notes.
   Stage 2 had wired `?sse=` *verification* only — `issueSseToken()` had
   no call site and no mint endpoint existed.
7. **Docs:** `SERVER-ROUTE-AUDIT.md` rewritten with the full inventory
   (method, auth, authorization, rate limit, body bounds, failure mode)
   and this file.

## 5. What remains open (honest list)

- **O1 — Authorization is all-or-nothing (the #92 residual).** One shared
  token authorizes every operation. There is no per-user identity, no
  per-project ACL, and no way for the server to verify §9's owner/editor/
  viewer roles — they are self-asserted `clientId` labels under the shared
  token, so any token holder can claim `owner`. Closing this needs
  per-client credentials (or an identity provider) and a server-enforced
  role check on the central routes; it is a design change, not a patch.
  **#92 cannot be called fully closed while O1 stands** — it is recorded
  here as the known remaining gap, with the mitigation that the token is
  a single shared secret for a local-first deployment, never exposed to
  the public internet without a reverse proxy and TLS in front.
- **O2 — Long-lived token, no rotation.** `OBS_SERVER_TOKEN` has no
  expiry or rotation story; a leaked token is valid until the operator
  changes it and restarts. SSE tokens (5-min TTL) bound the exposure of
  the *stream* path, but the long-lived token still opens every other
  route. Rotation tooling is operator work, not code in this branch.
- **O3 — Tokenless loopback mode is intentionally open.** With no
  `OBS_SERVER_TOKEN` on loopback, every protected route accepts every
  request. That is the documented local-dev mode (any local process can
  already reach the port), but it means "fail closed when the token is
  unset" holds only for non-loopback binds (startup refusal) — on
  loopback the server deliberately runs open. Operators who need
  authentication on loopback must set a token.
- **O4 — Cloudflare worker + Vercel proxy not audited.** `worker/index.ts`
  routes (`/api/visits` GET/POST; `/api/auth/google/status|start|callback`;
  `POST /api/auth/forgot`; `/api/auth/*` and `/api/projects*` proxied to
  the AuthVault Durable Object; `/api/linkedin/connect|callback|status|
  publish|disconnect` plus DO-internal `/state`, `/consume-state`,
  `/token`) and `api/visits.ts` (same-origin proxy to the worker, CORS
  `*`, forwards client IP + User-Agent) were inventoried only. The worker
  handles Google OAuth, LinkedIn OAuth and password-reset email — a
  higher-stakes surface than the collab server — and needs its own audit
  (auth.ts does contain per-email-per-minute login/forgot rate-limit
  markers, noted but not verified). Not claimed as covered here.
- **O5 — RVT/NWD/NWC uploads are signature-unverifiable.** Closed
  formats with no public magic; accepted with `signatureChecked: false`.
  A hostile file of the right extension passes the sniff and is stored
  (it is never executed — it is only forwarded to APS or held for manual
  conversion — but the content check cannot reject a malformed one).
- **O6 — Concurrent-upload memory.** Each upload buffers up to 200 MB in
  memory; the per-IP mutation budget and the 3-conversion cap bound the
  rate, but there is no cap on *concurrent* in-flight uploads. A
  deliberate concurrent-upload flood could spike memory before the
  budgets bite. A concurrent-upload cap (like `activeConversions`) was
  considered and left out: it could not be tested deterministically on
  this VM, and an untested cap is worse than a documented gap.
- **O7 — No TLS in-process.** Plain HTTP; confidentiality on the wire
  depends on the reverse proxy. Documented in the startup config, not
  implemented here.
- **O8 — APS access tokens in memory.** The APS token for a conversion
  job is held in the in-memory `conversionJobs` map until the job is
  swept (24 h) or downloaded. It is never logged or returned to clients,
  but a process-memory disclosure would expose it. Short-lived by APS
  design; no further mitigation in this branch.
- **O9 — JSON persistence is still whole-file, not transactional.**
  Pre-existing (#91 scope); concurrent PUTs can interleave at the file
  level. Out of scope for §10.

## 6. Test evidence (exact numbers, this VM, base `e8e5afb`)

| Suite | Result |
|---|---|
| `node tests/server-hardening.test.cjs` | **61 passed, 0 failed** (was 49 after item 5; +12 new: 1 safe-limiter, 3 scope, 2 agent-SSE/mint, 1 startup-variants, 1 mutation-budgets, 1 token-echo, 1 malformed-encoding, 1 handler-guard, 1 pending-cap/duplicate) |
| `node tests/server-security.test.cjs` | **16 passed, 0 failed** (unchanged count; `tokenOk` query-token test reworded — no route forwards one any more) |
| `node tests/ai-agent-bridge.test.cjs` | **13 passed, 0 failed** (updated to pin the closed agent policy) |
| `node tests/server-backup.test.cjs` | passing (regression sanity; no persistence code touched) |

Fail-closed proof (spawned server, exact outcomes — also covered by the
suite tests above): `HOST=0.0.0.0` with no token → process exits non-zero
with `STARTUP REFUSED`; weak token → exits, `too weak`; strong token
without origins → exits, `origin allow-list`; loopback with
`OBS_ALLOWED_ORIGINS="*"` → exits, `must not contain '*'`; token set +
any protected route without a Bearer token → 401; with a valid
`?token=` → 401 on every route including both SSE routes.

## 7. Recommendation on issue #92

Do **not** close #92 on this branch. The `?token=` leakage channel is
fully closed, the rate-limit / fail-closed / upload / logging controls are
implemented and tested, and the false "signed SSE tokens shipped" record
is corrected — but authorization (O1) is still possession of one shared
secret with no per-user or per-role enforcement, and the worker surface
(O4) is unaudited. Closing #92 honestly requires either a per-client
credential design (O1) or an explicit maintainer decision that
shared-token authorization is the accepted boundary for this deployment
model, recorded on the issue with O1–O9 attached.
