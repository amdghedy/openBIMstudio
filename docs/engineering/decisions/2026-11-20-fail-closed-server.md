# Decision: the server fails closed, and SSE tokens must be minted for real (#92)

**Decided:** 2026-11-20 (P0 hardening deep dive + hardening plan item 4).
**Recorded:** 2026-11-21, against `main` `bb0f55c`.

## Decision

The collaboration server's safety must not rest on a single startup function
and a single env var. The decided end state: mint short-lived SSE tokens for
real (a Bearer-authenticated endpoint that calls `issueSseToken()`, the client
fetching one before opening the `EventSource`, and the `?token=` fallback
removed from the room SSE route); a checked-in route inventory recording auth,
origin, and rate-limit policy for every endpoint; the dead
`server/middleware/failClosed.ts` and the duplicate `server/backup.ts`
deleted; regression tests for query-token rejection per route, SSE token
accept/reject/expired/wrong-room, per-route limits, and a tighter failed-auth
budget; and a schema + size bound on project/room PUT bodies.

## Evidence (2026-11-20)

- The P0 dive (§3) verified most of the control set is genuinely shipped and
  tested: fail-closed startup (`server/startup-config.mjs` exits on a
  non-loopback bind without a strong token and an explicit origin list),
  origin allow-list before route dispatch, per-IP rate limits (300/min
  general, 120/min mutation, SSE caps of 5, conversion concurrency cap of 3),
  header-only tokens on non-SSE routes, constant-time token comparison, and
  spawned-server integration tests.
- The headline residual gap: `issueSseToken()` is implemented
  (`server/sse-tokens.mjs`, HMAC-SHA256, 5-minute TTL, room-bound) but **never
  called anywhere** — there is no endpoint that mints an SSE token, and no
  setter for the client's `__OPENBIM_COLLAB_SSE_TOKEN_PROVIDER__` exists
  anywhere. Every authenticated SSE connection therefore still puts the
  long-lived token in the URL (`?token=<long-lived>`), where it lands in
  browser history, proxy access logs, and error reports — the exact leakage
  channel #92 was written to close.
- Two dead files: `server/middleware/failClosed.ts` (an Express middleware for
  a framework that is not a dependency, referencing an undefined `tokenBucket`,
  imported nowhere) and `server/backup.ts` (a second, divergent backup
  implementation, imported nowhere). Both escape CI because `tsconfig.json`
  includes only `["src"]`.
- No route inventory existed, and project/room PUT bodies were stored without
  schema validation (`MAX_BODY` default 200 MB).

## Status (re-verified 2026-11-21)

- **Residual gap 1 is still present, byte-identical in shape:**
  `issueSseToken` is imported in `server/index.mjs:9` and never called; a
  repo-wide search finds no minting endpoint and no provider setter.
- **Both dead files are still present:** `server/middleware/failClosed.ts`
  and `server/backup.ts`.
- **Stale record:** `docs/engineering/ISSUES.md` P0-04's table row still says
  "✅ satisfied", with a note that it is "satisfied here pending the #92
  follow-up (its SSE-token gap is tracked in #92)". A row that says satisfied
  while the headline gap is still in the code is the exact docs-vs-reality
  disagreement the P0 dive warned about; it needs correcting when #92 is
  worked, not by this change.
- **Tracker state unverified:** the unauthenticated GitHub API rate-limited
  when reading issue #92 on 2026-11-21. Evidence link TBD.

## What would change this decision

The SSE-token change landing (endpoint + client fetch + `?token=` fallback
removed, proven by a test asserting no `token=` parameter appears in an SSE
URL), the route inventory checked in, the two dead files deleted, and the
missing regression tests in CI. The loopback default is what keeps this
ranked third rather than first — it would outrank the others instantly if the
server were ever bound non-loopback, which is why the startup rule must never
be weakened.
