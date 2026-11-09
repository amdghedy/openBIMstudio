/**
 * NWC → IFC local bridge tests (tools/navisworks-bridge).
 *
 * Two layers:
 *  1. pure-logic units: http-utils (loopback/CORS/name sanitizing), detect
 *     (Navisworks + BIMCamel detection), job-store (states, TTL, export scan)
 *  2. end-to-end: the REAL bridge process is spawned against a fake machine
 *     layout (fake Navisworks install tree, fake plugin folders, a scripted
 *     fake headless runner). The test itself plays the role of
 *     "Navisworks + user" writing the IFC into the watched export folder.
 *
 * Runs anywhere Node runs (no Windows, no Navisworks needed).
 */
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const BRIDGE = path.join(root, "tools", "navisworks-bridge", "openbim-nwc-bridge.mjs");
const LIB = path.join(root, "tools", "navisworks-bridge", "lib");

let passCount = 0;
let failCount = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passCount++; console.log("  PASS", name); }
  catch (e) {
    failCount++; failures.push(name);
    console.log("  FAIL", name, "-", (e && e.message) || e);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEq(a[k], b[k]));
}
function assertEq(actual, expected, msg) {
  if (!deepEq(actual, expected)) throw new Error(`${msg || "eq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const FAKE_IFC = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nEND-ISO-10303-21;\n";

function rawRequest(port, method, reqPath, { headers = {}, body = null, host = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers: host ? { ...headers, Host: host } : headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString("utf8")); } catch { /* binary */ }
          resolve({ status: res.statusCode, headers: res.headers, json, bytes: buf });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function startBridge(envExtra) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, ...envExtra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("bridge did not listen in time")), 8000);
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      const m = /"event":"listening","port":(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`bridge exited early (code ${code})`)); });
    child.stderr.on("data", () => { /* logs */ });
  });
  return { child, started };
}

async function waitHealthy(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await rawRequest(port, "GET", "/openbim-bridge/health");
      if (res.status === 200 && res.json && res.json.ok) return res.json;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("bridge never became healthy");
}

async function pollJob(port, jobId, wantStates, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await rawRequest(port, "GET", `/openbim-bridge/jobs/${jobId}`);
    if (res.status === 200 && res.json && wantStates.includes(res.json.state)) return res.json;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`job never reached ${wantStates.join("|")} within ${timeoutMs}ms`);
}

/** Build a fake Windows-like machine layout in a temp dir. */
function makeMachine() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "obs-nwc-bridge-"));
  const autodesk = path.join(base, "Program Files", "Autodesk");
  fs.mkdirSync(path.join(autodesk, "Navisworks Manage 2025"), { recursive: true });
  fs.writeFileSync(path.join(autodesk, "Navisworks Manage 2025", "Navisworks.exe"), "");
  fs.mkdirSync(path.join(autodesk, "Navisworks Simulate 2024"), { recursive: true });
  fs.writeFileSync(path.join(autodesk, "Navisworks Simulate 2024", "Navisworks.exe"), "");
  const appdata = path.join(base, "AppData");
  fs.mkdirSync(path.join(appdata, "Autodesk", "ApplicationPlugins", "BIMCamel-ifc-exporter-navisworks"), { recursive: true });
  const workspace = path.join(base, "jobs");
  return { base, autodesk, appdata, workspace };
}

function makeHeadlessHarness(machine) {
  const runnerDir = path.join(machine.base, "home", "bimcamel-ifc-exporter", "out", "runner");
  const harnessDir = path.join(machine.base, "home", "bimcamel-ifc-exporter", "out", "harness");
  fs.mkdirSync(runnerDir, { recursive: true });
  fs.mkdirSync(harnessDir, { recursive: true });
  const runner = path.join(runnerDir, "BIMCamelHeadlessRunner.exe");
  // Fake runner: args are <input> <plugin.dll> <out.ifc> <merge> <schema>;
  // after a short "conversion" it writes a valid STEP skeleton to $3.
  fs.writeFileSync(runner, "#!/bin/sh\nsleep 0.3\nprintf 'ISO-10303-21;\\nEND-ISO-10303-21;\\n' > \"$3\"\n");
  fs.chmodSync(runner, 0o755);
  fs.writeFileSync(path.join(harnessDir, "BIMCamelHeadlessExport.dll"), "fake plugin");
}

/* ------------------------------------------------------------------ */
/* 1. pure logic: http-utils                                           */
/* ------------------------------------------------------------------ */

async function testHttpUtils() {
  const hu = await import(`file://${path.join(LIB, "http-utils.mjs").replace(/\\/g, "/")}`);
  await t("http-utils: loopback host parsing", () => {
    assert(hu.isLoopbackHost("127.0.0.1:8424"), "127.0.0.1 with port");
    assert(hu.isLoopbackHost("localhost:5173"), "localhost with port");
    assert(hu.isLoopbackHost("[::1]:8424"), "ipv6 loopback");
    assert(!hu.isLoopbackHost("attacker.example:8424"), "foreign host");
    assert(!hu.isLoopbackHost(""), "empty host");
    assertEq(hu.hostWithoutPort("[::1]:8424"), "::1", "ipv6 strip");
    assertEq(hu.hostWithoutPort("localhost:5173"), "localhost", "v4 strip");
  });
  await t("http-utils: origin allow-list (exact and :* entries)", () => {
    const list = ["http://localhost:*", "https://myapp.example", "http://127.0.0.1:*"];
    assert(hu.originAllowed("http://localhost:5173", list), "dev port via star");
    assert(hu.originAllowed("http://127.0.0.1:3000", list), "loopback via star");
    assert(hu.originAllowed("https://myapp.example", list), "exact");
    assert(!hu.originAllowed("https://myapp.example:8443", list), "exact entry is port-locked");
    assert(!hu.originAllowed("https://evil.example", list), "foreign origin");
    assert(!hu.originAllowed("", list), "empty origin");
    assert(!hu.originAllowed("null", list), "null origin string");
  });
  await t("http-utils: preflight announces private/local network permission", () => {
    const h = hu.preflightHeaders("http://localhost:5173", ["http://localhost:*"], "x-file-name, content-type");
    assertEq(h["Access-Control-Allow-Origin"], "http://localhost:5173", "ACAO");
    assertEq(h["Access-Control-Allow-Private-Network"], "true", "PNA");
    assertEq(h["Access-Control-Allow-Local-Network"], "true", "LNA");
    assert(/x-file-name/i.test(h["Access-Control-Allow-Headers"]), "echo requested headers");
    const denied = hu.preflightHeaders("https://evil.example", ["http://localhost:*"], "");
    assert(!denied["Access-Control-Allow-Origin"], "no ACAO for foreign origin");
  });
  await t("http-utils: source file name sanitizing", () => {
    const ok = hu.sanitizeSourceFileName("..\\..\\..\\windows\\system32\\evil.nwc");
    assert(ok.ok, "nwc basename accepted");
    assert(!ok.name.includes("..") && !ok.name.includes("\\"), "traversal stripped");
    assertEq(hu.sanitizeSourceFileName("../../../evil.exe").ok, false, "exe rejected");
    assertEq(hu.sanitizeSourceFileName("model.dwg").ok, false, "dwg rejected (server handles it)");
    assertEq(hu.sanitizeSourceFileName("").ok, false, "empty rejected");
    const weird = hu.sanitizeSourceFileName("tower\x01\x02 final.nwd");
    assert(weird.ok && !/[\x01\x02]/.test(weird.name), "control chars stripped");
    const deep = hu.sanitizeSourceFileName("a/b/c/model.nwf");
    assert(deep.ok && deep.name === "model.nwf", "basename only");
  });
  await t("http-utils: ifc name sanitizing + state descriptions", () => {
    assertEq(hu.sanitizeIfcFileName("a\\b\\out.ifc"), "out.ifc", "basename");
    assertEq(hu.sanitizeIfcFileName(""), "model.ifc", "fallback");
    assertEq(hu.describeJobState("done"), "Conversion finished.", "done default");
    assertEq(hu.describeJobState("error", "boom"), "boom", "custom message");
  });
}

/* ------------------------------------------------------------------ */
/* 2. pure logic: detect                                               */
/* ------------------------------------------------------------------ */

async function testDetect() {
  const det = await import(`file://${path.join(LIB, "detect.mjs").replace(/\\/g, "/")}`);
  await t("detect: Navisworks dir classification", () => {
    assertEq(det.classifyNavisworksDir("Navisworks Manage 2025"), { sku: "Manage", year: 2025 }, "manage");
    assertEq(det.classifyNavisworksDir("Navisworks Simulate 2024"), { sku: "Simulate", year: 2024 }, "simulate");
    assertEq(det.classifyNavisworksDir("Navisworks Freedom 2025"), null, "freedom excluded");
    assertEq(det.classifyNavisworksDir("Navisworks Manage 2019"), { sku: "Manage", year: 2019 }, "old year still classified");
    assertEq(det.classifyNavisworksDir("RVT 2025"), null, "other product");
  });
  await t("detect: install scan newest-first, exe required", () => {
    const joinPosix = (a, b) => (a ? `${a}/${b}` : b);
    const installs = det.findNavisworksInstalls(
      "C:/Program Files/Autodesk",
      ["Navisworks Manage 2025", "Navisworks Simulate 2024", "RVT 2025", "Navisworks Manage 2023"],
      (p) => !p.includes("2023"), // 2023 lacks the exe
      joinPosix,
    );
    assertEq(installs.length, 2, "two installs");
    assertEq(installs[0].year, 2025, "newest first");
    assertEq(installs[1].year, 2024, "second");
    assertEq(installs[0].exePath, "C:/Program Files/Autodesk/Navisworks Manage 2025/Navisworks.exe", "exe path");
  });
  await t("detect: BIMCamel plug-in and headless harness discovery", () => {
    const joinPosix = (a, b) => (a ? `${a}/${b}` : b);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "obs-detect-"));
    const appData = path.join(base, "appdata");
    const home = path.join(base, "home");
    fs.mkdirSync(path.join(appData, "Autodesk", "ApplicationPlugins", "BIMCamel-thing"), { recursive: true });
    const noHarness = det.detectBimCamel({
      appData, homeDir: home,
      listDir: (p) => fs.readdirSync(p), exists: (p) => fs.existsSync(p), join: joinPosix,
    });
    assert(noHarness.pluginInstalled, "plugin seen");
    assertEq(noHarness.mode, "guided", "guided mode with plugin only");
    assertEq(noHarness.headlessRunner, null, "no harness yet");

    fs.mkdirSync(path.join(home, "bimcamel-ifc-exporter", "out", "runner"), { recursive: true });
    fs.mkdirSync(path.join(home, "bimcamel-ifc-exporter", "out", "harness"), { recursive: true });
    fs.writeFileSync(path.join(home, "bimcamel-ifc-exporter", "out", "runner", "BIMCamelHeadlessRunner.exe"), "");
    fs.writeFileSync(path.join(home, "bimcamel-ifc-exporter", "out", "harness", "BIMCamelHeadlessExport.dll"), "");
    const withHarness = det.detectBimCamel({
      appData, homeDir: home,
      listDir: (p) => fs.readdirSync(p), exists: (p) => fs.existsSync(p), join: joinPosix,
    });
    assert(withHarness.headlessRunner && withHarness.headlessPlugin, "harness found");
    assertEq(withHarness.mode, "headless", "headless wins when harness exists");
  });
  await t("detect: capability summary", () => {
    const none = det.buildCapability({ installs: [], exporter: { pluginInstalled: false, pluginDirs: [], mode: null } });
    assertEq(none.ready, false, "nothing installed");
    assertEq(none.modes.length, 0, "no modes");
    const guided = det.buildCapability({
      installs: [{ sku: "Manage", year: 2025, exePath: "x" }],
      exporter: { pluginInstalled: true, pluginDirs: ["d"], mode: "guided" },
    });
    assertEq(guided.ready, true, "guided ready");
    assertEq(guided.modes.join(","), "guided", "mode list");
  });
}

