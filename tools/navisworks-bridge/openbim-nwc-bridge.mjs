#!/usr/bin/env node
/**
 * openBIM NWC Bridge — local loopback service that converts Autodesk
 * Navisworks files (.nwc / .nwd / .nwf) into IFC using the Navisworks
 * installation already present on this PC.
 *
 * Why a bridge?  NWC/NWD are closed binary formats that no browser engine can
 * decode, and Navisworks has no built-in IFC export (Autodesk support
 * confirms it). The free, MIT-licensed BIMCamel IFC exporter plug-in performs
 * the conversion inside Navisworks 2024–2027 (Manage or Simulate). This
 * bridge moves files in and out of that flow automatically:
 *
 *   guided mode (default)
 *     1. the web app POSTs the .nwc bytes to POST /openbim-bridge/jobs
 *     2. the bridge saves them, opens the file in the installed Navisworks
 *        and watches the job's export folder
 *     3. the user clicks BIMCamel ▸ IFC exporter ▸ Export (one click, output
 *        folder pre-shown by the app; "Open folder" button available)
 *     4. the bridge detects the stable *.ifc output and serves it back
 *
 *   headless mode (optional, zero clicks)
 *     Uses the headless harness documented in the BIMCamel repository
 *     (BIMCamelHeadlessRunner.exe <input> <plugin.dll> <out.ifc> <merge> <IFC4|IFC2X3>)
 *     when its binaries are present (auto-detected or configured).
 *
 * Security posture: binds 127.0.0.1 only, loopback Host check, explicit CORS
 * allow-list (loopback dev origins + user-configured extras), sanitized file
 * names, byte-capped bodies, job TTL with workspace cleanup. No telemetry,
 * no cloud calls — files never leave the machine.
 *
 * Usage:  node openbim-nwc-bridge.mjs
 *   (see start-bridge.cmd and README.md)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  isLoopbackHost,
  corsHeaders,
  preflightHeaders,
  sanitizeSourceFileName,
  sanitizeIfcFileName,
  sendJson,
  readBodyWithCap,
} from "./lib/http-utils.mjs";
import {
  findNavisworksInstalls,
  detectBimCamel,
  buildCapability,
} from "./lib/detect.mjs";
import {
  createJobStore,
  scanExportFolder,
  collectStableIfc,
} from "./lib/job-store.mjs";

const VERSION = "1.0.0";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration (environment overrides make the bridge fully testable)
// ---------------------------------------------------------------------------
const cfg = {
  port: Number(process.env.OBS_BRIDGE_PORT ?? 8424),
  workspace:
    process.env.OBS_BRIDGE_WORKSPACE ||
    path.join(process.env.APPDATA || scriptDir, "openBIMstudio", "navisworks-bridge", "jobs"),
  maxBodyBytes: Number(process.env.OBS_BRIDGE_MAX_BODY ?? 2 * 1024 * 1024 * 1024),
  programFilesRoot: process.env.OBS_BRIDGE_PROGRAM_FILES || "C:\\Program Files\\Autodesk",
  appData: process.env.OBS_BRIDGE_APPDATA || process.env.APPDATA || "",
  homeDir: process.env.OBS_BRIDGE_HOME || os.homedir(),
  pollMs: Number(process.env.OBS_BRIDGE_POLL_MS ?? 1500),
  noLaunch: process.env.OBS_BRIDGE_NO_LAUNCH === "1",
  maxActiveJobs: Number(process.env.OBS_BRIDGE_MAX_JOBS ?? 5),
  extraOrigins: String(process.env.OBS_BRIDGE_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

// Origin allow-list: local dev origins (any port) + extras from env/config file.
const originAllowlist = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://localhost:*",
  "https://127.0.0.1:*",
  ...cfg.extraOrigins,
];
try {
  const originFile = path.join(scriptDir, "obs-bridge-origins.json");
  const parsed = JSON.parse(fs.readFileSync(originFile, "utf8"));
  if (Array.isArray(parsed)) originAllowlist.push(...parsed.map(String));
} catch { /* optional file */ }

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------
function detectCapabilities() {
  let dirNames = [];
  try { dirNames = fs.readdirSync(cfg.programFilesRoot); } catch { dirNames = []; }
  const installs = findNavisworksInstalls(cfg.programFilesRoot, dirNames, (p) => fs.existsSync(p), path.join);
  const exporter = detectBimCamel({
    appData: cfg.appData,
    homeDir: cfg.homeDir,
    listDir: (p) => fs.readdirSync(p),
    exists: (p) => fs.existsSync(p),
    join: path.join,
  });
  return buildCapability({ installs, exporter });
}

