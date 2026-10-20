import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dataDir = path.join(__dirname, "data");
const projectsFile = path.join(dataDir, "projects.json");
const roomsFile = path.join(dataDir, "rooms.json");

const PORT = Number(process.env.PORT || 4000);
const MAX_BODY = 200 * 1024 * 1024;
const PRESENCE_TIMEOUT_MS = 45000;
const MAX_CHANGES_PER_ROOM = 500;

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
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
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
        reject(new Error("Payload too large"));
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
  if (req.method === "OPTIONS") {
    return send(res, 204, "");
  }

  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);

  if (projectMatch) {
    const id = decodeURIComponent(projectMatch[1]);

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
        return send(res, 400, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return send(res, 405, { error: "Method not allowed" });
  }

  const roomEventsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/events$/);

  if (roomEventsMatch && req.method === "GET") {
    const roomId = decodeURIComponent(roomEventsMatch[1]);
    getRoom(roomId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    });

    res.write("retry: 2000\n\n");
    res.write(`event: hello\ndata: ${JSON.stringify({ roomId, at: Date.now() })}\n\n`);
    res.write(`event: presence\ndata: ${JSON.stringify(presenceList(roomId))}\n\n`);

    addSse(roomId, res);
    return;
  }

  const roomBaseMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);

  if (roomBaseMatch && req.method === "GET") {
    const roomId = decodeURIComponent(roomBaseMatch[1]);
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
    const action = roomActionMatch[2];

    let body = {};

    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: "Invalid JSON" });
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

// POST /api/convert — upload RVT/NWD/NWC file and start conversion
if (url.pathname === "/api/convert" && req.method === "POST") {
  const contentType = req.headers["content-type"] || "";
  const fileName = req.headers["x-file-name"] || `upload-${Date.now()}`;
  const fileSize = parseInt(req.headers["content-length"] || "0", 10);

  if (fileSize > MAX_BODY) return send(res, 413, { error: "File too large" });

  // Collect the file data
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const fileBuffer = Buffer.concat(chunks);

    // Check if APS credentials are configured
    if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
      // Fallback: save the file locally and tell the user to convert externally
      const uploadsDir = path.join(dataDir, "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });
      const savePath = path.join(uploadsDir, fileName);
      fs.writeFileSync(savePath, fileBuffer);

      return send(res, 200, {
        ok: true,
        mode: "manual",
        message:
          "APS credentials not configured. File saved to server. " +
          "Configure APS_CLIENT_ID and APS_CLIENT_SECRET in environment " +
          "to enable automatic RVT→IFC conversion.",
        fileName,
        savedPath: savePath,
        hint: "In BIM: File → Export → IFC, then import the .ifc here.",
      });
    }

    // APS conversion flow
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

      // 2. Upload file to OSS
      const objectKey = `${Date.now()}-${fileName}`;
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

      // 4. Store job info
      conversionJobs.set(urn, {
        urn,
        fileName,
        status: "inprogress",
        startedAt: Date.now(),
        token,
      });

      console.log(`[convert] job started: ${fileName} → URN ${urn.substring(0, 20)}...`);

      return send(res, 200, {
        ok: true,
        mode: "aps",
        urn,
        fileName,
        status: "inprogress",
        message: `File "${fileName}" uploaded to APS. Conversion to IFC started. Poll /api/convert/:urn/status for progress.`,
      });
    } catch (e) {
      console.error("[convert] conversion failed:", e.message);
      return send(res, 500, { error: "Conversion failed: " + e.message });
    }
  });
  return;
}

// GET /api/convert/:urn/status — check conversion status
const convertMatch = url.pathname.match(/^\/api\/convert\/([^/]+)\/status$/);
if (convertMatch && req.method === "GET") {
  const urn = decodeURIComponent(convertMatch[1]);
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
      console.log(`[convert] job completed: ${job.fileName}`);
    } else if (status === "failed") {
      job.status = "failed";
      console.error(`[convert] job failed: ${job.fileName}`);
    }

    return send(res, 200, {
      urn,
      fileName: job.fileName,
      status,
      progress,
      message: status === "success"
        ? "Conversion complete. Use /api/convert/:urn/download to get the IFC."
        : status === "failed"
        ? "Conversion failed. Check APS dashboard for details."
        : `Converting: ${progress}`,
    });
  } catch (e) {
    return send(res, 500, { error: "Status check failed: " + e.message });
  }
}

// GET /api/convert/:urn/download — download converted IFC
const downloadMatch = url.pathname.match(/^\/api\/convert\/([^/]+)\/download$/);
if (downloadMatch && req.method === "GET") {
  const urn = decodeURIComponent(downloadMatch[1]);
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
      "Content-Disposition": `attachment; filename="${job.fileName.replace(/\.[^.]+$/, "")}.ifc"`,
      "Content-Length": ifcBuffer.length,
    });
    res.end(ifcBuffer);

    // Clean up job after download
    conversionJobs.delete(urn);
    console.log(`[convert] IFC downloaded: ${job.fileName}`);
    return;
  } catch (e) {
    return send(res, 500, { error: "Download failed: " + e.message });
  }
}

server.listen(PORT, () => {
  console.log(
    `[collab] Open BIM Studio server running on http://localhost:${PORT}`,
  );
  console.log(`[collab] Projects API:   /api/projects/:id`);
  console.log(`[collab] Rooms API:      /api/rooms/:room`);
  console.log(`[collab] Live SSE API:   /api/rooms/:room/events`);
  console.log(`[collab] Convert API:    /api/convert (RVT/NWD → IFC)`);
});