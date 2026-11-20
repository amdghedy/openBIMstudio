import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseAllowedOrigins, originAllowed, corsHeaders, SECURITY_HEADERS, validId, validClientId, safeDisplayName, boundedJsonValue, validateProjectBody, validateRoomActionBody, tokenOk, safeUploadName } from "./security.mjs";
import { resolveStartupConfig } from "./startup-config.mjs";
import { createRateLimiter, clientKey, correlationId, securityLog, redactFileName } from "./rate-limit.mjs";
import { issueSseToken, verifySseToken, SSE_TOKEN_DEFAULT_TTL_MS } from "./sse-tokens.mjs";
import { CentralStore } from "./central-store.mjs";
import {
  joinRoom, leaveRoom, setRole, submitUpsert, submitDelete, createWorkset,
  setWorksetOwner, borrowElement, relinquishBorrow, submitBorrowRequest,
  respondBorrowRequest, resolveConflict, restoreToRevision, publicState,
  sweepExpiredBorrows,
} from "./central-model.mjs";
import { issueShareToken, verifyShareToken, isShareRole, clampShareTtlMs, SHARE_TOKEN_DEFAULT_TTL_MS } from "./share-tokens.mjs";
import { sniffSignature, storeUpload, sweepExpired } from "./upload-store.mjs";
import { findLastVerifiedBackup, quarantineFile, restoreBackup, snapshotOnLoad, writeJsonWithBackup } from "./backup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── Fail-closed startup (remediation Phase 1.2) ─────────────────────────
 * Non-loopback bind without a strong token + explicit origin allow-list is
 * REFUSED (process exit), not warned. See server/startup-config.mjs.
 */
const CFG = resolveStartupConfig({
  host: process.env.HOST,
  token: process.env.OBS_SERVER_TOKEN,
  allowedOrigins: process.env.OBS_ALLOWED_ORIGINS,
});

if (!CFG.ok) {
  console.error("[collab] STARTUP REFUSED: " + CFG.reason);
  process.exit(1);
}

const dataDir = process.env.OBS_DATA_DIR || path.join(__dirname, "data");
const projectsFile = path.join(dataDir, "projects.json");
const roomsFile = path.join(dataDir, "rooms.json");
const sharesFile = path.join(dataDir, "shares.json");
const uploadsDir = path.join(dataDir, "uploads");

const PORT = Number(process.env.PORT || 4000);
const HOST = CFG.host;
const AUTH_TOKEN = CFG.token;
const ALLOWED_ORIGINS = CFG.origins
  ? new Set(CFG.origins)
  : parseAllowedOrigins();
/* Body limits (#92 item 5). JSON API bodies and binary uploads no longer
 * share one budget: the largest legitimate JSON body is a project PUT,
 * schema-bounded to OBS_MAX_PROJECT_BODY (8 MB default), and room changes are
 * capped at 2 MB, so a 16 MB JSON cap leaves 2x headroom. Uploads keep a
 * separate 200 MB bound because RVT/NWD/NWC files routinely exceed 100 MB;
 * that path already sniffs signatures, uses opaque ids, caps concurrency
 * at 3 and sweeps after 24 h. Both bounds stay overridable via env. */
const MAX_BODY = Number(process.env.OBS_MAX_BODY || 16 * 1024 * 1024);
const MAX_UPLOAD_BODY = Number(process.env.OBS_MAX_UPLOAD_BODY || 200 * 1024 * 1024);
const MAX_PROJECT_BODY = Number(process.env.OBS_MAX_PROJECT_BODY || 8 * 1024 * 1024);
const PRESENCE_TIMEOUT_MS = 45000;
const MAX_CHANGES_PER_ROOM = 500;
const MAX_CHANGE_PAYLOAD = Number(process.env.OBS_MAX_CHANGE_PAYLOAD || 2 * 1024 * 1024);

/* Rate budgets (per IP). Tunable for tests via env. */
const RATE_WINDOW_MS = Number(process.env.OBS_RATE_WINDOW_MS || 60_000);
const RATE_MAX_GENERAL = Number(process.env.OBS_RATE_MAX || 300);
const RATE_MAX_MUTATION = Number(process.env.OBS_RATE_MAX_MUTATION || 120);
const SSE_MAX_PER_IP = Number(process.env.OBS_SSE_MAX_PER_IP || 5);
const UPLOAD_RETENTION_MS = Number(process.env.OBS_UPLOAD_RETENTION_MS || 24 * 60 * 60_000);
const MAX_CONCURRENT_CONVERSIONS = Number(process.env.OBS_MAX_CONCURRENT_CONVERSIONS || 3);

const httpRate = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_MAX_GENERAL });
const mutationRate = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_MAX_MUTATION });
/* Failed-auth budget (#92 item 5): tighter than the general budget, and
 * keyed per route + IP, so credential guessing on one route is throttled
 * without blocking legitimate traffic on other routes. */
const AUTH_FAIL_WINDOW_MS = Number(process.env.OBS_AUTH_FAIL_WINDOW_MS || 60_000);
const AUTH_FAIL_MAX = Number(process.env.OBS_AUTH_FAIL_MAX || 20);
const failedAuthRate = createRateLimiter({ windowMs: AUTH_FAIL_WINDOW_MS, max: AUTH_FAIL_MAX });
const ssePerIp = new Map(); // ip -> active SSE connection count
let activeConversions = 0;

const sseClients = new Map();

/* AI agent relay state — studio sessions (browsers) + orders awaiting results */
const AGENT_ORDER_TIMEOUT_MS = Number(process.env.OBS_AGENT_ORDER_TIMEOUT_MS || 20_000);
const AGENT_SSE_MAX_PER_IP = Number(process.env.OBS_AGENT_SSE_MAX_PER_IP || 5);
const agentStudioClients = new Set();
const agentPendingOrders = new Map(); // orderId -> { resolve, timer }
const agentSsePerIp = new Map(); // ip -> active agent stream count

function broadcastAgent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of agentStudioClients) {
    try { res.write(payload); } catch { agentStudioClients.delete(res); }
  }
}

/* Files quarantined as corrupt during this process lifetime (#91). */
const quarantinedThisBoot = new Set();

function ensureStore() {
  fs.mkdirSync(dataDir, { recursive: true });

  // A file quarantined during this boot (#91) stays gone until the next
  // successful save recreates it: re-creating it here as "{}" would
  // silently undo the quarantine one loadJson call later (the rooms load
  // runs after the projects load, and vice versa for saves).
  if (!quarantinedThisBoot.has(projectsFile) && !fs.existsSync(projectsFile)) {
    fs.writeFileSync(projectsFile, "{}", "utf8");
  }

  if (!quarantinedThisBoot.has(roomsFile) && !fs.existsSync(roomsFile)) {
    fs.writeFileSync(roomsFile, "{}", "utf8");
  }

  if (!fs.existsSync(sharesFile)) {
    fs.writeFileSync(sharesFile, "{}", "utf8");
  }
}

/* ── Backup-on-load (#91) ───────────────────────────────────────────────
 * A corrupt store must never be silently discarded: the old `loadJson`
 * returned `{}` on ANY failure, and the next save then backed up the
 * corrupt file and overwrote the good copy — irreversible data loss.
 * The load path now:
 *   1. snapshots the exact bytes about to be parsed (verified on
 *      read-back; an unverifiable snapshot is deleted, never retained);
 *   2. on parse/shape failure logs LOUDLY and serves the last VERIFIED
 *      backup, restoring the live file from it;
 *   3. with no verified backup, quarantines the corrupt bytes aside
 *      (never deletes them, never backs them up as if good) and starts
 *      from the empty fallback — the next save then writes a fresh file
 *      instead of overwriting the only copy of anything.
 */
