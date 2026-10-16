import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const rel = "server/index.mjs";
const full = path.join(root, rel);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let src = await fs.readFile(full, "utf8");

if (src.includes("Open BIM Studio collaboration API")) {
  console.log("NO CHANGE: root index already present.");
  process.exit(0);
}

const anchor = "const url = new URL(";
const idx = src.indexOf(anchor);

if (idx < 0) {
  console.log("SKIP: anchor not found.");
  process.exit(0);
}

const inject =
  '  if (req.url === "/" || req.url === "/index.html" || req.url === "/favicon.ico") {\n' +
  "    return send(res, 200, {\n" +
  '      name: "Open BIM Studio collaboration API",\n' +
  '      status: "online",\n' +
  "      time: new Date().toISOString(),\n" +
  "      endpoints: [\n" +
  '        "GET/PUT /api/projects/:id",\n' +
  '        "GET /api/rooms/:room",\n' +
  '        "GET /api/rooms/:room/events (SSE live)",\n' +
  '        "POST /api/rooms/:room/join|heartbeat|leave|change",\n' +
  "      ],\n" +
  "    });\n" +
  "  }\n\n";

await fs.copyFile(full, full + ".bak-" + stamp);
src = src.slice(0, idx) + inject + src.slice(idx);
await fs.writeFile(full, src, "utf8");
console.log("PATCHED: server/index.mjs (root index added).");