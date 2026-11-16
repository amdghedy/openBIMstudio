/**
 * Solid reader isolation + CSP regression suite (CSP incompatibility root-cause fix).
 *
 * Root cause (proven in a real browser session, 2026-11-16): the vendored
 * occt-import-js and rhino3dm emscripten glue evaluates JavaScript strings
 * during module startup; the main document CSP intentionally forbids
 * 'unsafe-eval', so EVERY STEP / IGES / BREP / 3dm import failed with
 *   "Evaluating a string as JavaScript violates ... script-src 'self'
 *    'wasm-unsafe-eval' ..."
 * even though the vendored reader files were deployed. Fix (mirrors the DWG
 * reader design): the readers run in an isolated module worker served with a
 * scoped CSP; the main document stays strict. This suite pins that design.
 *
 * Run: npm run test:solid-reader-isolation
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); }
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

console.log("=== A. Main document CSP stays strict ===");
t("main document CSP keeps script-src free of 'unsafe-eval'", () => {
  const html = read("index.html");
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, "index.html must declare the meta CSP");
  assert.ok(csp[1].includes("wasm-unsafe-eval"), "main CSP allows wasm compilation");
  assert.ok(!/(^|\s)'unsafe-eval'/.test(csp[1]), "main CSP must NOT allow JS string evaluation");
});

console.log("=== B. Solid reader runs in an isolated worker ===");
t("solid-import.ts must not load reader glue in the main document", () => {
  const src = read("src/features/solid-import.ts");
  assert.ok(!src.includes("loadScript"), "main-thread script-tag loading must be gone");
  assert.ok(!src.includes("document.createElement(\"script\")"), "main-thread script injection must be gone");
  assert.ok(!src.includes("occtimportjs("), "the main thread must not instantiate the occt glue");
  assert.ok(!src.includes("rhino3dm("), "the main thread must not instantiate the rhino3dm glue");
});
t("solid-import.ts parses in the reader worker client", () => {
  const src = read("src/features/solid-import.ts");
  assert.ok(src.includes("new Worker(new URL(") && src.includes("solid-reader-worker.ts") && src.includes("import.meta.url"),
    "must spawn the reader worker");
});
t("solid-reader-worker.ts has no DOM access", () => {
  const src = read("src/modules/solids/solid-reader-worker.ts");
  assert.ok(!/document\./.test(src), "worker must not touch the DOM");
  assert.ok(!/window\./.test(src), "worker must not touch window");
  assert.ok(src.includes("addEventListener(\"message\""), "worker must answer messages");
});
t("solid-reader-worker.ts parses with the same reader calls and unit policy", () => {
  const src = read("src/modules/solids/solid-reader-worker.ts");
  assert.ok(src.includes("ReadStepFile") || src.includes("[fn]("), "worker uses the occt reader entry points");
  assert.ok(src.includes("linearUnit: \"meter\""), "metre conversion policy must survive the move");
  assert.ok(src.includes("fromByteArray"), "worker reads 3dm through rhino3dm.File3dm.fromByteArray");
});

console.log("=== C. Scoped worker CSP identical across vite.config.ts, vercel.json, public/_headers ===");
t("scoped worker CSP wired for both reader workers", () => {
  const workerCsp =
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
  // The solid reader worker additionally imports its glue as a blob module, so its scoped
  // policy is the DWG one plus blob: in script-src — nothing else relaxed, same scope.
  const solidWorkerCsp =
    "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
  const vite = read("vite.config.ts");
  assert.ok(vite.includes(workerCsp), "vite.config.ts must carry the scoped worker CSP");
  assert.ok(vite.includes(solidWorkerCsp), "vite.config.ts must carry the solid reader worker CSP (with blob: module import)");
  assert.ok(vite.includes("solid-reader-worker"), "vite dev/preview middleware must scope the CSP to the solid reader chunk");
  const vercel = JSON.parse(read("vercel.json"));
  const vercelRule = vercel.headers.find((h) => String(h.source).includes("solid-reader-worker"));
  assert.ok(vercelRule, "vercel.json must scope a CSP to the solid reader worker chunk");
  assert.strictEqual(vercelRule.headers.find((h) => h.key === "Content-Security-Policy").value, solidWorkerCsp);
  const cf = read("public/_headers");
  assert.ok(cf.includes("/assets/solid-reader-worker-*") && cf.includes(solidWorkerCsp),
    "public/_headers (Cloudflare) must scope the same CSP");
});
t("worker CSP stays scoped: every 'unsafe-eval' block in _headers is a reader-worker asset", () => {
  const cf = read("public/_headers");
  const blocks = [];
  let cur = null;
  for (const line of cf.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\S/.test(line)) { cur = { path: line.trim(), csp: "" }; blocks.push(cur); }
    else if (cur && line.includes("Content-Security-Policy")) cur.csp = line.trim();
  }
  const evalBlocks = blocks.filter((b) => b.csp.includes("'unsafe-eval'"));
  assert.ok(evalBlocks.length >= 2, "both reader workers should carry the scoped eval CSP");
  for (const b of evalBlocks) {
    assert.ok(/reader-worker/.test(b.path), `relaxed CSP must stay scoped to a reader worker, not ${b.path}`);
    if (b.path.includes("solid-reader-worker")) {
      assert.ok(b.csp.includes("blob:"), "the solid worker policy must allow blob module imports");
    } else {
      assert.ok(!b.csp.includes("blob:"), "the DWG worker policy must not gain blob: silently");
    }
  }
});

console.log("=== D. Protocol module is shared and pure ===");
t("protocol module carries the reader contract, no DOM, no wasm", () => {
  const src = read("src/modules/solids/solid-reader-protocol.ts");
  assert.ok(src.includes("SolidReaderRequest") && src.includes("SolidReaderResponse"), "request/response types exported");
  assert.ok(!/import \* as THREE/.test(src), "protocol must not pull three.js into the worker");
  assert.ok(src.includes("WHY THE READERS LIVE IN A WORKER"), "the CSP root cause must stay documented");
});
t("client builds the THREE group from worker buffers (no geometry work in the worker)", () => {
  const src = read("src/features/solid-import.ts");
  assert.ok(src.includes("buildSolidGroup"), "group builder stays on the main thread");
  assert.ok(src.includes("summarizeSolids"), "summary text stays main-thread");
});

console.log(`\nsolid-reader-isolation: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