function loadJson(file, fallback) {
  const existed = fs.existsSync(file);
  ensureStore();

  // Fresh store: nothing on disk to preserve — unless backups survive a
  // deleted live file (#244): recover the newest verified backup first,
  // exactly as readJsonWithRecovery did for a missing live file.
  if (!existed) {
    const good = findLastVerifiedBackup(file);
    if (good) {
      const restored = restoreBackup(file, good.path);
      if (restored.ok) {
        console.error(`[collab] RESTORED ${path.basename(file)} from verified backup ${path.basename(good.path)} (live file was missing).`);
        return restored.value;
      }
      securityLog(console.error, "restore_failed", {
        file: path.basename(file),
        backup: path.basename(good.path),
        error: restored.error?.code || "unknown",
      });
    }
    return fallback;
  }

  // 1. Snapshot-on-load, before parsing.
  const snapshot = snapshotOnLoad(file);
  if (snapshot.error) {
    securityLog(console.error, "backup_on_load_failed", {
      file: path.basename(file),
      error: snapshot.error?.code || "unknown",
    });
    console.error(
      `[collab] BACKUP-ON-LOAD FAILED for ${path.basename(file)}: ${snapshot.error?.message || snapshot.error} — ` +
        `continuing with the load, but no new snapshot was taken.`,
    );
  }

  // 2. Parse. Anything unparseable, unreadable or wrong-shaped is corrupt.
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return loadFromBackupOrFallback(file, fallback, error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return loadFromBackupOrFallback(file, fallback, new Error("store is not a JSON object"));
  }
  return value;
}

function loadFromBackupOrFallback(file, fallback, error) {
  const name = path.basename(file);
  securityLog(console.error, "load_corrupt", {
    file: name,
    error: String(error?.message || error).slice(0, 120),
  });
  console.error(
    `[collab] CORRUPT ${name}: ${error?.message || error} — the live file is NOT trusted. ` +
      `Trying the last verified backup; the store is NEVER silently emptied.`,
  );
  const good = findLastVerifiedBackup(file);
  if (good) {
    const restored = restoreBackup(file, good.path);
    if (restored.ok) {
      console.error(`[collab] RESTORED ${name} from verified backup ${path.basename(good.path)}.`);
      return restored.value;
    }
    securityLog(console.error, "restore_failed", {
      file: name,
      backup: path.basename(good.path),
      error: restored.error?.code || "unknown",
    });
    console.error(
      `[collab] RESTORE FAILED for ${name} from ${path.basename(good.path)}: ` +
        `${restored.error?.message || restored.error} — starting from an empty store.`,
    );
  } else {
    console.error(`[collab] NO VERIFIED BACKUP for ${name} — starting from an empty store.`);
  }
  // No recoverable backup (or the restore failed): quarantine the corrupt
  // bytes so the next save cannot back them up as if they were good.
  const quarantined = quarantineFile(file);
  if (quarantined.quarantined) {
    quarantinedThisBoot.add(file);
    console.error(
      `[collab] QUARANTINED corrupt ${name} as ${path.basename(quarantined.target)} — ` +
        `it was not deleted; restore it manually if it holds anything (see docs/engineering/SERVER-BACKUP-RECOVERY.md).`,
    );
  } else if (quarantined.error) {
    console.error(
      `[collab] WARNING: could not quarantine corrupt ${name}: ${quarantined.error?.message || quarantined.error} — ` +
        `the corrupt file is still in place and the next write to it will be refused until it is moved aside.`,
    );
  }
  return fallback;
}

function saveJson(file, value) {
  ensureStore();
  try {
    writeJsonWithBackup(file, value);
    return { ok: true };
  } catch (error) {
    // Fail closed (#91): the destructive write did NOT happen. The last
    // known-good file on disk is untouched; the new state stays in memory
    // only and is lost on restart. Loud on purpose — silence here is the
    // bug that destroyed projects. Callers check the result: the project
    // PUT returns 503, presence writes keep serving from memory.
    const backupFailed = error?.code === "backup_failed";
    securityLog(console.error, backupFailed ? "backup_failed_blocks_write" : "save_failed", {
      file: path.basename(file),
      error: error?.code || "unknown",
    });
    console.error(
      `[collab] WRITE BLOCKED for ${path.basename(file)}: ` +
        (backupFailed
          ? `pre-write backup failed (${error?.message || error}). The last known-good file on disk was NOT overwritten; the new state is in memory only.`
          : `write failed (${error?.message || error}). The live file was not replaced.`),
    );
    return { ok: false, error };
  }
}

let projects = loadJson(projectsFile, {});
let rooms = loadJson(roomsFile, {});
let shares = loadJson(sharesFile, {});

/* Share links (differentiation item 1) — signed, single-room, role-scoped
 * tokens; see server/share-tokens.mjs. The registry is the revocation list:
 * a token whose sid has no live registry record does not authenticate.
 * The signing secret is the master token when one is configured; in
 * tokenless loopback mode it is an ephemeral per-process secret, so shares
 * created there do not survive a server restart (documented in the share
 * PR description — the loopback server has no durable secret to sign with).
 */
const SHARE_SECRET = AUTH_TOKEN || randomUUID();

function saveShares() {
  saveJson(sharesFile, shares);
}

/** @returns the live registry record for sid, or null when revoked/expired/absent. */
function shareIsLive(sid) {
  const s = shares[sid];
  if (!s || s.revoked) return null;
  if (typeof s.expiresAt !== "number" || s.expiresAt <= Date.now()) return null;
  return s;
}

/** Drop expired registry records (revoked ones are kept so a revoke is auditable). */
function pruneExpiredShares() {
  let changed = false;
  const now = Date.now();
  for (const sid of Object.keys(shares)) {
    const s = shares[sid];
    if (s && !s.revoked && typeof s.expiresAt === "number" && s.expiresAt <= now) {
      delete shares[sid];
      changed = true;
    }
  }
  if (changed) saveShares();
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return ""; }
}

function bearerToken(header) {
  const h = String(header || "");
  if (h.length >= 7 && h.slice(0, 7).toLowerCase() === "bearer ") return h.slice(7).trim();
  return "";
}

/**
 * Verify a presented share token for one room. Returns the session
 * { ok: true, role, room, sid } when the token is cryptographically valid
 * AND its sid is live in the registry, or { ok: false, reason } otherwise.
 */
function authenticateShareToken(candidate, roomId) {
  const v = verifyShareToken(candidate, SHARE_SECRET, { room: roomId });
  if (!v.ok) return { ok: false, reason: v.reason };
  const live = shareIsLive(v.payload.sid);
  if (!live) return { ok: false, reason: "revoked-or-expired" };
  if (live.room !== roomId || live.role !== v.payload.role) return { ok: false, reason: "mismatch" };
  return { ok: true, role: v.payload.role, room: roomId, sid: v.payload.sid };
}

/**
 * Resolve credentials for a room-scoped route. A presented Bearer is the
 * master token (owner) or a share token (role-scoped session); when no
 * credential is presented, the loopback default applies (authed iff no
 * server token is configured). Share tokens never authenticate non-room
 * routes — callers only pass a roomId for room/project paths.
 */
function resolveRoomAuth(bearer, roomId) {
  if (bearer) {
    if (AUTH_TOKEN && tokenOk(`Bearer ${bearer}`, undefined, AUTH_TOKEN)) {
      return { authed: true, share: null };
    }
    if (!roomId) return { authed: false, share: null };
    const s = authenticateShareToken(bearer, roomId);
    return s.ok
      ? { authed: true, share: s }
      : { authed: false, share: null, reason: s.reason };
  }
  return { authed: !AUTH_TOKEN, share: null };
}

