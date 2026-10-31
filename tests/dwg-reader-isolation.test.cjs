/**
 * DWG reader isolation + CSP regression suite (CSP incompatibility root-cause fix).
 *
 * Root cause (proven 2026-10): @mlightcad/libredwg-web's wasm imports
 * _embind_register_* / _emval_* and registers its whole API at ctor time;
 * emscripten embind builds invokers with `new Function(...)` — JavaScript
 * string evaluation, blocked by the main document CSP (no 'unsafe-eval').
 * Fix: the parser runs in an isolated module worker served with a scoped CSP;
 * the main document stays strict. This suite pins that design.
 *
 * Run: npm run test:dwg-isolation
 */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); }
};
const tAsync = async (name, fn) => {
  try { await fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); }
};

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const FIXTURES = path.join(__dirname, "fixtures");

/* ------------------------------------------------------------------ */
/* Compile the isomorphic parse core into a temp directory INSIDE the */
/* repository. Keeping the output below ROOT lets Node's normal ESM     */
/* package-resolution algorithm reach ROOT/node_modules without any    */
/* Windows symlink/junction.                                           */
/* ------------------------------------------------------------------ */
const OUT = fs.mkdtempSync(path.join(ROOT, ".dwg-iso-"));
fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify({ type: "module" }));
execSync(
  `npx tsc src/modules/cad-link/dwg-parse-core.ts src/modules/cad-link/dwg-reader-protocol.ts` +
  ` --outDir "${OUT}" --module es2020 --target es2020 --moduleResolution node --skipLibCheck --esModuleInterop`,
  { cwd: ROOT, stdio: "inherit" },
);
// tsc lays outputs out relative to the common root (src/modules/cad-link/...)
// Node ESM needs explicit .js extensions on relative imports - add them.
const addJsExt = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) addJsExt(p);
    else if (e.name.endsWith(".js")) {
      const src = fs.readFileSync(p, "utf8");
      const fixed = src.replace(/(from\s*"(\.\.?\/[^"*]+))"/g, (m, a, spec) =>
        spec.endsWith(".js") ? m : `${a}.js"`);
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
const corePath = findFile(OUT, "dwg-parse-core.js");
assert.ok(corePath, "compiled dwg-parse-core.js not found");

