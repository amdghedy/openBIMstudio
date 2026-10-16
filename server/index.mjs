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
      "Not found. Use /api/projects/:id or /api/rooms/:room or /api/rooms/:room/events or /api/rooms/:room/join",
  });
});

server.listen(PORT, () => {
  console.log(
    `[collab] Open BIM Studio server running on http://localhost:${PORT}`,
  );
  console.log(`[collab] Projects API:   /api/projects/:id`);
  console.log(`[collab] Rooms API:      /api/rooms/:room`);
  console.log(`[collab] Live SSE API:   /api/rooms/:room/events`);
});