function send(res, status, body) {
  const data =
    typeof body === "string"
      ? body
      : JSON.stringify(body ?? {}, null, 2);

  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(res.obsCors || {}),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });

  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY) {
        // Stop consuming (paused stream = no more buffering) and reject.
        // The handler answers 413 and Node closes the connection because
        // the request stream is incomplete — the client sees the 413 instead
        // of a reset. (Destroying the socket here used to kill the response
        // too, so the documented 413 never arrived.)
        req.removeAllListeners("data");
        reject(Object.assign(new Error("Payload too large"), { code: "payload_too_large" }));
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

/** Streaming size-limited binary body read (uploads). Rejects early — the
 * connection stops being consumed as soon as the limit is exceeded, and the
 * handler answers 413 (see readBody); the socket is not destroyed first. */
function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BODY) {
        req.removeAllListeners("data");
        reject(Object.assign(new Error("Payload too large"), { code: "payload_too_large" }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      id: roomId,
      clients: {},
      changes: [],
      updatedAt: new Date().toISOString(),
    };
  }

  return rooms[roomId];
}

function touchRoom(room) {
  room.updatedAt = new Date().toISOString();
  // Fail-closed (#91) is enforced inside saveJson: on backup failure the
  // rooms file is NOT overwritten and the failure is logged loudly there.
  // Presence is ephemeral — the in-memory room stays authoritative — so
  // there is no client-visible error to return here; the last known-good
  // rooms.json on disk is what a restart will load.
  saveJson(roomsFile, rooms);
}

function presenceList(roomId) {
  const room = getRoom(roomId);
  const now = Date.now();

  const list = [];

  for (const c of Object.values(room.clients)) {
    if (!c || !c.clientId) continue;
    if (now - Number(c.updatedAt || 0) > PRESENCE_TIMEOUT_MS) continue;

    list.push({
      clientId: c.clientId,
      name: c.name || "Guest",
      cursor: c.cursor || null,
      updatedAt: c.updatedAt,
    });
  }

  return list;
}

function broadcast(roomId, event, payload) {
  const set = sseClients.get(roomId);

  if (!set || !set.size) {
    return;
  }

  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const res of set) {
    try {
      res.write(msg);
    } catch {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
  }
}

function addSse(roomId, res) {
  if (!sseClients.has(roomId)) {
    sseClients.set(roomId, new Set());
  }

  sseClients.get(roomId).add(res);

  res.on("close", () => {
    const set = sseClients.get(roomId);

    if (set) {
      set.delete(res);

      if (!set.size) {
        sseClients.delete(roomId);
      }
    }
  });
}