(async () => {
  console.log("=== A. CSP-compatible reader startup (static guarantees) ===");
  t("main-thread cad-link/index.ts no longer imports libredwg", () => {
    const src = read("src/modules/cad-link/index.ts");
    assert.ok(!src.includes("@mlightcad/libredwg-web"), "main thread must not import the embind reader");
    assert.ok(src.includes("dwg-reader-worker.ts"), "main thread must spawn the isolated reader worker");
  });
  t("worker + parse core are the only libredwg importers", () => {
    assert.ok(read("src/modules/cad-link/dwg-reader-worker.ts").includes("@mlightcad/libredwg-web") ||
              read("src/modules/cad-link/dwg-parse-core.ts").includes("@mlightcad/libredwg-web"),
      "reader worker side must own the wasm import");
    assert.ok(!read("src/modules/drawings/dwg-engine.ts").includes('import("@mlightcad/libredwg-web")'),
      "drawings engine must go through the worker client, not its own reader");
  });
  t("main document CSP keeps script-src free of 'unsafe-eval'", () => {
    const html = read("index.html");
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/);
    assert.ok(csp, "index.html must declare the meta CSP");
    assert.ok(csp[1].includes("wasm-unsafe-eval"), "main CSP allows wasm compilation");
    assert.ok(!/(^|\s)'unsafe-eval'/.test(csp[1]), "main CSP must NOT allow JS string evaluation");
  });

  console.log("=== B. Local asset loading + scoped worker CSP parity ===");
  t("scoped worker CSP identical across vite.config.ts, vercel.json, public/_headers", () => {
    const workerCsp =
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
    const vite = read("vite.config.ts");
    assert.ok(vite.includes(workerCsp), "vite.config.ts must carry the scoped worker CSP");
    assert.ok(vite.includes("dwg-reader-worker"), "vite dev/preview middleware must route the worker chunk");
    const vercel = JSON.parse(read("vercel.json"));
    const vercelRule = vercel.headers.find((h) => String(h.source).includes("dwg-reader-worker"));
    assert.ok(vercelRule, "vercel.json must scope a CSP to the worker chunk");
    assert.strictEqual(vercelRule.headers.find((h) => h.key === "Content-Security-Policy").value, workerCsp);
    const cf = read("public/_headers");
    assert.ok(cf.includes("/assets/dwg-reader-worker-*") && cf.includes(workerCsp),
      "public/_headers (Cloudflare) must scope the same CSP");
  });
  t("no CDN dependence in the DWG reader path", () => {
    for (const f of ["src/modules/cad-link/index.ts", "src/modules/cad-link/dwg-parse-core.ts",
                     "src/modules/cad-link/dwg-reader-worker.ts", "src/modules/cad-link/dwg-reader-protocol.ts"]) {
      assert.ok(!read(f).includes("jsdelivr"), `${f} must not reference a CDN`);
    }
  });

  console.log("=== C. DWG import (official LibreDWG fixtures) ===");
  // Node 24 on Windows rejects a raw C:\... path as an ESM specifier.
  // Convert filesystem paths to standards-compliant file:// URLs.
  const { parseDwgBytes, toDwgParseError } = await import(pathToFileURL(corePath).href);
  const fixtureBuffer = (name) => {
    const b = fs.readFileSync(path.join(FIXTURES, name));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const parseFixture = async (name) => parseDwgBytes(fixtureBuffer(name), name);
  await tAsync("sample_2000.dwg (AC1015) parses with expected entity mix", async () => {
    const r = await parseFixture("sample_2000.dwg");
    assert.strictEqual(r.version, "AC1015");
    assert.ok(r.entityCount >= 6, `expected >= 6 drawable entities, got ${r.entityCount}`);
    const types = r.doc.entities.map((e) => e.type);
    assert.ok(types.includes("LINE"), "LINE present");
    assert.ok(types.includes("CIRCLE"), "CIRCLE present");
    assert.ok(r.doc.layers && r.doc.layers.length >= 1, "layers preserved");
  });
  await tAsync("sample_2018.dwg (AC1032, newest common format) parses", async () => {
    const r = await parseFixture("sample_2018.dwg");
    assert.strictEqual(r.version, "AC1032");
    assert.ok(r.entityCount >= 1);
  });
  await tAsync("r11_entities_2d.dwg (AC1009, legacy) parses with entities", async () => {
    const r = await parseFixture("r11_entities_2d.dwg");
    assert.strictEqual(r.version, "AC1009");
    assert.ok(r.entityCount >= 1);
  });

  console.log("=== D. DXF import unaffected (pure-TS path, main thread) ===");
  await tAsync("minimal DXF still parses via parseDxf", async () => {
    const dxf = [
      "0", "SECTION", "2", "ENTITIES",
      "0", "LINE", "8", "WALLS", "10", "0.0", "20", "0.0", "11", "10.0", "21", "0.0",
      "0", "CIRCLE", "8", "COLS", "10", "5.0", "20", "5.0", "40", "2.0",
      "0", "ENDSEC", "0", "EOF", "",
    ].join("\r\n");
    const readerPath = findFile(OUT, "dxf-reader.js");
    assert.ok(readerPath, "compiled dxf-reader.js not found");
    const { parseDxf } = await import(pathToFileURL(readerPath).href);
    const doc = parseDxf(dxf);
    assert.ok(doc.entities.length >= 2, "DXF entities parsed");
  });

  console.log("=== E. Error handling taxonomy ===");
  await tAsync("DXF bytes renamed .dwg -> invalid-file with actionable text", async () => {
    const bytes = new TextEncoder().encode("0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n").buffer;
    try { await parseDwgBytes(bytes, "renamed.dwg"); assert.fail("expected rejection"); }
    catch (e) {
      const mapped = toDwgParseError(e);
      assert.strictEqual(mapped.code, "invalid-file", `code=${mapped.code}`);
      assert.ok(/not a DWG file/.test(mapped.message), "message explains the problem");
    }
  });
  await tAsync("garbage bytes -> invalid-file (never crashes the worker contract)", async () => {
    try { await parseDwgBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, "garbage.dwg"); assert.fail("expected rejection"); }
    catch (e) { assert.strictEqual(toDwgParseError(e).code, "invalid-file"); }
  });
  await tAsync("empty buffer -> invalid-file", async () => {
    try { await parseDwgBytes(new ArrayBuffer(0), "empty.dwg"); assert.fail("expected rejection"); }
    catch (e) { assert.strictEqual(toDwgParseError(e).code, "invalid-file"); }
  });

  console.log("=== F. Geometry integrity (coordinates, units, layers) ===");
  await tAsync("fixture coordinates are finite, world-placed, layers kept", async () => {
    const r = await parseFixture("sample_2000.dwg");
    let checked = 0;
    for (const e of r.doc.entities) {
      const pts = [];
      if (e.start) pts.push(e.start);
      if (e.end) pts.push(e.end);
      if (e.center) pts.push(e.center);
      if (e.points) pts.push(...e.points);
      for (const p of pts) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "coordinates must be finite");
        checked++;
      }
    }
    assert.ok(checked > 0, "no geometry coordinates were checked");
    const line = r.doc.entities.find((e) => e.type === "LINE");
    assert.ok(line, "expected at least one LINE");
    assert.ok(r.doc.entities.every((e) => typeof e.layer === "string"), "every entity keeps a layer");
  });
  await tAsync("repeat imports of the same fixture are stable (no stale state)", async () => {
    const a = await parseFixture("sample_2000.dwg");
    const b = await parseFixture("sample_2000.dwg");
    assert.strictEqual(a.entityCount, b.entityCount, "entity count must be identical across repeat parses");
    assert.strictEqual(a.version, b.version);
    try { await parseDwgBytes(new ArrayBuffer(3), "bad.dwg"); } catch { /* expected */ }
    const c = await parseFixture("r11_entities_2d.dwg");
    assert.ok(c.entityCount >= 1, "retry after failure must succeed");
  });

  console.log("=== H. Production deployment artifacts (when dist/ exists) ===");
  if (fs.existsSync(path.join(ROOT, "dist"))) {
    const assets = fs.readdirSync(path.join(ROOT, "dist", "assets"));
    t("worker chunk emitted in production build", () => {
      assert.ok(assets.some((n) => n.startsWith("dwg-reader-worker") && n.endsWith(".js")), "dwg-reader-worker chunk missing");
    });
    t("libredwg wasm emitted as a local asset", () => {
      assert.ok(assets.some((n) => n.startsWith("libredwg-web") && n.endsWith(".wasm")), "wasm asset missing");
      assert.ok(fs.existsSync(path.join(ROOT, "dist", "libredwg", "libredwg-web.wasm")), "public /libredwg fallback missing");
    });
    t("shipped main chunks do not contain the embind reader", () => {
      const mainChunks = assets.filter((n) => n.endsWith(".js") && !n.startsWith("dwg-reader-worker") && !n.startsWith("libredwg-web"));
      for (const n of mainChunks) {
        const src = fs.readFileSync(path.join(ROOT, "dist", "assets", n), "utf8");
        assert.ok(!src.includes("dwg_read_data"), `${n} unexpectedly contains the DWG reader entry (must stay worker-only)`);
      }
    });
  } else {
    console.log("  (dist/ absent - run npm run build to enable deployment artifact checks)");
  }

  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