/* ------------------------------------------------------------------ */
/* 3. pure logic: job store                                            */
/* ------------------------------------------------------------------ */

async function testJobStore() {
  const js = await import(`file://${path.join(LIB, "job-store.mjs").replace(/\\/g, "/")}`);
  await t("job-store: initial states and view shape", () => {
    const store = js.createJobStore();
    const a = store.create({ id: "aaa", sourceName: "x.nwc", sourceBytes: 3, mode: "guided", sourceDir: "s", exportDir: "e" });
    assertEq(a.state, "waiting-for-export", "guided starts waiting");
    const b = store.create({ id: "bbb", sourceName: "y.nwc", sourceBytes: 3, mode: "headless", sourceDir: "s", exportDir: "e" });
    assertEq(b.state, "converting", "headless starts converting");
    const view = store.view(store.get("aaa"));
    assertEq(view.jobId, "aaa", "view id");
    assertEq(view.mode, "guided", "view mode");
    assert(typeof view.message === "string" && view.message.length > 0, "message present");
  });
  await t("job-store: TTL sweep expires only open jobs", () => {
    let clock = 1000;
    const store = js.createJobStore({ ttlMs: 5000, now: () => clock });
    store.create({ id: "a", sourceName: "x.nwc", sourceBytes: 1, mode: "guided", sourceDir: "s", exportDir: "e" });
    store.create({ id: "b", sourceName: "y.nwc", sourceBytes: 1, mode: "guided", sourceDir: "s", exportDir: "e" });
    store.touch(store.get("b"), { state: "done", ifcFiles: [{ name: "out.ifc", sizeBytes: 9 }] });
    clock += 6000;
    const expired = store.sweep();
    assertEq(expired.join(","), "a", "only the open job expires");
    assertEq(store.get("a").state, "expired", "expired state");
    assertEq(store.get("b").state, "done", "done survives");
  });
  await t("job-store: export folder scan needs two equal-size sweeps", () => {
    const joinPosix = (a, b) => `${a}/${b}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-export-"));
    const fsApi = { readdir: fs.readdirSync, stat: fs.statSync, join: joinPosix };
    const first = js.scanExportFolder(dir, fsApi);
    assertEq(first.files.length, 0, "empty folder");
    const ifcPath = joinPosix(dir, "model.ifc");
    fs.writeFileSync(ifcPath, "abc");
    const s1 = js.scanExportFolder(dir, fsApi);
    assertEq(s1.files[0].stable, false, "first sight not stable");
    const s2 = js.scanExportFolder(dir, fsApi, s1.stable);
    assertEq(s2.files[0].stable, true, "same size again → stable");
    fs.writeFileSync(ifcPath, "abcd");
    const s3 = js.scanExportFolder(dir, fsApi, s2.stable);
    assertEq(s3.files[0].stable, false, "size changed → not stable");
    const s4 = js.scanExportFolder(dir, fsApi, s3.stable);
    assertEq(s4.files[0].stable, true, "settles again");
    assertEq(js.collectStableIfc(s4).length, 1, "collected");
    fs.writeFileSync(joinPosix(dir, "notes.txt"), "ignore me");
    const s5 = js.scanExportFolder(dir, fsApi, s4.stable);
    assertEq(s5.files.length, 1, "non-ifc ignored");
    assertEq(js.collectStableIfc(s1).length, 0, "unstable not collected");
  });
}

/* ------------------------------------------------------------------ */
/* 4. end-to-end: guided mode                                          */
/* ------------------------------------------------------------------ */

async function testGuidedEndToEnd() {
  const machine = makeMachine();
  const { child, started } = startBridge({
    OBS_BRIDGE_PROGRAM_FILES: machine.autodesk,
    OBS_BRIDGE_APPDATA: machine.appdata,
    OBS_BRIDGE_WORKSPACE: machine.workspace,
    OBS_BRIDGE_NO_LAUNCH: "1",
    OBS_BRIDGE_POLL_MS: "150",
    OBS_BRIDGE_ORIGINS: "https://myapp.example",
  });
  try {
    const port = await started;
    const health = await waitHealthy(port);
    await t("e2e guided: health reports guided readiness", () => {
      assertEq(health.service, "openbim-nwc-bridge", "service marker");
      assertEq(health.ready, true, "ready");
      assertEq(health.modes.join(","), "guided", "guided only");
      assertEq(health.navisworks[0].sku, "Manage", "sku");
      assertEq(health.navisworks[0].year, 2025, "year");
      assertEq(health.exporter.pluginInstalled, true, "plugin detected");
    });

    await t("e2e guided: foreign Host header is rejected", async () => {
      const res = await rawRequest(port, "GET", "/openbim-bridge/health", { host: "attacker.example" });
      assertEq(res.status, 403, "403 for non-loopback host");
    });

    await t("e2e guided: CORS preflight for allowed and foreign origins", async () => {
      const allowed = await rawRequest(port, "OPTIONS", "/openbim-bridge/jobs", {
        headers: { Origin: "https://myapp.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-file-name" },
      });
      assertEq(allowed.status, 204, "preflight status");
      assertEq(allowed.headers["access-control-allow-origin"], "https://myapp.example", "ACAO echo");
      assertEq(allowed.headers["access-control-allow-private-network"], "true", "PNA permitted");
      const foreign = await rawRequest(port, "OPTIONS", "/openbim-bridge/jobs", {
        headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
      });
      assert(!foreign.headers["access-control-allow-origin"], "no ACAO for foreign origin");
    });

    await t("e2e guided: path-traversal and extension gates", async () => {
      const bad = await rawRequest(port, "POST", "/openbim-bridge/jobs", {
        headers: { "x-file-name": "..\\..\\evil.exe" }, body: Buffer.from("x"),
      });
      assertEq(bad.status, 400, "traversal/exe rejected");
      const wrongExt = await rawRequest(port, "POST", "/openbim-bridge/jobs", {
        headers: { "x-file-name": "model.rvt" }, body: Buffer.from("x"),
      });
      assertEq(wrongExt.status, 400, "rvt rejected by bridge (server/APS handles rvt)");
    });

    let jobId = "";
    let exportDir = "";
    await t("e2e guided: job creation stores the source and announces the export folder", async () => {
      const res = await rawRequest(port, "POST", "/openbim-bridge/jobs", {
        headers: { "x-file-name": "tower final.nwc" }, body: Buffer.from("FAKE-NWC-BYTES"),
      });
      assertEq(res.status, 201, "created");
      assertEq(res.json.mode, "guided", "guided mode");
      jobId = res.json.jobId;
      exportDir = res.json.exportDir;
      assert(fs.existsSync(path.join(machine.workspace, jobId, "source", "tower final.nwc")), "source saved");
      assert(fs.existsSync(exportDir), "export folder exists");
    });

    await t("e2e guided: reveal reports the folder (no spawn in test mode)", async () => {
      const res = await rawRequest(port, "POST", `/openbim-bridge/jobs/${jobId}/reveal`, {});
      assertEq(res.status, 200, "reveal ok");
      assertEq(res.json.opened, false, "no explorer under NO_LAUNCH");
      assertEq(res.json.exportDir, exportDir, "same folder");
    });

    await t("e2e guided: IFC written by 'Navisworks' is detected once stable and served back", async () => {
      assertEq((await pollJob(port, jobId, ["waiting-for-export"], 4000)).state, "waiting-for-export", "starts waiting");
      fs.writeFileSync(path.join(exportDir, "tower final.ifc"), FAKE_IFC);
      const done = await pollJob(port, jobId, ["done"], 8000);
      assertEq(done.ifcFiles.length, 1, "one IFC collected");
      assertEq(done.ifcFiles[0].name, "tower final.ifc", "file name");
      const dl = await rawRequest(port, "GET", `/openbim-bridge/jobs/${jobId}/ifc/${encodeURIComponent("tower final.ifc")}`);
      assertEq(dl.status, 200, "download ok");
      assertEq(dl.bytes.toString("utf8"), FAKE_IFC, "byte-exact");
      assertEq(dl.headers["x-file-name"], "tower final.ifc", "download name header");
    });

    await t("e2e guided: half-written IFC is never served", async () => {
      const job2 = await rawRequest(port, "POST", "/openbim-bridge/jobs", {
        headers: { "x-file-name": "half.nwc" }, body: Buffer.from("FAKE-NWC-BYTES-2"),
      });
      const jid = job2.json.jobId;
      const exp = job2.json.exportDir;
      fs.writeFileSync(path.join(exp, "half.ifc"), "ISO-10303-21;");
      await new Promise((r) => setTimeout(r, 500)); // one sweep sees it, size then changes
      fs.writeFileSync(path.join(exp, "half.ifc"), "ISO-10303-21; more bytes arriving");
      const soon = await rawRequest(port, "GET", `/openbim-bridge/jobs/${jid}`);
      if (soon.json.state === "done") {
        // only acceptable if the FINAL size was stable for two sweeps
        const listed = soon.json.ifcFiles[0];
        const size = fs.statSync(path.join(exp, "half.ifc")).size;
        assertEq(listed.sizeBytes, size, "collected size matches final size");
      }
      await rawRequest(port, "DELETE", `/openbim-bridge/jobs/${jid}`);
    });

    await t("e2e guided: DELETE cancels and cleans the workspace", async () => {
      const del = await rawRequest(port, "DELETE", `/openbim-bridge/jobs/${jobId}`);
      assertEq(del.status, 200, "delete ok");
      const after = await rawRequest(port, "GET", `/openbim-bridge/jobs/${jobId}`);
      assertEq(after.status, 404, "job gone");
      assert(!fs.existsSync(path.join(machine.workspace, jobId)), "workspace removed");
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    try { fs.rmSync(machine.base, { recursive: true, force: true }); } catch { /* windows tmp */ }
  }
}

/* ------------------------------------------------------------------ */
/* 5. end-to-end: headless mode + body cap                             */
/* ------------------------------------------------------------------ */

async function testHeadlessEndToEnd() {
  const machine = makeMachine();
  makeHeadlessHarness(machine);
  const { child, started } = startBridge({
    OBS_BRIDGE_PROGRAM_FILES: machine.autodesk,
    OBS_BRIDGE_APPDATA: machine.appdata,
    OBS_BRIDGE_WORKSPACE: machine.workspace,
    OBS_BRIDGE_HOME: path.join(machine.base, "home"),
    OBS_BRIDGE_NO_LAUNCH: "1",
    OBS_BRIDGE_POLL_MS: "150",
    OBS_BRIDGE_MAX_BODY: "200",
  });
  try {
    const port = await started;
    const health = await waitHealthy(port);
    await t("e2e headless: harness detected, headless preferred", () => {
      assertEq(health.modes.includes("headless"), true, "headless mode offered");
      assertEq(health.exporter.headlessRunner !== null, true, "runner path");
    });

    await t("e2e headless: body cap enforced (413)", async () => {
      const res = await rawRequest(port, "POST", "/openbim-bridge/jobs", {
        headers: { "x-file-name": "big.nwc" }, body: Buffer.alloc(300, 7),
      });
      assertEq(res.status, 413, "over cap");
    });

    let jobId = "";
    await t("e2e headless: runner executes and its IFC comes back — zero clicks", async () => {
      const res = await rawRequest(port, "POST", "/openbim-bridge/jobs", {
        headers: { "x-file-name": "building.nwf" }, body: Buffer.from("FAKE-NWF-BYTES"),
      });
      assertEq(res.status, 201, "created");
      assertEq(res.json.mode, "headless", "headless chosen");
      jobId = res.json.jobId;
      assertEq((await rawRequest(port, "GET", `/openbim-bridge/jobs/${jobId}`)).json.state, "converting", "converting state");
      const done = await pollJob(port, jobId, ["done", "error"], 10000);
      assertEq(done.state, "done", "fake runner finished");
      assertEq(done.ifcFiles[0].name, "building.ifc", "output name derived from source");
      const dl = await rawRequest(port, "GET", done.ifcFiles[0].url);
      assert(/ISO-10303-21;/.test(dl.bytes.toString("utf8")), "STEP content");
      await rawRequest(port, "DELETE", `/openbim-bridge/jobs/${jobId}`);
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    try { fs.rmSync(machine.base, { recursive: true, force: true }); } catch { /* windows tmp */ }
  }
}

/* ------------------------------------------------------------------ */
/* runner                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  console.log("nwc-bridge: pure logic");
  await testHttpUtils();
  await testDetect();
  await testJobStore();
  console.log("nwc-bridge: end-to-end (real bridge process)");
  await testGuidedEndToEnd();
  await testHeadlessEndToEnd();
  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.log("failed:", failures.join(" | "));
    process.exit(1);
  }
  process.exit(0);
})();