function addChange(roomId, change) {
  const room = getRoom(roomId);

  const item = {
    id: change.id || `chg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    clientId: change.clientId,
    type: change.type || "unknown",
    payload: change.payload ?? {},
    at: new Date().toISOString(),
  };

  room.changes.push(item);

  if (room.changes.length > MAX_CHANGES_PER_ROOM) {
    room.changes = room.changes.slice(-MAX_CHANGES_PER_ROOM);
  }

  touchRoom(room);
  broadcast(roomId, "change", item);

  return item;
}

/* ── Central model (server-authoritative worksharing) ─────────────────
 * One durable CentralStore per room (snapshot + fsynced journal + audit).
 * Commit order per mutation: append journal + fsync → apply effects →
 * rewrite snapshot → broadcast over the room SSE channel → ack. See
 * server/central-model.mjs (consistency model) and
 * docs/engineering/COLLABORATION_SYNC.md.
 */
const centralStores = new Map();
function centralStore(roomId) {
  if (!centralStores.has(roomId)) {
    centralStores.set(roomId, new CentralStore(dataDir, roomId));
  }
  return centralStores.get(roomId);
}

/** Expire stale borrows. The removal is itself a journal entry, so a
 * restart replays the same outcome instead of resurrecting the borrow. */
function sweepCentral(store) {
  const effects = sweepExpiredBorrows(store.state);
  if (!effects.length) return;
  const seq = store.state.revision + 1;
  const entry = {
    seq, opId: null, actor: "system", kind: "borrow-expire", at: Date.now(),
    payload: { elementIds: effects.map((e) => e.elementId) },
    effects: [...effects, { type: "set-revision", revision: seq }],
    applied: { expired: effects.length }, conflicts: [],
  };
  store.commit(entry);
  store.audit("borrow_expired", { count: effects.length });
}

const CENTRAL_MAX_BODY = 1024 * 1024; // central ops are small element edits, not file uploads

setInterval(() => {
  let changed = false;
  const now = Date.now();

  for (const roomId of Object.keys(rooms)) {
    const room = rooms[roomId];

    if (!room || !room.clients) continue;

    for (const clientId of Object.keys(room.clients)) {
      const c = room.clients[clientId];

      if (!c || now - Number(c.updatedAt || 0) > PRESENCE_TIMEOUT_MS) {
        delete room.clients[clientId];
        changed = true;
      }
    }

    if (changed) {
      broadcast(roomId, "presence", presenceList(roomId));
    }
  }

  if (changed) {
    saveJson(roomsFile, rooms);
  }
}, 15000);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowedOrigin = originAllowed(origin, ALLOWED_ORIGINS);
  res.obsCors = corsHeaders(origin, ALLOWED_ORIGINS);

  // Correlation id — every response carries it; every security log cites it.
  const reqId = correlationId(req);
  res.setHeader("X-Request-Id", reqId);
  const key = clientKey(req);

  // A page from another site must not be able to drive this server through the visitor's browser.
  if (allowedOrigin === false) {
    securityLog(console.log, "origin_blocked", { requestId: reqId, origin: origin });
    return send(res, 403, { error: "Origin not allowed", requestId: reqId });
  }

  // Per-IP request budget (general). Floods get 429 + Retry-After.
  const general = httpRate.check(key);
  if (!general.allowed) {
    securityLog(console.log, "rate_limited", { requestId: reqId, scope: "general", count: general.count });
    res.setHeader("Retry-After", Math.ceil(general.retryAfterMs / 1000));
    return send(res, 429, { error: "Too many requests", requestId: reqId });
  }

  if (req.method === "OPTIONS") {
    return send(res, 204, "");
  }

  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );

  const isSseEvents = /^\/api\/rooms\/[^/]+\/events$/.test(url.pathname);
  const isAgentEvents = url.pathname === "/api/agent/events";

  /* Token policy (remediation Phase 1.2, extended for share links; #92 item 5):
   *  - Non-SSE /api/ routes: Authorization: Bearer only. Query-string tokens
   *    are refused (they leak into logs, proxies and history).
   *  - Room SSE events route only: Bearer (master token, or a share token
   *    resolved per room), a signed short-lived ?sse= token minted from
   *    POST /api/rooms/:id/sse-token, or a ?share= share token. The
   *    long-lived ?token= form is NOT accepted here any more — EventSource
   *    cannot set headers, so the short-lived token travels as ?sse=.
   *  - Agent relay SSE (/api/agent/events): EventSource cannot set headers
   *    and the relay has no room to bind a short-lived token to, so Bearer
   *    OR the long-lived ?token= form is accepted there. This is the one
   *    remaining ?token= exception; see docs/engineering/SERVER-ROUTE-AUDIT.md.
   *  - Share tokens: single-room, role-scoped (view/edit). A presented
   *    Bearer is tried as the master token first, then as a share token for
   *    the room in the path. When a share token authenticates, reqShare is
   *    set and the route handlers enforce the role (view may read, join and
   *    lock; only edit may POST changes or PUT the project snapshot).
   *    Share tokens never authenticate non-room routes.
   */
  let reqShare = null;
  if (url.pathname.startsWith("/api/")) {
    let authed = false;
    // Room id for share-token auth (share tokens are single-room scoped).
    const roomPathMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/.*)?$/);
    const projectPathMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    const shareRoomId = roomPathMatch
      ? safeDecode(roomPathMatch[1])
      : projectPathMatch ? safeDecode(projectPathMatch[1]) : null;
    if (isAgentEvents) {
      authed = tokenOk(req.headers.authorization, url.searchParams.get("token"), AUTH_TOKEN);
    } else if (isSseEvents) {
      const roomId = safeDecode((url.pathname.match(/^\/api\/rooms\/([^/]+)\/events$/) || [])[1] || "");
      const shareParam = url.searchParams.get("share");
      const sseToken = url.searchParams.get("sse");
      if (shareParam) {
        const s = authenticateShareToken(shareParam, roomId);
        if (!s.ok) {
          securityLog(console.log, "share_token_rejected", { requestId: reqId, reason: s.reason });
          return send(res, 401, { error: "Invalid or expired share token", requestId: reqId });
        }
        authed = true;
        reqShare = s;
      } else if (sseToken) {
        const v = verifySseToken(sseToken, AUTH_TOKEN, { room: roomId });
        if (!v.ok) {
          securityLog(console.log, "sse_token_rejected", { requestId: reqId, reason: v.reason });
          return send(res, 401, { error: "Invalid or expired SSE token", requestId: reqId });
        }
        authed = true;
      } else {
        // No ?token= fallback: the long-lived token must never appear in a
        // URL. Bearer (master or share) or a minted short-lived ?sse= token only.
        const r = resolveRoomAuth(bearerToken(req.headers.authorization), roomId);
        authed = r.authed;
        reqShare = r.share || null;
        if (!authed && r.reason) {
          securityLog(console.log, "share_token_rejected", { requestId: reqId, reason: r.reason });
        }
      }
    } else {
      const r = resolveRoomAuth(bearerToken(req.headers.authorization), shareRoomId || null);
      authed = r.authed;
      reqShare = r.share || null;
      if (!authed && r.reason) {
        securityLog(console.log, "share_token_rejected", { requestId: reqId, reason: r.reason });
      }
    }
    if (!authed) {
      securityLog(console.log, "auth_failed", { requestId: reqId, route: url.pathname, sse: isSseEvents });
      // Tighter budget for failed authentications than for traffic in
      // general: credential guessing is per route + IP, so a flood of bad
      // tokens on one route is throttled without blocking other routes.
      const authFail = failedAuthRate.check(`${url.pathname}|${key}`);
      if (!authFail.allowed) {
        securityLog(console.log, "auth_rate_limited", { requestId: reqId, route: url.pathname });
        res.setHeader("Retry-After", Math.ceil(authFail.retryAfterMs / 1000));
        return send(res, 429, { error: "Too many failed authentication attempts", requestId: reqId });
      }
      return send(res, 401, { error: "Missing or invalid access token", requestId: reqId });
    }
  }

  /* ── Share links ────────────────────────────────────────────────────
   * A share link opens one model (one room) in any browser with no account
   * and no licence. Creation/revocation require the master token (in
   * loopback mode there is none, so anyone on the machine can create one —
   * same trust model as the rest of the loopback server). The issued token
   * is single-room, role-scoped and revocable; see server/share-tokens.mjs.
   * Share tokens never authenticate these management routes (the gate only
   * resolves them for room/project paths), so a link holder cannot mint
   * further links or revoke other people's.
   */
  if (url.pathname === "/api/shares" && req.method === "POST") {
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      const tooLarge = e && e.code === "payload_too_large";
      if (tooLarge) securityLog(console.log, "body_too_large", { requestId: reqId, route: "share_create" });
      return send(res, tooLarge ? 413 : 400, {
        error: tooLarge ? "Payload too large" : "Invalid JSON body",
        requestId: reqId,
      });
    }
    const room = typeof body.room === "string" ? body.room.trim() : "";
    if (!validId(room)) return send(res, 400, { error: "Invalid room id", requestId: reqId });
    const role = typeof body.role === "string" ? body.role.trim() : "";
    if (!isShareRole(role)) return send(res, 400, { error: "role must be 'view' or 'edit'", requestId: reqId });
    const ttlMs = clampShareTtlMs(body.ttlMs ?? SHARE_TOKEN_DEFAULT_TTL_MS);
    const now = Date.now();
    const sid = randomUUID();
    pruneExpiredShares();
    shares[sid] = {
      sid,
      room,
      role,
      createdAt: now,
      expiresAt: now + ttlMs,
      revoked: false,
    };
    saveShares();
    const token = issueShareToken(SHARE_SECRET, { room, role, sid, ttlMs, now });
    securityLog(console.log, "share_created", { requestId: reqId, sid, room, role });
    return send(res, 201, {
      sid,
      room,
      role,
      createdAt: now,
      expiresAt: now + ttlMs,
      token,
    });
  }

  if (url.pathname === "/api/shares" && req.method === "GET") {
    pruneExpiredShares();
    const list = Object.values(shares)
      .filter((s) => s && !s.revoked && typeof s.expiresAt === "number" && s.expiresAt > Date.now())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((s) => ({
        sid: s.sid,
        room: s.room,
        role: s.role,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
      }));
    return send(res, 200, { shares: list });
  }

  const shareRevokeMatch = url.pathname.match(/^\/api\/shares\/([^/]+)\/revoke$/);
  if (shareRevokeMatch && req.method === "POST") {
    const sid = safeDecode(shareRevokeMatch[1]);
    const entry = shares[sid];
    if (!entry) return send(res, 404, { error: "Unknown share", requestId: reqId });
    if (!entry.revoked) {
      entry.revoked = true;
      saveShares();
      securityLog(console.log, "share_revoked", { requestId: reqId, sid, room: entry.room });
    }
    return send(res, 200, { ok: true, sid, revoked: true });
  }

  if ((url.pathname === "/api/shares" || shareRevokeMatch) && req.method !== "GET" && req.method !== "POST") {
    return send(res, 405, { error: "Method not allowed" });
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);

  if (projectMatch) {
    const id = decodeURIComponent(projectMatch[1]);
    if (!validId(id)) return send(res, 400, { error: "Invalid project id" });

    if (req.method === "GET") {
      const project = projects[id];

      if (!project) {
        return send(res, 404, { error: "Project not found" });
      }

      return send(res, 200, project);
    }

    if (req.method === "PUT") {
      // A view-only share link may read the snapshot but never overwrite it.
      if (reqShare && reqShare.role === "view") {
        return send(res, 403, { error: "View-only share link cannot save the model", requestId: reqId });
      }
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const v = validateProjectBody(body, MAX_PROJECT_BODY);
        if (!v.ok) {
          const tooLarge = /too large/.test(v.reason);
          if (tooLarge) securityLog(console.log, "body_too_large", { requestId: reqId, route: "project_put" });
          return send(res, tooLarge ? 413 : 400, {
            error: tooLarge ? "Project body too large" : "Invalid project body",
            requestId: reqId,
          });
        }

        const project = {
          id,
          name: v.name || id,
          data: v.data,
          updatedAt: new Date().toISOString(),
        };

        projects[id] = project;
        const saved = saveJson(projectsFile, projects);
        if (!saved.ok) {
          // Fail closed (#91): the write was refused to protect the last
          // known-good copy on disk. The change is kept in memory only.
          return send(res, 503, {
            error: "Project could not be persisted: backup failed, so the write was refused to protect the last known-good copy on disk. The change is kept in memory only.",
            requestId: reqId,
          });
        }

        return send(res, 200, project);
      } catch (e) {
        const tooLarge = e && e.code === "payload_too_large";
        if (tooLarge) securityLog(console.log, "body_too_large", { requestId: reqId, route: "project_put" });
        return send(res, tooLarge ? 413 : 400, {
          error: tooLarge ? "Payload too large" : "Invalid JSON body",
          requestId: reqId,
        });
      }
    }

    return send(res, 405, { error: "Method not allowed" });
  }

  const roomEventsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/events$/);

  if (roomEventsMatch && req.method === "GET") {
    const roomId = decodeURIComponent(roomEventsMatch[1]);
    if (!validId(roomId)) return send(res, 400, { error: "Invalid room id", requestId: reqId });

    // Concurrent SSE budget per IP (remediation Phase 1.2).
    const ipCount = ssePerIp.get(key) || 0;
    if (ipCount >= SSE_MAX_PER_IP) {
      securityLog(console.log, "sse_limit", { requestId: reqId, active: ipCount });
      return send(res, 429, { error: "Too many event streams", requestId: reqId });
    }
    ssePerIp.set(key, ipCount + 1);

    getRoom(roomId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...SECURITY_HEADERS,
      "Cache-Control": "no-cache, no-transform",
      ...(res.obsCors || {}),
    });

    res.write("retry: 2000\n\n");
    res.write(`event: hello\ndata: ${JSON.stringify({ roomId, at: Date.now() })}\n\n`);
    res.write(`event: presence\ndata: ${JSON.stringify(presenceList(roomId))}\n\n`);

    addSse(roomId, res);
    res.on("close", () => {
      const n = (ssePerIp.get(key) || 1) - 1;
      if (n <= 0) ssePerIp.delete(key);
      else ssePerIp.set(key, n);
    });
    return;
  }

  /* POST /api/rooms/:id/sse-token — mint a short-lived, room-bound SSE
   * token (#92 item 5). Bearer-authenticated (the /api/ gate above refuses
   * ?token= here); the client fetches this before opening the EventSource,
   * so the long-lived token never appears in a URL. */
  const sseTokenMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/sse-token$/);

  if (sseTokenMatch) {
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
    const roomId = decodeURIComponent(sseTokenMatch[1]);
    if (!validId(roomId)) return send(res, 400, { error: "Invalid room id", requestId: reqId });

    // Minting issues credentials: same per-IP mutation budget as the other
    // room writes, so a token holder cannot mint in a loop.
    const mut = mutationRate.check(`sse-token|${key}`);
    if (!mut.allowed) {
      securityLog(console.log, "rate_limited", { requestId: reqId, scope: "mutation", action: "sse-token" });
      res.setHeader("Retry-After", Math.ceil(mut.retryAfterMs / 1000));
      return send(res, 429, { error: "Too many requests", requestId: reqId });
    }

    // No server secret, no short-lived tokens: a tokenless (loopback) server
    // authenticates nothing, so there is nothing to mint from. The client
    // opens the stream without a credential in that mode.
    if (!AUTH_TOKEN) {
      return send(res, 503, { error: "SSE tokens unavailable: server runs without a token", requestId: reqId });
    }

    const token = issueSseToken(AUTH_TOKEN, { room: roomId });
    return send(res, 200, {
      sseToken: token,
      room: roomId,
      ttlMs: SSE_TOKEN_DEFAULT_TTL_MS,
      expiresAt: Date.now() + SSE_TOKEN_DEFAULT_TTL_MS,
    });
  }

  const roomBaseMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);

  if (roomBaseMatch && req.method === "GET") {
    const roomId = decodeURIComponent(roomBaseMatch[1]);
    if (!validId(roomId)) return send(res, 400, { error: "Invalid room id" });
    const room = getRoom(roomId);

    return send(res, 200, {
      id: roomId,
      presence: presenceList(roomId),
      changes: room.changes.slice(-80),
      updatedAt: room.updatedAt,
    });
  }

  const roomActionMatch = url.pathname.match(
    /^\/api\/rooms\/([^/]+)\/(join|heartbeat|leave|change)$/,
  );

  if (roomActionMatch && req.method === "POST") {
    const roomId = decodeURIComponent(roomActionMatch[1]);
    if (!validId(roomId)) return send(res, 400, { error: "Invalid room id", requestId: reqId });
    const action = roomActionMatch[2];

    // Mutation budget (join/heartbeat/leave/change) — per IP.
    const mut = mutationRate.check(`${action}|${key}`);
    if (!mut.allowed) {
      securityLog(console.log, "rate_limited", { requestId: reqId, scope: "mutation", action });
      res.setHeader("Retry-After", Math.ceil(mut.retryAfterMs / 1000));
      return send(res, 429, { error: "Too many requests", requestId: reqId });
    }

    let body = {};

    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      const tooLarge = e && e.code === "payload_too_large";
      if (tooLarge) securityLog(console.log, "body_too_large", { requestId: reqId, route: "room_action" });
      return send(res, tooLarge ? 413 : 400, {
        error: tooLarge ? "Payload too large" : "Invalid JSON",
        requestId: reqId,
      });
    }

    const room = getRoom(roomId);
    const v = validateRoomActionBody(body, action);
    if (!v.ok) {
      const tooLarge = /too large/.test(v.reason);
      return send(res, tooLarge ? 413 : 400, {
        error: tooLarge ? "Room action body too large" : "Invalid room action body",
        requestId: reqId,
      });
    }
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";

    if (!validClientId(clientId)) {
      return send(res, 400, { error: "clientId must be a safe identifier (1-96 characters)", requestId: reqId });
    }

    if (action === "join" || action === "heartbeat") {
      room.clients[clientId] = {
        clientId,
        name: safeDisplayName(body.name),
        cursor: body.cursor ?? null,
        updatedAt: Date.now(),
      };

      touchRoom(room);
      broadcast(roomId, "presence", presenceList(roomId));

      return send(res, 200, { ok: true, presence: presenceList(roomId) });
    }

    if (action === "leave") {
      delete room.clients[clientId];
      touchRoom(room);
      broadcast(roomId, "presence", presenceList(roomId));

      return send(res, 200, { ok: true });
    }

    if (action === "change") {
      // A view-only share link may still send selection locks (presence), but
      // no model change of any other type — the server is the authority, the
      // client's disabled tools are only a mirror of this rule.
      if (reqShare && reqShare.role === "view" && body.type !== "lock" && body.type !== "unlock") {
        return send(res, 403, { error: "View-only share link cannot change the model", requestId: reqId });
      }
      const payloadCheck = boundedJsonValue(body.payload ?? {}, MAX_CHANGE_PAYLOAD);
      if (!payloadCheck.ok) {
        return send(res, 413, { error: "Change payload too large or not JSON-serializable", requestId: reqId });
      }
      const type = typeof body.type === "string" ? body.type.trim().slice(0, 120) : "unknown";
      const change = addChange(roomId, {
        id: body.id,
        clientId,
        type,
        payload: payloadCheck.value,
      });

      return send(res, 200, { ok: true, change });
    }
  }

  /* ═══════════ AI agent relay — terminal AI agents (AlphaCLI / AlphaCode)
     POST an order; the connected openBIMstudio browser session executes it in
     the engine and POSTs the result back; the original request resolves with
     that result. Browsers subscribe over SSE (opt-in from the Agent Bridge). */
  if (url.pathname === "/api/agent/exec" && req.method === "POST") {
    const budget = mutationRate.check(`agent-exec|${key}`);
    if (!budget.allowed) {
      securityLog(console.log, "rate_limited", { requestId: reqId, scope: "agent-exec" });
      res.setHeader("Retry-After", Math.ceil(budget.retryAfterMs / 1000));
      return send(res, 429, { error: "Too many agent orders", requestId: reqId });
    }

    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      const tooLarge = e && e.code === "payload_too_large";
      if (tooLarge) securityLog(console.log, "body_too_large", { requestId: reqId, route: "agent_exec" });
      return send(res, tooLarge ? 413 : 400, { error: tooLarge ? "Payload too large" : "Invalid JSON body", requestId: reqId });
    }

    const cmd = typeof body.cmd === "string" ? body.cmd.trim().slice(0, 4000) : "";
    const ask = typeof body.ask === "string" ? body.ask.trim().slice(0, 4000) : "";
    if (!cmd && !ask) {
      return send(res, 400, { error: "Provide a \"cmd\" (CAD command line) or an \"ask\" (natural language for the AI copilot)", requestId: reqId });
    }
    if (agentStudioClients.size === 0) {
      securityLog(console.log, "agent_no_studio", { requestId: reqId });
      return send(res, 503, { error: "No openBIMstudio session is connected to the relay. Open the app and press AI Agent Bridge → Connect Relay.", requestId: reqId });
    }

    const orderId = typeof body.orderId === "string" && body.orderId ? body.orderId.slice(0, 128) : randomUUID();
    securityLog(console.log, "agent_order", { requestId: reqId, orderId, kind: cmd ? "cmd" : "ask" });
    broadcastAgent("agent-order", {
      orderId,
      cmd: cmd || undefined,
      ask: ask || undefined,
      agent: typeof body.agent === "string" ? body.agent.slice(0, 120) : "external",
    });

    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        agentPendingOrders.delete(orderId);
        resolve({ ok: false, error: "timeout", note: "The studio did not answer within 20s" });
      }, AGENT_ORDER_TIMEOUT_MS);
      agentPendingOrders.set(orderId, { resolve, timer });
    });
    return send(res, 200, { orderId, ...result });
  }

  if (url.pathname === "/api/agent/result" && req.method === "POST") {
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: "Invalid JSON body", requestId: reqId });
    }
    const orderId = typeof body.orderId === "string" ? body.orderId : "";
    const pending = orderId ? agentPendingOrders.get(orderId) : undefined;
    if (!pending) {
      return send(res, 404, { error: "Unknown or already-resolved orderId", requestId: reqId });
    }
    clearTimeout(pending.timer);
    agentPendingOrders.delete(orderId);
    pending.resolve({
      ok: body.ok === true,
      ...(body.error != null ? { error: String(body.error).slice(0, 2000) } : {}),
      ...(body.state != null ? { state: body.state } : {}),
    });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/agent/status" && req.method === "GET") {
    return send(res, 200, {
      studios: agentStudioClients.size,
      pending: agentPendingOrders.size,
      updatedAt: new Date().toISOString(),
    });
  }

  if (isAgentEvents && req.method === "GET") {
    const ipCount = agentSsePerIp.get(key) || 0;
    if (ipCount >= AGENT_SSE_MAX_PER_IP) {
      securityLog(console.log, "agent_sse_limit", { requestId: reqId, active: ipCount });
      return send(res, 429, { error: "Too many agent event streams", requestId: reqId });
    }
    agentSsePerIp.set(key, ipCount + 1);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...SECURITY_HEADERS,
      ...(res.obsCors || {}),
    });
    res.write("retry: 2000\n\n");
    res.write(`event: hello\ndata: ${JSON.stringify({ role: "studio", at: Date.now() })}\n\n`);

    agentStudioClients.add(res);
    securityLog(console.log, "agent_stream_open", { requestId: reqId, active: agentStudioClients.size });
    res.on("close", () => {
      agentStudioClients.delete(res);
      const n = (agentSsePerIp.get(key) || 1) - 1;
      if (n <= 0) agentSsePerIp.delete(key);
      else agentSsePerIp.set(key, n);
      securityLog(console.log, "agent_stream_close", { active: agentStudioClients.size });
    });
    return;
  }

  /* ═══════════ Central model — server-authoritative worksharing ═══
     POST /api/central/:room/join|leave|role|op|workset|workset-owner|
       borrow|relinquish|borrow-request|borrow-respond|resolve|restore
     GET  /api/central/:room/state|sync?since=N|history|audit
     All routes are behind the /api/ Bearer gate above. Ops are sequenced
     by the server, journalled (fsync) before ack, and broadcast as
     `central-op` events on the room's existing SSE channel. */
  const centralMatch = url.pathname.match(/^\/api\/central\/([^/]+)(?:\/(state|sync|history|audit|join|leave|role|op|workset|workset-owner|borrow|relinquish|borrow-request|borrow-respond|resolve|restore))?$/);
  if (centralMatch) {
    const roomId = decodeURIComponent(centralMatch[1]);
    if (!validId(roomId)) return send(res, 400, { error: "Invalid room id", requestId: reqId });
    const sub = centralMatch[2] || "";
    const store = centralStore(roomId);
    sweepCentral(store);
    getRoom(roomId); // legacy room record so SSE broadcast has a channel

    const centralErr = (status, error) => send(res, status, { error, requestId: reqId });
    const commitAndBroadcast = (r, auditAction, auditDetail = {}) => {
      if (r.error) {
        store.audit("rejected", { kind: auditAction, actor: auditDetail.actor, error: r.error.error, status: r.error.status });
        return centralErr(r.error.status || 400, r.error.error);
      }
      store.commit(r.entry);
      store.audit(auditAction, { actor: r.entry.actor, seq: r.entry.seq, ...auditDetail });
      broadcast(roomId, "central-op", store.publicEntry(r.entry));
      return send(res, 200, {
        ok: true, revision: store.state.revision,
        entry: store.publicEntry(r.entry),
        applied: r.entry.applied || {},
        rejected: r.entry.rejected || {},
        conflicts: r.entry.conflicts || [],
      });
    };

    if (req.method === "GET" && (sub === "state" || sub === "sync" || sub === "history" || sub === "audit" || sub === "")) {
      if (sub === "state" || sub === "") {
        return send(res, 200, { ok: true, ...publicState(store.state) });
      }
      if (sub === "sync") {
        const since = Number(url.searchParams.get("since") || "0");
        if (!Number.isInteger(since) || since < 0) return centralErr(400, "since must be a non-negative integer");
        const { entries, oldestRetainedSeq, truncated } = store.entriesSince(since);
        const out = { ok: true, revision: store.state.revision, oldestRetainedSeq, truncated, entries: entries.map((e) => store.publicEntry(e)) };
        if (truncated) out.state = publicState(store.state);
        return send(res, 200, out);
      }
      if (sub === "history") {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || "100") || 100));
        const list = store.entries.slice(-limit).map((e) => store.publicEntry(e));
        return send(res, 200, { ok: true, revision: store.state.revision, entries: list });
      }
      if (sub === "audit") {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || "200") || 200));
        return send(res, 200, { ok: true, entries: store.readAudit(limit) });
      }
    }

    if (req.method === "POST") {
      const mut = mutationRate.check(`central|${key}`);
      if (!mut.allowed) {
        securityLog(console.log, "rate_limited", { requestId: reqId, scope: "central" });
        res.setHeader("Retry-After", Math.ceil(mut.retryAfterMs / 1000));
        return send(res, 429, { error: "Too many requests", requestId: reqId });
      }
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw.length > CENTRAL_MAX_BODY) {
          securityLog(console.log, "body_too_large", { requestId: reqId, route: "central" });
          return send(res, 413, { error: "Payload too large", requestId: reqId });
        }
        body = raw ? JSON.parse(raw) : {};
      } catch (e) {
        return send(res, 400, { error: "Invalid JSON", requestId: reqId });
      }
      const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      if (!validClientId(clientId)) {
        return send(res, 400, { error: "clientId must be a safe identifier (1-96 characters)", requestId: reqId });
      }
      const actor = clientId;

      if (sub === "join") {
        const r = joinRoom(store.state, { clientId, name: body.name });
        return commitAndBroadcast(r, "join", { actor });
      }
      if (sub === "leave") {
        const r = leaveRoom(store.state, { clientId });
        return commitAndBroadcast(r, "leave", { actor });
      }
      if (sub === "role") {
        const target = typeof body.targetClientId === "string" ? body.targetClientId.trim() : "";
        if (!validClientId(target)) return centralErr(400, "targetClientId must be a safe identifier");
        const r = setRole(store.state, { actor, clientId: target, role: body.role });
        return commitAndBroadcast(r, "set_role", { actor, target });
      }
      if (sub === "op") {
        if (body.type !== "upsert" && body.type !== "delete") {
          return centralErr(400, "type must be 'upsert' or 'delete'");
        }
        const op = {
          opId: body.opId, actor,
          elementId: body.elementId, worksetId: body.worksetId,
          fields: body.fields, baseRevision: body.baseRevision,
        };
        const r = body.type === "delete"
          ? submitDelete(store.state, op)
          : submitUpsert(store.state, op);
        if (r.duplicate) {
          const orig = store.entries.find((e) => e.opId === body.opId);
          return send(res, 200, {
            ok: true, duplicate: true, revision: store.state.revision,
            entry: orig ? store.publicEntry(orig) : null,
            applied: orig ? orig.applied || {} : {},
            conflicts: orig ? orig.conflicts || [] : [],
          });
        }
        return commitAndBroadcast(r, body.type === "delete" ? "delete_element" : "upsert_element", { actor, elementId: body.elementId });
      }
      if (sub === "workset") {
        const r = createWorkset(store.state, { actor, name: body.name, kind: body.kind });
        return commitAndBroadcast(r, "create_workset", { actor });
      }
      if (sub === "workset-owner") {
        const owner = body.owner === null ? null : (typeof body.owner === "string" ? body.owner.trim() : "");
        if (owner !== null && !validClientId(owner)) return centralErr(400, "owner must be a member clientId or null");
        const r = setWorksetOwner(store.state, { actor, worksetId: body.worksetId, owner });
        return commitAndBroadcast(r, "set_workset_owner", { actor });
      }
      if (sub === "borrow") {
        const r = borrowElement(store.state, { actor, elementId: body.elementId, actorName: body.name });
        return commitAndBroadcast(r, "borrow", { actor, elementId: body.elementId });
      }
      if (sub === "relinquish") {
        const r = relinquishBorrow(store.state, { actor, elementId: body.elementId });
        return commitAndBroadcast(r, "relinquish", { actor, elementId: body.elementId });
      }
      if (sub === "borrow-request") {
        const r = submitBorrowRequest(store.state, { actor, elementId: body.elementId });
        return commitAndBroadcast(r, "borrow_request", { actor, elementId: body.elementId });
      }
      if (sub === "borrow-respond") {
        const r = respondBorrowRequest(store.state, { actor, requestId: body.requestId, grant: body.grant === true, message: body.message });
        return commitAndBroadcast(r, "borrow_respond", { actor, requestId: body.requestId });
      }
      if (sub === "resolve") {
        const r = resolveConflict(store.state, { actor, conflictId: body.conflictId, choice: body.choice });
        return commitAndBroadcast(r, "resolve_conflict", { actor, conflictId: body.conflictId });
      }
      if (sub === "restore") {
        const r = restoreToRevision(store.state, store.entries, { actor, revision: body.revision });
        return commitAndBroadcast(r, "restore", { actor, revision: body.revision });
      }
      return send(res, 404, { error: "Unknown central action", requestId: reqId });
    }

    return send(res, 405, { error: "Method not allowed", requestId: reqId });
  }

  if (isConvertRoute(url, req)) {
    await handleConvert(req, res, url, reqId);
    return;
  }

  return send(res, 404, {
    error:
      "Not found. Use /api/projects/:id or /api/rooms/:room or /api/rooms/:room/events or /api/rooms/:room/sse-token or /api/rooms/:room/join or /api/shares or /api/convert or /api/agent/exec or /api/agent/status or /api/central/:room/{state,sync,history,audit,join,leave,role,op,workset,workset-owner,borrow,relinquish,borrow-request,borrow-respond,resolve,restore}",
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   RVT / NWD / NWC → IFC conversion endpoint
   ═════════════════════════════════════════════════════════════════════════

   Uses Autodesk Platform Services (APS, formerly Forge) Model Derivative
   API to convert proprietary BIM files (RVT, NWD, NWC) to IFC format.

   Flow:
     1. Client uploads file via POST /api/convert
     2. Server authenticates with APS (client credentials)
      3. Server uploads to APS OSS bucket
     4. Server submits translation job (output: IFC)
     5. Server returns job URN + status endpoint
     6. Client polls GET /api/convert/:urn/status
     7. When done, client downloads IFC via GET /api/convert/:urn/download
*/

const APS_CLIENT_ID = process.env.APS_CLIENT_ID || "";
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET || "";
const APS_BUCKET = process.env.APS_BUCKET || "openbimstudio-convert";
const conversionJobs = new Map();

async function getAPSToken() {
  if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) return null;
  try {
    const res = await fetch("https://developer.api.autodesk.com/authentication/v1/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: APS_CLIENT_ID,
        client_secret: APS_CLIENT_SECRET,
        grant_type: "client_credentials",
        scope: "data:read data:write bucket:read bucket:create",
      }),
    });
    const data = await res.json();
    return data.access_token;
  } catch (e) {
    console.error("[convert] APS auth failed:", e.message);
    return null;
  }
}

function isConvertRoute(url, req) {
  if (url.pathname === "/api/convert" && req.method === "POST") return true;
  return req.method === "GET" && /^\/api\/convert\/[^/]+\/(status|download)$/.test(url.pathname);
}

async function handleConvert(req, res, url, reqId) {
  // POST /api/convert — upload RVT/NWD/NWC file and start conversion
  if (url.pathname === "/api/convert" && req.method === "POST") {
    const fileName = safeUploadName(req.headers["x-file-name"]);
    if (!fileName) {
      return send(res, 400, { error: "Unsupported or missing file name (accepted: .rvt .nwd .nwc .ifc .dwg .dxf)", requestId: reqId });
    }
    const fileSize = parseInt(req.headers["content-length"] || "0", 10);

    if (fileSize > MAX_UPLOAD_BODY) return send(res, 413, { error: "File too large", requestId: reqId });

    // Conversion concurrency cap — conversion is expensive (memory + APS quota).
    if (activeConversions >= MAX_CONCURRENT_CONVERSIONS) {
      securityLog(console.log, "convert_busy", { requestId: reqId, active: activeConversions });
      res.setHeader("Retry-After", "30");
      return send(res, 429, { error: "Conversion capacity reached — retry shortly", requestId: reqId });
    }

    // Streaming, size-limited read: oversized uploads are destroyed mid-stream.
    let fileBuffer;
    try {
      fileBuffer = await readBodyBuffer(req);
    } catch (e) {
      const tooLarge = e && e.code === "payload_too_large";
      securityLog(console.log, tooLarge ? "upload_too_large" : "upload_read_failed", { requestId: reqId, name: redactFileName(fileName) });
      return send(res, tooLarge ? 413 : 400, { error: tooLarge ? "File too large" : "Upload failed", requestId: reqId });
    }

    // Content-signature validation where a public format allows it.
    const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    const sig = sniffSignature(fileBuffer, ext);
    if (!sig.ok) {
      securityLog(console.log, "upload_signature_rejected", { requestId: reqId, name: redactFileName(fileName), note: sig.note });
      return send(res, 400, { error: "File content does not match its extension", requestId: reqId });
    }

    // Persist under a SERVER-GENERATED opaque id. The client-supplied name is
    // metadata only — never a storage key, never echoed as a path.
    const meta = storeUpload(uploadsDir, { buffer: fileBuffer, originalName: fileName, ext, note: sig.note });
    securityLog(console.log, "upload_stored", { requestId: reqId, uploadId: meta.id, name: redactFileName(fileName), bytes: meta.size, signatureChecked: sig.signatureChecked });

    // Check if APS credentials are configured
    if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
      // Fallback: keep the upload for manual conversion. Explicitly NOT sent
      // anywhere; client UI must tell the user this (privacy notice).
      return send(res, 200, {
        ok: true,
        mode: "manual",
        uploadId: meta.id,
        message:
          "APS credentials not configured. File stored for manual conversion. " +
          "Configure APS_CLIENT_ID and APS_CLIENT_SECRET in environment " +
          "to enable automatic RVT→IFC conversion.",
        hint: "In BIM: File → Export → IFC, then import the .ifc here.",
      });
    }

    // APS conversion flow (explicit configuration = explicit consent scope;
    // the client must present the privacy notice before uploading — Phase 3.3).
    activeConversions++;
    try {
      const token = await getAPSToken();
      if (!token) throw new Error("APS authentication failed");

      // 1. Ensure bucket exists
      try {
        await fetch(`https://developer.api.autodesk.com/oss/v2/buckets/${APS_BUCKET}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ bucketKey: APS_BUCKET, policyKey: "transient" }),
        });
      } catch { /* bucket may already exist */ }

      // 2. Upload file to OSS (opaque server-side object key)
      const objectKey = `${meta.id}${ext}`;
      const uploadRes = await fetch(
        `https://developer.api.autodesk.com/oss/v2/buckets/${APS_BUCKET}/objects/${encodeURIComponent(objectKey)}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
          },
          body: fileBuffer,
        },
      );
      const uploadData = await uploadRes.json();
      const urn = Buffer.from(uploadData.objectId).toString("base64");

      // 3. Submit translation job (RVT/NWD → IFC)
      await fetch("https://developer.api.autodesk.com/modelderivative/v2/designdata/job", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: { urn },
          output: { formats: [{ type: "ifc", views: ["3d"] }] },
        }),
      });

      // 4. Store job info (APS token kept out of logs; job retention sweeps below)
      conversionJobs.set(urn, {
        urn,
        uploadId: meta.id,
        ext,
        status: "inprogress",
        startedAt: Date.now(),
        token,
      });

      securityLog(console.log, "convert_started", { requestId: reqId, uploadId: meta.id, name: redactFileName(fileName) });

      return send(res, 200, {
        ok: true,
        mode: "aps",
        urn,
        status: "inprogress",
        message: "Uploaded. Conversion to IFC started. Poll /api/convert/:urn/status for progress.",
      });
    } catch (e) {
      securityLog(console.log, "convert_failed", { requestId: reqId, detail: String(e && e.message || e) });
      return send(res, 500, { error: "Conversion failed", requestId: reqId });
    } finally {
      activeConversions--;
    }
  }

  // GET /api/convert/:urn/status — check conversion status
  const convertMatch = url.pathname.match(/^\/api\/convert\/([^/]+)\/status$/);
  if (convertMatch && req.method === "GET") {
    const urn = decodeURIComponent(convertMatch[1]);
    if (!/^[A-Za-z0-9_=-]{1,300}$/.test(urn)) return send(res, 400, { error: "Invalid job id" });
    const job = conversionJobs.get(urn);

    if (!job) return send(res, 404, { error: "Unknown conversion job" });

    try {
      const manifestRes = await fetch(
        `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
        { headers: { Authorization: `Bearer ${job.token}` } },
      );
      const manifest = await manifestRes.json();

      const status = manifest.status; // "pending" | "inprogress" | "success" | "failed"
      const progress = manifest.progress || "0%";

      if (status === "success") {
        // Find the IFC derivative
        const ifcDerivative = manifest.derivatives?.find((d) => d.outputType === "ifc");
        job.status = "success";
        job.ifcUrn = ifcDerivative?.urn || urn;
        securityLog(console.log, "convert_completed", { uploadId: job.uploadId });
      } else if (status === "failed") {
        job.status = "failed";
        securityLog(console.log, "convert_job_failed", { uploadId: job.uploadId });
      }

      return send(res, 200, {
        urn,
        uploadId: job.uploadId,
        status,
        progress,
        message: status === "success"
          ? "Conversion complete. Use /api/convert/:urn/download to get the IFC."
          : status === "failed"
          ? "Conversion failed. Check APS dashboard for details."
          : `Converting: ${progress}`,
      });
    } catch (e) {
      securityLog(console.log, "convert_status_failed", { detail: String(e && e.message || e) });
      return send(res, 500, { error: "Status check failed" });
    }
  }

  // GET /api/convert/:urn/download — download converted IFC
  const downloadMatch = url.pathname.match(/^\/api\/convert\/([^/]+)\/download$/);
  if (downloadMatch && req.method === "GET") {
    const urn = decodeURIComponent(downloadMatch[1]);
    if (!/^[A-Za-z0-9_=-]{1,300}$/.test(urn)) return send(res, 400, { error: "Invalid job id" });
    const job = conversionJobs.get(urn);

    if (!job) return send(res, 404, { error: "Unknown conversion job" });
    if (job.status !== "success") return send(res, 400, { error: "Conversion not complete" });

    try {
      // Get the manifest to find the IFC derivative URL
      const manifestRes = await fetch(
        `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
        { headers: { Authorization: `Bearer ${job.token}` } },
      );
      const manifest = await manifestRes.json();

      const ifcDerivative = manifest.derivatives?.find((d) => d.outputType === "ifc");
      if (!ifcDerivative) return send(res, 404, { error: "IFC derivative not found" });

      // Download the IFC file from APS
      const ifcRes = await fetch(
        `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest/${ifcDerivative.urn}`,
        { headers: { Authorization: `Bearer ${job.token}` } },
      );
      const ifcBuffer = Buffer.from(await ifcRes.arrayBuffer());

      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${job.uploadId}.ifc"`,
        "Content-Length": ifcBuffer.length,
      });
      res.end(ifcBuffer);

      // Clean up job + the stored upload after a successful download
      // (retention policy: downloaded temporary files are deleted).
      conversionJobs.delete(urn);
      try { fs.rmSync(path.join(uploadsDir, job.uploadId), { force: true }); } catch { /* */ }
      try { fs.rmSync(path.join(uploadsDir, `${job.uploadId}.json`), { force: true }); } catch { /* */ }
      securityLog(console.log, "convert_downloaded", { uploadId: job.uploadId });
      return;
    } catch (e) {
      securityLog(console.log, "convert_download_failed", { detail: String(e && e.message || e) });
      return send(res, 500, { error: "Download failed" });
    }
  }
}

