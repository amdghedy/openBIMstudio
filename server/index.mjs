import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllowedOrigins, originAllowed, corsHeaders, SECURITY_HEADERS, validId, tokenOk, safeUploadName } from "./security.mjs";
import { resolveStartupConfig } from "./startup-config.mjs";
import { createRateLimiter, clientKey, correlationId, securityLog, redactFileName } from "./rate-limit.mjs";
import { issueSseToken, verifySseToken } from "./sse-tokens.mjs";
import { sniffSignature, storeUpload, sweepExpired } from "./upload-store.mjs";

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
const uploadsDir = path.join(dataDir, "uploads");

const PORT = Number(process.env.PORT || 4000);
const HOST = CFG.host;
const AUTH_TOKEN = CFG.token;
const ALLOWED_ORIGINS = CFG.origins
  ? new Set(CFG.origins)
  : parseAllowedOrigins();
const MAX_BODY = Number(process.env.OBS_MAX_BODY || 200 * 1024 * 1024);
const PRESENCE_TIMEOUT_MS = 45000;
const MAX_CHANGES_PER_ROOM = 500;

/* Rate budgets (per IP). Tunable for tests via env. */
const RATE_WINDOW_MS = Number(process.env.OBS_RATE_WINDOW_MS || 60_000);
const RATE_MAX_GENERAL = Number(process.env.OBS_RATE_MAX || 300);
const RATE_MAX_MUTATION = Number(process.env.OBS_RATE_MAX_MUTATION || 120);
const SSE_MAX_PER_IP = Number(process.env.OBS_SSE_MAX_PER_IP || 5);
const UPLOAD_RETENTION_MS = Number(process.env.OBS_UPLOAD_RETENTION_MS || 24 * 60 * 60_000);
const MAX_CONCURRENT_CONVERSIONS = Number(process.env.OBS_MAX_CONCURRENT_CONVERSIONS || 3);

const httpRate = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_MAX_GENERAL });
const mutationRate = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_MAX_MUTATION });
const ssePerIp = new Map(); // ip -> active SSE connection count
let activeConversions = 0;

const sseClients = new Map();

function ensureStore() {
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(projectsFile)) {
    fs.writeFileSync(projectsFile, "{}", "utf8");
  }

  if (!fs.existsSync(roomsFile)) {
    fs.writeFileSync(roomsFile, "{}", "utf8");
  }
}

function loadJson(file, fallback) {
  ensureStore();

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  ensureStore();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

let projects = loadJson(projectsFile, {});
let rooms = loadJson(roomsFile, {});

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
        reject(Object.assign(new Error("Payload too large"), { code: "payload_too_large" }));
        req.destroy();
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
 * connection is destroyed as soon as the limit is exceeded, not after the
 * full body has been buffered. */
function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Payload too large"), { code: "payload_too_large" }));
        req.destroy();
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

  /* Token policy (remediation Phase 1.2):
   *  - Non-SSE /api/ routes: Authorization: Bearer only. Query-string tokens
   *    are refused (they leak into logs, proxies and history).
   *  - SSE events route only: EventSource cannot set headers, so a signed
   *    short-lived ?sse= token is preferred; the long-lived ?token= form is
   *    still accepted there (documented URL-leakage trade-off).
   */
  if (url.pathname.startsWith("/api/")) {
    let authed = false;
    if (isSseEvents) {
      const sseToken = url.searchParams.get("sse");
      if (sseToken) {
        const roomId = decodeURIComponent((url.pathname.match(/^\/api\/rooms\/([^/]+)\/events$/) || [])[1] || "");
        const v = verifySseToken(sseToken, AUTH_TOKEN, { room: roomId });
        if (!v.ok) {
          securityLog(console.log, "sse_token_rejected", { requestId: reqId, reason: v.reason });
          return send(res, 401, { error: "Invalid or expired SSE token", requestId: reqId });
        }
        authed = true;
      } else {
        authed = tokenOk(req.headers.authorization, url.searchParams.get("token"), AUTH_TOKEN);
      }
    } else {
      authed = tokenOk(req.headers.authorization, undefined, AUTH_TOKEN);
    }
    if (!authed) {
      securityLog(console.log, "auth_failed", { requestId: reqId, route: url.pathname, sse: isSseEvents });
      return send(res, 401, { error: "Missing or invalid access token", requestId: reqId });
    }
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
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};

        const project = {
          id,
          name: body.name || id,
          data: body.data ?? body,
          updatedAt: new Date().toISOString(),
        };

        projects[id] = project;
        saveJson(projectsFile, projects);

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
    const clientId = String(body.clientId || "").trim();

    if (!clientId) {
      return send(res, 400, { error: "clientId required" });
    }

    if (action === "join" || action === "heartbeat") {
      room.clients[clientId] = {
        clientId,
        name: String(body.name || "Guest"),
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
      const change = addChange(roomId, {
        id: body.id,
        clientId,
        type: body.type,
        payload: body.payload,
      });

      return send(res, 200, { ok: true, change });
    }
  }

  if (isConvertRoute(url, req)) {
    await handleConvert(req, res, url, reqId);
    return;
  }

  return send(res, 404, {
    error:
      "Not found. Use /api/projects/:id or /api/rooms/:room or /api/rooms/:room/events or /api/rooms/:room/join or /api/convert",
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

    if (fileSize > MAX_BODY) return send(res, 413, { error: "File too large", requestId: reqId });

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
  console.log(`[collab] Convert API:    /api/convert (RVT/NWD → IFC)`);
});