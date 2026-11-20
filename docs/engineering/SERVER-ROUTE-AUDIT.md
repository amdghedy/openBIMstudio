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
| /api/central/:room/{join,leave,role,op,workset,workset-owner,borrow,relinquish,borrow-request,borrow-respond,resolve,restore} | POST | Bearer | server-authoritative worksharing ops; extra per-IP mutation rate limit; 1 MB body cap; see docs/engineering/COLLABORATION_SYNC.md |
| /api/central/:room/{state,sync,history,audit} | GET | Bearer | state / catch-up since a revision (truncated → full state) / journal history / audit trail |
| /api/convert, /api/convert/:id/{status,download} | POST/GET | Bearer | upload signature sniff, opaque ids, retention sweep |
| any other /api/* | any | Bearer | unauthenticated → 401 before routing, so unknown paths do not disclose existence |

Startup fails closed: a non-loopback bind needs `OBS_SERVER_TOKEN` (≥16 chars, not trivial) and an explicit `OBS_ALLOWED_ORIGINS` (no `*`).

Tests: `tests/server-hardening.test.cjs` (ROUTE MATRIX covers every row above ×3 credential variants + `?token=`; unauthenticated PUT leaves no state; startup, origin, rate, size, SSE, upload cases).

Not covered: TLS (terminated by a reverse proxy), the Cloudflare worker (`worker/index.ts`: visit counter, LinkedIn/Google auth) which has its own routes and was not audited here, and a real multi-client load test.