/* Retention sweep (Phase 1.3): expired uploads + stale conversion jobs. */
setInterval(() => {
  const removed = sweepExpired(uploadsDir, UPLOAD_RETENTION_MS);
  if (removed.length) {
    securityLog(console.log, "upload_retention_sweep", { removed: removed.length });
  }
  const now = Date.now();
  for (const [urn, job] of conversionJobs) {
    if (now - Number(job.startedAt || 0) > UPLOAD_RETENTION_MS) {
      conversionJobs.delete(urn);
      try { fs.rmSync(path.join(uploadsDir, job.uploadId), { force: true }); } catch { /* */ }
      try { fs.rmSync(path.join(uploadsDir, `${job.uploadId}.json`), { force: true }); } catch { /* */ }
    }
  }
}, 10 * 60_000).unref();

server.listen(PORT, HOST, () => {
  console.log(
    `[collab] Open BIM Studio server running on http://${HOST}:${PORT}` + (AUTH_TOKEN ? " (token required)" : ""),
  );
  if (process.env.PORT === "0" && server.address() && typeof server.address() === "object") {
    // Ephemeral-port mode for integration tests.
    console.log(`[collab] PORT=${server.address().port}`);
  }
  console.log(`[collab] Projects API:   /api/projects/:id`);
  console.log(`[collab] Rooms API:      /api/rooms/:room`);
  console.log(`[collab] Live SSE API:   /api/rooms/:room/events`);
  console.log(`[collab] Shares API:     /api/shares (create/list/revoke; ?share= opens a room)`);
  console.log(`[collab] Convert API:    /api/convert (RVT/NWD → IFC)`);
});

// Protect the HTTP parser from slow-client and idle-connection exhaustion.
// Uploads are still bounded by MAX_UPLOAD_BODY and can use the full request timeout.
server.requestTimeout = Number(process.env.OBS_REQUEST_TIMEOUT_MS || 120_000);
server.headersTimeout = Number(process.env.OBS_HEADERS_TIMEOUT_MS || 15_000);
server.keepAliveTimeout = Number(process.env.OBS_KEEPALIVE_TIMEOUT_MS || 5_000);