let capabilities = detectCapabilities();

// ---------------------------------------------------------------------------
// Job store + watchers
// ---------------------------------------------------------------------------
const store = createJobStore();
const childProcesses = new Map(); // jobId -> child process (headless mode)

function jobDir(id) { return path.join(cfg.workspace, id); }
function sourceDir(id) { return path.join(jobDir(id), "source"); }
function exportDirOf(id) { return path.join(jobDir(id), "export"); }

function removeJobWorkspace(id) {
  try { fs.rmSync(jobDir(id), { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Advance one sweep: scan every open job's export folder for stable IFCs. */
function sweepExportFolders() {
  for (const job of store._jobs.values()) {
    if (job.state !== "waiting-for-export" && job.state !== "converting") continue;
    const scan = scanExportFolder(job.exportDir, { readdir: fs.readdirSync, stat: (p) => fs.statSync(p), join: path.join }, job._exportSeen);
    job._exportSeen = scan.stable;
    const stable = collectStableIfc(scan);
    if (stable.length > 0) {
      store.touch(job, { state: "done", ifcFiles: stable, message: `Collected ${stable.length} IFC file(s).` });
      const child = childProcesses.get(job.id);
      if (child && !child.killed) { try { child.kill(); } catch { /* exited already */ } }
    }
  }
}

/** Expire stale jobs and delete abandoned workspaces. */
function sweepExpiredJobs() {
  for (const id of store.sweep()) removeJobWorkspace(id);
  // Purge finished jobs (done/error/expired) that have been idle for 10 min.
  const t = Date.now();
  for (const job of store._jobs.values()) {
    if ((job.state === "done" || job.state === "error" || job.state === "expired") && t - job.updatedAt > 10 * 60 * 1000) {
      removeJobWorkspace(job.id);
      store.remove(job.id);
    }
  }
}

const watchTimer = setInterval(sweepExportFolders, Math.max(300, cfg.pollMs));
const ttlTimer = setInterval(sweepExpiredJobs, 60 * 1000);
watchTimer.unref?.(); ttlTimer.unref?.();

// ---------------------------------------------------------------------------
// Conversion starters
// ---------------------------------------------------------------------------
function startHeadless(job) {
  const base = job.sourceName.replace(/\.[^.]+$/, "");
  const outPath = path.join(job.exportDir, `${base}.ifc`);
  const args = [job.sourcePath, job.headlessPlugin, outPath, "16", "IFC4"];
  let child;
  try {
    child = spawn(job.headlessRunner, args, { stdio: "ignore", windowsHide: true });
  } catch (err) {
    store.touch(job, { state: "error", error: `headless runner could not start: ${err.message}` });
    return;
  }
  childProcesses.set(job.id, child);
  child.on("error", (err) => {
    store.touch(job, { state: "error", error: `headless runner failed: ${err.message}` });
  });
  child.on("exit", (code) => {
    childProcesses.delete(job.id);
    if (job.state === "done") return; // watcher already collected output
    if (code === 0) {
      // Give the watcher one sweep to pick the file up; if absent, fail.
      setTimeout(() => {
        if (job.state === "converting") {
          store.touch(job, { state: "error", error: "runner exited cleanly but produced no IFC" });
        }
      }, Math.max(1000, cfg.pollMs * 2));
    } else {
      store.touch(job, { state: "error", error: `headless runner exited with code ${code}` });
    }
  });
}

function startGuided(job, navExe) {
  if (cfg.noLaunch) {
    store.touch(job, { message: "Test mode: Navisworks launch skipped." });
    return;
  }
  try {
    const child = spawn(navExe, [job.sourcePath], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref?.();
  } catch (err) {
    store.touch(job, { state: "error", error: `could not launch Navisworks: ${err.message}` });
  }
}

function openJob(fileBuffer, sourceName) {
  const cap = capabilities;
  if (!cap.ready) return { error: "no conversion mode available on this machine" };
  const active = [...store._jobs.values()].filter((j) => j.state === "converting" || j.state === "waiting-for-export");
  if (active.length >= cfg.maxActiveJobs) return { error: "too many active jobs, try again shortly" };

  const id = Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
  const sDir = sourceDir(id);
  const eDir = exportDirOf(id);
  fs.mkdirSync(sDir, { recursive: true });
  fs.mkdirSync(eDir, { recursive: true });
  const sourcePath = path.join(sDir, sourceName);
  fs.writeFileSync(sourcePath, fileBuffer);

  const mode = cap.modes.includes("headless") ? "headless" : "guided";
  const nav = cap.navisworks[0] || null;
  const job = store.create({
    id,
    sourceName,
    sourceBytes: fileBuffer.length,
    mode,
    sourceDir: sDir,
    exportDir: eDir,
  });
  job.sourcePath = sourcePath;
  job.headlessRunner = cap.exporter.headlessRunner;
  job.headlessPlugin = cap.exporter.headlessPlugin;

  if (mode === "headless") {
    startHeadless(job);
  } else if (nav) {
    startGuided(job, nav.exePath);
  } else {
    store.touch(job, { state: "error", error: "Navisworks not found" });
  }
  return { job: store.view(job) };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const url = new URL(req.url || "/", "http://loopback");

  // Loopback Host guard (anti DNS-rebinding): reject everything else.
  if (!isLoopbackHost(req.headers.host)) {
    return void sendJson(res, 403, { ok: false, error: "forbidden host" });
  }

  // CORS preflight (incl. Private/Local Network Access for public pages).
  if (req.method === "OPTIONS") {
    const headers = preflightHeaders(
      origin,
      originAllowlist,
      req.headers["access-control-request-headers"],
    );
    if (!headers["Access-Control-Allow-Origin"]) {
      return void sendJson(res, 204, {}, {});
    }
    return void sendJson(res, 204, {}, headers);
  }

  const cors = corsHeaders(origin, originAllowlist);

  try {
    // ---------------- health ----------------
    if (req.method === "GET" && url.pathname === "/openbim-bridge/health") {
      capabilities = detectCapabilities(); // re-detect on every probe (cheap)
      return void sendJson(res, 200, {
        ok: true,
        service: "openbim-nwc-bridge",
        version: VERSION,
        platform: process.platform,
        workspace: cfg.workspace,
        maxBodyBytes: cfg.maxBodyBytes,
        ...capabilities,
      }, cors);
    }

    // ---------------- create job ----------------
    if (req.method === "POST" && url.pathname === "/openbim-bridge/jobs") {
      const safeName = sanitizeSourceFileName(req.headers["x-file-name"]);
      if (!safeName.ok) return void sendJson(res, 400, { ok: false, error: safeName.error }, cors);
      let body;
      try {
        body = await readBodyWithCap(req, cfg.maxBodyBytes);
      } catch (err) {
        const code = err && err.code === "BODY_TOO_LARGE" ? 413 : 400;
        return void sendJson(res, code, { ok: false, error: err.message }, cors);
      }
      if (!body || body.length === 0) return void sendJson(res, 400, { ok: false, error: "empty body" }, cors);
      const result = openJob(body, safeName.name);
      if (result.error) return void sendJson(res, 409, { ok: false, error: result.error }, cors);
      return void sendJson(res, 201, {
        ok: true,
        jobId: result.job.jobId,
        mode: result.job.mode,
        state: result.job.state,
        message: result.job.message,
        exportDir: result.job.exportDir,
        statusUrl: `/openbim-bridge/jobs/${result.job.jobId}`,
      }, cors);
    }

    // ---------------- job status ----------------
    const jobMatch = /^\/openbim-bridge\/jobs\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (req.method === "GET" && jobMatch) {
      const job = store.get(jobMatch[1]);
      if (!job) return void sendJson(res, 404, { ok: false, error: "unknown or expired job" }, cors);
      return void sendJson(res, 200, { ok: true, ...store.view(job) }, cors);
    }

    // ---------------- IFC download ----------------
    const ifcMatch = /^\/openbim-bridge\/jobs\/([A-Za-z0-9]+)\/ifc\/(.+)$/.exec(url.pathname);
    if (req.method === "GET" && ifcMatch) {
      const job = store.get(ifcMatch[1]);
      if (!job) return void sendJson(res, 404, { ok: false, error: "unknown or expired job" }, cors);
      const wanted = decodeURIComponent(ifcMatch[2]);
      const entry = (job.ifcFiles || []).find((f) => f.name === wanted);
      if (!entry) return void sendJson(res, 404, { ok: false, error: "no such IFC output" }, cors);
      const full = path.join(job.exportDir, entry.name);
      let bytes;
      try { bytes = fs.readFileSync(full); } catch {
        return void sendJson(res, 410, { ok: false, error: "IFC file disappeared from the workspace" }, cors);
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": bytes.length,
        "x-file-name": sanitizeIfcFileName(entry.name),
        ...cors,
      });
      res.end(bytes);
      return;
    }

    // ---------------- reveal export folder ----------------
    const revealMatch = /^\/openbim-bridge\/jobs\/([A-Za-z0-9]+)\/reveal$/.exec(url.pathname);
    if (req.method === "POST" && revealMatch) {
      const job = store.get(revealMatch[1]);
      if (!job) return void sendJson(res, 404, { ok: false, error: "unknown or expired job" }, cors);
      let opened = false;
      try {
        if (process.platform === "win32" && !cfg.noLaunch) {
          spawn("explorer.exe", [job.exportDir], { detached: true, stdio: "ignore" }).unref?.();
          opened = true;
        }
      } catch { opened = false; }
      return void sendJson(res, 200, { ok: true, opened, exportDir: job.exportDir }, cors);
    }

    // ---------------- cancel / cleanup ----------------
    const delMatch = /^\/openbim-bridge\/jobs\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && delMatch) {
      const id = delMatch[1];
      const child = childProcesses.get(id);
      if (child && !child.killed) { try { child.kill(); } catch { /* exited */ } }
      childProcesses.delete(id);
      removeJobWorkspace(id);
      store.remove(id);
      return void sendJson(res, 200, { ok: true, deleted: id }, cors);
    }

    return void sendJson(res, 404, { ok: false, error: "not found" }, cors);
  } catch (err) {
    return void sendJson(res, 500, { ok: false, error: err && err.message ? err.message : "internal error" }, cors);
  }
});

// Reject sockets that are not loopback peers (belt & braces on top of binding).
server.on("connection", (socket) => {
  const addr = socket.remoteAddress || "";
  if (!/^127\.|^::1$/.test(addr)) socket.destroy();
});

server.listen(cfg.port, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port;
  process.stdout.write(`${JSON.stringify({ event: "listening", port, health: `http://127.0.0.1:${port}/openbim-bridge/health` })}\n`);
  process.stderr.write(`[openbim-nwc-bridge] v${VERSION} listening on 127.0.0.1:${port}\n`);
  process.stderr.write(`[openbim-nwc-bridge] workspace: ${cfg.workspace}\n`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(watchTimer); clearInterval(ttlTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

export { server, store, cfg };
