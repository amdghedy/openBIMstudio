/**
 * DWG reader worker LIFECYCLE regression suite (G section of the A-H matrix).
 *
 * Complements tests/dwg-reader-isolation.test.cjs: that suite pins WHAT the
 * worker returns; this suite pins HOW the worker boundary behaves over time —
 * using the real compiled worker code, a real worker thread (Node
 * worker_threads standing in for the browser Worker) and the real LibreDWG
 * wasm.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const assert = require("assert");
const { Worker } = require("worker_threads");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); } };
const tAsync = async (name, fn) => { try { await fn(); pass++; console.log("  PASS " + name); } catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const FIXTURES = path.join(__dirname, "fixtures");

// Compile inside the repository so Node can resolve ROOT/node_modules normally.
// The old harness created a Windows junction to node_modules; that can fail
// with EPERM and is unnecessary when the temp output is below the repo root.
const OUT = fs.mkdtempSync(path.join(ROOT, ".dwg-lifecycle-"));
fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify({ type: "module" }));
execSync(
  `npx tsc src/modules/cad-link/dwg-reader-worker.ts src/modules/cad-link/dwg-parse-core.ts` +
  ` src/modules/cad-link/dwg-reader-protocol.ts` +
  ` --outDir ${OUT} --module es2020 --target es2020 --moduleResolution node --skipLibCheck --esModuleInterop`,
  { cwd: ROOT, stdio: "inherit" },
);
const addJsExt = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) addJsExt(p);
    else if (e.name.endsWith(".js")) {
      const src = fs.readFileSync(p, "utf8");
      const fixed = src.replace(/(from\s*"(\.\.?\/[^"*]+))"/g, (m, a, spec) => spec.endsWith(".js") ? m : `${a}.js"`);
      if (fixed !== src) fs.writeFileSync(p, fixed);
    }
  }
};
addJsExt(OUT);
const findFile = (d, n) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { const r = findFile(p, n); if (r) return r; }
    else if (e.name === n) return p;
  }
  return null;
};
const workerJs = findFile(OUT, "dwg-reader-worker.js");
assert.ok(workerJs, "compiled dwg-reader-worker.js not found");

// Node 24 on Windows requires file:// URLs for dynamic ESM imports.
const workerUrl = pathToFileURL(workerJs).href;
const WRAPPER = path.join(OUT, "node-worker-wrapper.mjs");
fs.writeFileSync(WRAPPER, [
  `import { parentPort } from "node:worker_threads";`,
  `globalThis.self = {`,
  `  addEventListener: (_type, cb) => parentPort.on("message", (v) => cb({ data: v })),`,
  `  postMessage: (msg) => parentPort.postMessage(msg),`,
  `};`,
  `await import(${JSON.stringify(workerUrl)});`,
].join("\n"));

function spawnReader() {
  const worker = new Worker(WRAPPER);
  const waiters = new Map();
  let nextId = 0;
  worker.on("message", (res) => { const w = waiters.get(res && res.id); if (w) { waiters.delete(res.id); w(res); } });
  const next = (bytes, fileName, id = ++nextId) => new Promise((resolve, reject) => {
    waiters.set(id, resolve);
    worker.postMessage({ id, kind: "parse", bytes, fileName });
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error("timeout waiting for response id=" + id)); } }, 90_000);
  });
  return { worker, next };
}

const fixtureBuffer = (name) => { const b = fs.readFileSync(path.join(FIXTURES, name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

(async () => {
  console.log("=== G1. Success response contract (real worker + real wasm) ===");
  const { worker, next } = spawnReader();
  await tAsync("parse response carries ok/doc/summary/version/entityCount", async () => {
    const res = await next(fixtureBuffer("sample_2000.dwg"), "sample_2000.dwg");
    assert.strictEqual(res.ok, true); assert.strictEqual(res.version, "AC1015");
    assert.ok(typeof res.summary === "string" && res.summary.length > 0);
    assert.ok(typeof res.entityCount === "number" && res.entityCount >= 6);
    assert.ok(Array.isArray(res.doc?.entities) && res.doc.entities.length === res.entityCount);
    assert.ok(Array.isArray(res.doc?.layers) && res.doc.layers.length >= 1);
  });
  console.log("=== G2. Concurrent requests are demuxed by id ===");
  await tAsync("two in-flight parses resolve to the right ids/files", async () => {
    const [r1, r2] = await Promise.all([next(fixtureBuffer("sample_2000.dwg"), "sample_2000.dwg"), next(fixtureBuffer("sample_2018.dwg"), "sample_2018.dwg")]);
    assert.strictEqual(r1.version, "AC1015"); assert.strictEqual(r2.version, "AC1032");
    assert.ok(typeof r1.entityCount === "number"); assert.ok(typeof r2.entityCount === "number");
  });
  console.log("=== G3. Failure leaves the worker usable (retry on SAME worker) ===");
  await tAsync("garbage -> structured invalid-file, then a valid parse still succeeds", async () => {
    const bad = await next(new TextEncoder().encode("NOT_A_DWG_AT_ALL").buffer, "garbage.dwg");
    assert.strictEqual(bad.ok, false); assert.strictEqual(bad.code, "invalid-file"); assert.ok(/not a DWG file/.test(bad.message));
    const good = await next(fixtureBuffer("r11_entities_2d.dwg"), "r11_entities_2d.dwg");
    assert.strictEqual(good.ok, true); assert.strictEqual(good.version, "AC1009"); assert.ok(good.entityCount >= 1);
  });
  console.log("=== G4. Malformed messages are ignored, worker survives ===");
  await tAsync("null / wrong-kind / missing-id messages do not crash the worker", async () => {
    worker.postMessage(null);
    worker.postMessage({ kind: "parse", bytes: fixtureBuffer("sample_2000.dwg"), fileName: "no-id.dwg" });
    worker.postMessage({ id: 999, kind: "unknown-kind", bytes: new ArrayBuffer(8), fileName: "x.dwg" });
    const res = await next(fixtureBuffer("sample_2018.dwg"), "sample_2018.dwg");
    assert.strictEqual(res.ok, true); assert.strictEqual(res.version, "AC1032");
  });
  await worker.terminate();
  console.log("=== G5. Main-thread client lifecycle guards (static) ===");
  t("readDwg client keeps timeout-cancel-by-terminate", () => {
    const src = read("src/modules/cad-link/index.ts");
    assert.ok(/DWG_PARSE_TIMEOUT_MS\s*=\s*120_000/.test(src)); assert.ok(src.includes("resetReaderWorker()")); assert.ok(/pendingParses\.delete\(id\)/.test(src));
  });
  t("client resets on crash and malformed responses", () => {
    const src = read("src/modules/cad-link/index.ts");
    assert.ok(src.includes('addEventListener("error"')); assert.ok(src.includes('addEventListener("messageerror"'));
    const errIdx = src.indexOf('addEventListener("error"'); assert.ok(src.indexOf("resetReaderWorker()", errIdx) !== -1);
  });
  t("no main-thread fallback that would run the reader under the strict CSP", () => {
    const src = read("src/modules/cad-link/index.ts");
    assert.ok(!src.includes("@mlightcad/libredwg-web")); assert.ok(src.includes("type: \"module\"") || src.includes("type: 'module'"));
  });
  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
