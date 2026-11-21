/* File-import hostile-input hardening (issue #90, Revit parity rank 3):
 * prototype-pollution keys, worker message validation (DWG + clash), and
 * client reply validation.
 *
 * Behaviour: pure modules compiled with tsc (same pattern as
 * tests/file-import-boundaries.test.cjs). Adversarial cases use genuinely
 * hostile inputs: `__proto__` / `constructor.prototype` payloads at root,
 * nested and inside arrays; truncated / oversized / wrong-typed worker
 * messages; malformed worker replies. Every case asserts the global
 * invariant `({}).polluted === undefined` where pollution is the risk, or a
 * typed rejection where the boundary must refuse.
 *
 * Run: npm run test:file-import-hostile
 */
const { execFileSync } = require("node:child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-import-hostile-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction");
execFileSync("npx", ["tsc",
  "src/core/safeLoad.ts",
  "src/modules/gis/gis-core.ts",
  "src/modules/cad-link/dwg-reader-protocol.ts",
  "src/modules/clash/clash-core.ts",
  "src/modules/clash/clash-worker-protocol.ts",
  "src/modules/projects/project-schema.ts",
  "--outDir", out, "--module", "commonjs", "--target", "es2020",
  "--moduleResolution", "node", "--esModuleInterop", "--skipLibCheck", "--noCheck"],
  { cwd: root, stdio: "inherit" });
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const { z } = require("zod");
const safe = require(find("safeLoad.js"));
const gis = require(find("gis-core.js"));
const dwg = require(find("dwg-reader-protocol.js"));
const clash = require(find("clash-worker-protocol.js"));
const schema = require(find("project-schema.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const assertNoPollution = () => {
  assert.strictEqual(({}).polluted, undefined, "Object.prototype.polluted must stay undefined");
  assert.strictEqual(Object.prototype.polluted, undefined, "Object.prototype must not gain `polluted`");
};
const permissive = z.object({}).passthrough();

// ── A. safeLoad strips __proto__ ────────────────────────────────────────
console.log("=== A. safeLoad __proto__ stripping ===");
t("root __proto__ key is stripped from a passthrough schema", () => {
  const r = safe.safeLoad("evil.json", '{"__proto__":{"polluted":"yes"},"a":1}', permissive);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r.value, "__proto__"), false);
  assertNoPollution();
});
t("nested __proto__ keys inside objects and arrays are stripped", () => {
  const raw = JSON.stringify({ items: [{ "__proto__": { polluted: "yes" }, x: 1 }], deep: { l2: { "__proto__": { polluted: "yes" } } } });
  const r = safe.safeLoad("evil.json", raw, z.object({ items: z.array(z.unknown()), deep: z.unknown() }).passthrough());
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r.value.items[0], "__proto__"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r.value.deep.l2, "__proto__"), false);
  assert.strictEqual(r.value.items[0].x, 1, "legitimate siblings survive the strip");
  assertNoPollution();
});
t("constructor.prototype payload is inert data, never a global pollution", () => {
  const raw = JSON.stringify({ constructor: { prototype: { polluted: "yes" } } });
  const r = safe.safeLoad("evil.json", raw, permissive);
  assert.ok(r.ok, JSON.stringify(r));
  // The data is preserved (constructor is a legitimate key name) but merging
  // it the way a consumer would cannot pollute Object.prototype.
  const target = {};
  Object.assign(target, r.value);
  assertNoPollution();
  assert.strictEqual(target.constructor, r.value.constructor, "own-property assignment stays local to the target");
});
t("markups schema strips __proto__ and still loads valid markups", () => {
  const raw = JSON.stringify({ version: 1, __proto__: { polluted: "yes" },
    markups: [{ kind: "line", pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] });
  const r = safe.safeLoad("evil.markups.json", raw, safe.MarkupsFileSchema);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.value.markups.length, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r.value, "__proto__"), false);
  assertNoPollution();
});
t("stripProtoKeys handles a cyclic value without hanging", () => {
  const cyc = { a: 1 };
  cyc.self = cyc;
  cyc["__proto__"] = { polluted: "yes" };
  const out = safe.stripProtoKeys(cyc);
  assert.strictEqual(out, cyc, "same object, cleaned in place");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(out, "__proto__"), false);
  assert.strictEqual(out.self, cyc, "cycle preserved");
  assertNoPollution();
});

// ── B. GeoJSON prototype pollution ──────────────────────────────────────
console.log("=== B. GeoJSON hostile properties ===");
t("feature properties carrying __proto__ import without polluting", () => {
  const raw = JSON.stringify({ type: "FeatureCollection", features: [
    { type: "Feature", properties: { __proto__: { polluted: "yes" }, name: "site" },
      geometry: { type: "Point", coordinates: [10, 20] } },
  ] });
  const layer = gis.parseGeoJson(raw, "evil");
  assert.strictEqual(layer.features.length, 1);
  assert.strictEqual(layer.features[0].props.name, "site");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(layer.features[0].props, "__proto__"), false);
  assertNoPollution();
});
t("nested __proto__ inside a properties object value is neutralised", () => {
  const raw = JSON.stringify({ type: "FeatureCollection", features: [
    { type: "Feature", properties: { meta: { __proto__: { polluted: "yes" } } },
      geometry: { type: "Point", coordinates: [0, 0] } },
  ] });
  const layer = gis.parseGeoJson(raw, "evil");
  assert.strictEqual(layer.features.length, 1);
  assertNoPollution();
});
t("a __proto__-keyed geometry object cannot smuggle state into the layer", () => {
  const raw = '{"type":"FeatureCollection","features":[{"type":"Feature","properties":null,"geometry":{"type":"Point","coordinates":[1,2]}}],"__proto__":{"polluted":"yes"}}';
  const layer = gis.parseGeoJson(raw, "evil");
  assert.strictEqual(layer.features.length, 1);
  assertNoPollution();
});

// ── C. Project document prototype pollution ─────────────────────────────
console.log("=== C. Project document hostile keys ===");
t("normalizeProjectDoc keeps a hostile doc usable without polluting", () => {
  const raw = JSON.parse('{"id":"p1","name":"evil","__proto__":{"polluted":"yes"},' +
    '"elements":[{"id":"e1","type":"wall","__proto__":{"polluted":"yes"}}]}');
  const r = schema.normalizeProjectDoc(raw);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.doc.id, "p1");
  assertNoPollution();
  // Even assigning a hostile element onto a fresh object stays local.
  const target = {};
  Object.assign(target, r.doc.elements[0]);
  assertNoPollution();
});
t("safeLoad ProjectFileSchema strips __proto__ from the doc record", () => {
  const raw = JSON.stringify({ format: "obsproj", version: 1, savedAt: 0,
    doc: { id: "p1", "__proto__": { polluted: "yes" } }, blobs: [] });
  const r = safe.safeLoad("evil.obsproj", raw, safe.ProjectFileSchema);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r.value.doc, "__proto__"), false);
  assertNoPollution();
});

// ── D. DWG reader request validation ────────────────────────────────────
console.log("=== D. DWG worker request validation ===");
const dwgBytes = (n) => new ArrayBuffer(n);
t("valid parse and thumbnail requests pass", () => {
  assert.ok(dwg.validateDwgReaderRequest({ id: 1, kind: "parse", bytes: dwgBytes(64), fileName: "a.dwg" }).ok);
  assert.ok(dwg.validateDwgReaderRequest({ id: 2, kind: "thumbnail", bytes: dwgBytes(64), fileName: "a.dwg" }).ok);
});
t("non-ArrayBuffer / empty / oversized bytes are rejected", () => {
  for (const bad of [new Uint8Array(64), "AC1032", null, undefined, 42]) {
    const r = dwg.validateDwgReaderRequest({ id: 1, kind: "parse", bytes: bad, fileName: "a.dwg" });
    assert.ok(!r.ok && r.id === 1, `bytes ${String(bad)} must be rejected`);
  }
  assert.ok(!dwg.validateDwgReaderRequest({ id: 1, kind: "parse", bytes: dwgBytes(0), fileName: "a.dwg" }).ok, "empty");
  const huge = new ArrayBuffer(dwg.DWG_READER_MAX_BYTES + 1);
  const r = dwg.validateDwgReaderRequest({ id: 1, kind: "parse", bytes: huge, fileName: "a.dwg" });
  assert.ok(!r.ok, "over 256 MiB must be rejected");
  assert.ok(dwg.validateDwgReaderRequest({ id: 1, kind: "parse", bytes: dwgBytes(dwg.DWG_READER_MAX_BYTES), fileName: "a.dwg" }).ok, "at the ceiling passes");
});
t("bad kind / id / fileName are rejected with a typed message", () => {
  const base = { kind: "parse", bytes: dwgBytes(64), fileName: "a.dwg" };
  assert.ok(!dwg.validateDwgReaderRequest({ ...base, id: 1.5 }).ok, "fractional id");
  assert.ok(!dwg.validateDwgReaderRequest({ ...base, id: -1 }).ok, "negative id");
  assert.ok(!dwg.validateDwgReaderRequest({ ...base, id: "1" }).ok, "string id");
  assert.ok(!dwg.validateDwgReaderRequest({ id: 1, ...base, kind: "explode" }).ok, "unknown kind");
  assert.ok(!dwg.validateDwgReaderRequest({ id: 1, ...base, fileName: "" }).ok, "empty fileName");
  assert.ok(!dwg.validateDwgReaderRequest({ id: 1, ...base, fileName: "x".repeat(1025) }).ok, "over-long fileName");
  const noId = dwg.validateDwgReaderRequest({ kind: "parse", bytes: dwgBytes(64), fileName: "a.dwg" });
  assert.ok(!noId.ok && noId.id === null, "missing id has no id to answer");
  assert.ok(!dwg.validateDwgReaderRequest(null).ok && dwg.validateDwgReaderRequest(null).id === null, "null request");
});
t("DWG worker validates before parsing (source ordering)", () => {
  const src = read("src/modules/cad-link/dwg-reader-worker.ts");
  const v = src.indexOf("validateDwgReaderRequest(req)");
  assert.ok(v >= 0, "worker must call the validator");
  assert.ok(v < src.indexOf("parseDwgBytes("), "validator runs before the parse");
  assert.ok(v < src.indexOf("extractDwgThumbnail("), "validator runs before thumbnail extraction");
});
t("DWG client validates worker replies (source wiring)", () => {
  const src = read("src/modules/cad-link/index.ts");
  assert.ok(src.includes("validateDwgParseSuccess(res)"), "parse success validated");
  assert.ok(src.includes("validateDwgThumbSuccess(res)"), "thumbnail success validated");
  assert.ok(src.includes("validateDwgFailure(res)"), "failure validated");
});

// ── E. DWG reply validation ─────────────────────────────────────────────
console.log("=== E. DWG worker reply validation ===");
t("valid parse / thumbnail / failure replies pass", () => {
  assert.ok(dwg.validateDwgParseSuccess({ doc: { entities: [] }, summary: "s", version: "AC1032", entityCount: 3 }).ok);
  assert.ok(dwg.validateDwgThumbSuccess({ mime: "image/bmp", dataB64: "AAAA" }).ok);
  assert.ok(dwg.validateDwgFailure({ code: "parse-failed", message: "bad file" }).ok);
});
t("malformed success replies are rejected", () => {
  const base = { doc: {}, summary: "s", version: "AC1032", entityCount: 1 };
  assert.ok(!dwg.validateDwgParseSuccess({ ...base, doc: null }).ok, "null doc");
  assert.ok(!dwg.validateDwgParseSuccess({ ...base, doc: "nope" }).ok, "string doc");
  assert.ok(!dwg.validateDwgParseSuccess({ ...base, entityCount: -1 }).ok, "negative count");
  assert.ok(!dwg.validateDwgParseSuccess({ ...base, entityCount: 1.5 }).ok, "fractional count");
  assert.ok(!dwg.validateDwgParseSuccess({ ...base, summary: 7 }).ok, "non-string summary");
  assert.ok(!dwg.validateDwgParseSuccess({ ...base, version: null }).ok, "null version");
  assert.ok(!dwg.validateDwgParseSuccess(null).ok, "null reply");
  assert.ok(!dwg.validateDwgThumbSuccess({ mime: "image/bmp", dataB64: 42 }).ok, "non-string dataB64");
  assert.ok(!dwg.validateDwgThumbSuccess({ mime: "", dataB64: "AAAA" }).ok, "empty mime");
});
t("malformed failure replies are rejected", () => {
  assert.ok(!dwg.validateDwgFailure({ code: "nope", message: "x" }).ok, "unknown code");
  assert.ok(!dwg.validateDwgFailure({ code: "parse-failed" }).ok, "missing message");
  assert.ok(!dwg.validateDwgFailure({ code: "parse-failed", message: "" }).ok, "empty message");
  assert.ok(!dwg.validateDwgFailure("boom").ok, "string reply");
});

// ── F. Clash worker request validation ───────────────────────────────────
console.log("=== F. Clash worker request validation ===");
const rules = { tolerance: 0.005, clearance: 0, lowerBound: 0, minVolume: 1e-6, ignoreIdentical: false, ignoreSameCategory: false };
const item = (over = {}) => ({ modelId: "m1", localId: 1, name: "Wall", category: "Walls",
  box: [0, 0, 0, 1, 1, 1], ...over });
const run = (over = {}) => ({ type: "run", requestId: "cr-1", items: [item()], groups: [[0]],
  rules, method: "hard-triangle", selfPairs: true, ...over });
t("valid run and cancel requests pass", () => {
  const r = clash.validateClashWorkerRequest(run({ items: [item({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) })] }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(clash.validateClashWorkerRequest({ type: "cancel", requestId: "cr-1" }).ok);
  assert.ok(clash.validateClashWorkerRequest(run({ sides: [1] })).ok, "sides matching items pass");
});
t("malformed run envelopes are rejected", () => {
  assert.ok(!clash.validateClashWorkerRequest(null).ok, "null");
  assert.ok(!clash.validateClashWorkerRequest("run").ok, "string");
  assert.ok(!clash.validateClashWorkerRequest({ type: "run" }).ok, "missing requestId");
  assert.ok(!clash.validateClashWorkerRequest({ type: "run", requestId: "" }).ok, "empty requestId");
  assert.ok(!clash.validateClashWorkerRequest({ type: "explode", requestId: "cr-1" }).ok, "unknown type");
  assert.ok(!clash.validateClashWorkerRequest(run({ items: "nope" })).ok, "items not an array");
  assert.ok(!clash.validateClashWorkerRequest(run({ method: "teleport" })).ok, "unknown method");
  assert.ok(!clash.validateClashWorkerRequest(run({ selfPairs: "yes" })).ok, "non-boolean selfPairs");
  assert.ok(!clash.validateClashWorkerRequest(run({ groups: [[0.5]] })).ok, "fractional group index");
  assert.ok(!clash.validateClashWorkerRequest(run({ groups: "nope" })).ok, "groups not an array");
  assert.ok(!clash.validateClashWorkerRequest(run({ sides: [1, 2] })).ok, "sides length mismatch");
});
t("malformed rules are rejected", () => {
  assert.ok(!clash.validateClashWorkerRequest(run({ rules: { ...rules, tolerance: NaN } })).ok, "NaN tolerance");
  assert.ok(!clash.validateClashWorkerRequest(run({ rules: { ...rules, clearance: Infinity } })).ok, "infinite clearance");
  const { clearance, ...noClearance } = rules;
  assert.ok(!clash.validateClashWorkerRequest(run({ rules: noClearance })).ok, "missing clearance");
  assert.ok(!clash.validateClashWorkerRequest(run({ rules: { ...rules, ignoreIdentical: 0 } })).ok, "non-boolean flag");
});
t("malformed items are rejected", () => {
  assert.ok(!clash.validateClashWorkerRequest(run({ items: [item({ box: [0, 0, 0, 1, 1] })] })).ok, "5-number box");
  assert.ok(!clash.validateClashWorkerRequest(run({ items: [item({ box: [0, 0, 0, NaN, 1, 1] })] })).ok, "NaN box");
  assert.ok(!clash.validateClashWorkerRequest(run({ items: [item({ box: [2, 0, 0, 1, 1, 1] })] })).ok, "min > max box");
  assert.ok(!clash.validateClashWorkerRequest(run({ items: [item({ modelId: "" })] })).ok, "empty modelId");
  assert.ok(!clash.validateClashWorkerRequest(run({ items: [item({ localId: 1.5 })] })).ok, "fractional localId");
  assert.ok(!clash.validateClashWorkerRequest(run({ items: [item({ name: 7 })] })).ok, "non-string name");
  assert.ok(!clash.validateClashWorkerRequest(run({ items: ["nope"] })).ok, "non-object item");
});
t("malformed triangle buffers are rejected", () => {
  assert.ok(!clash.validateClashWorkerRequest(run({ items: [item({ positions: [0, 0, 0] })] })).ok, "plain array positions");
  assert.ok(!clash.validateClashWorkerRequest(run({ items: [item({ positions: new Float32Array(10) })] })).ok, "length not a multiple of 9");
  const nan = new Float32Array(9); nan[3] = NaN;
  assert.ok(!clash.validateClashWorkerRequest(run({ items: [item({ positions: nan })] })).ok, "NaN coordinate");
});
t("unbounded runs are rejected at the caps", () => {
  const many = Array.from({ length: clash.CLASH_WORKER_MAX_ITEMS + 1 }, (_, i) => item({ localId: i }));
  assert.ok(!clash.validateClashWorkerRequest(run({ items: many, groups: [[]] })).ok, "over the item cap");
  const big = new Float32Array(clash.CLASH_WORKER_MAX_TRIANGLE_FLOATS + 9);
  assert.ok(!clash.validateClashWorkerRequest(run({ items: [item({ positions: big })] })).ok, "over the triangle cap");
  const atCap = new Float32Array(clash.CLASH_WORKER_MAX_TRIANGLE_FLOATS);
  assert.ok(clash.validateClashWorkerRequest(run({ items: [item({ positions: atCap })] })).ok, "at the triangle cap passes");
});
t("clash worker validates before deserializing (source ordering)", () => {
  const src = read("src/workers/clash.worker.ts");
  const v = src.indexOf("validateClashWorkerRequest(data)");
  assert.ok(v >= 0, "worker must call the validator");
  assert.ok(v < src.indexOf("req.items.map(deserializeItem)"), "validator runs before deserialize");
  assert.ok(v < src.indexOf("runClashCore("), "validator runs before the engine");
});
t("clash client validates worker replies (source wiring)", () => {
  const src = read("src/features/clash-worker-client.ts");
  assert.ok(src.includes("validateClashWorkerReply(e.data)"), "client must validate replies");
  const v = src.indexOf("validateClashWorkerReply(e.data)");
  assert.ok(v < src.indexOf("msg.clashes.map(rehydrateClash)"), "validation runs before rehydration");
});

// ── G. Clash worker reply validation ─────────────────────────────────────
console.log("=== G. Clash worker reply validation ===");
const ref = { modelId: "m1", localId: 1, name: "Wall", cat: "Walls" };
const goodClash = { a: ref, b: { ...ref, localId: 2 }, kind: "intersect", method: "hard-triangle",
  precision: "triangles", depthVol: 0.1, triPairs: 2, minGap: 0,
  boxA: [0, 0, 0, 1, 1, 1], boxB: [0.5, 0, 0, 1.5, 1, 1], point: [0.5, 0.5, 0.5] };
t("valid progress / result / error replies pass", () => {
  assert.ok(clash.validateClashWorkerReply({ type: "progress", requestId: "cr-1", progress: { phase: "broadphase", current: 1, total: 4, found: 0 } }).ok);
  assert.ok(clash.validateClashWorkerReply({ type: "result", requestId: "cr-1", clashes: [goodClash] }).ok);
  assert.ok(clash.validateClashWorkerReply({ type: "result", requestId: "cr-1", clashes: [] }).ok);
  assert.ok(clash.validateClashWorkerReply({ type: "error", requestId: "cr-1", message: "boom" }).ok);
});
t("malformed result replies are rejected", () => {
  assert.ok(!clash.validateClashWorkerReply({ type: "result", requestId: "cr-1", clashes: "nope" }).ok, "clashes not an array");
  assert.ok(!clash.validateClashWorkerReply({ type: "result", requestId: "cr-1", clashes: [{ ...goodClash, boxA: [0, 0, 0, 1, 1] }] }).ok, "5-number boxA");
  assert.ok(!clash.validateClashWorkerReply({ type: "result", requestId: "cr-1", clashes: [{ ...goodClash, depthVol: NaN }] }).ok, "NaN depthVol");
  assert.ok(!clash.validateClashWorkerReply({ type: "result", requestId: "cr-1", clashes: [{ ...goodClash, kind: "explode" }] }).ok, "unknown kind");
  assert.ok(!clash.validateClashWorkerReply({ type: "result", requestId: "cr-1", clashes: [{ ...goodClash, point: [0, 0] }] }).ok, "2-number point");
  assert.ok(!clash.validateClashWorkerReply({ type: "result", requestId: "cr-1", clashes: [{ ...goodClash, a: { ...ref, localId: 1.5 } }] }).ok, "fractional localId in ref");
  assert.ok(!clash.validateClashWorkerReply({ type: "result", clashes: [] }).ok, "missing requestId");
});
t("malformed progress / error replies are rejected", () => {
  assert.ok(!clash.validateClashWorkerReply({ type: "progress", requestId: "cr-1", progress: { phase: "warp", current: 0, total: 0, found: 0 } }).ok, "unknown phase");
  assert.ok(!clash.validateClashWorkerReply({ type: "progress", requestId: "cr-1", progress: { phase: "done", current: NaN, total: 0, found: 0 } }).ok, "NaN counter");
  assert.ok(!clash.validateClashWorkerReply({ type: "error", requestId: "cr-1" }).ok, "error without message");
  assert.ok(!clash.validateClashWorkerReply({ type: "mystery", requestId: "cr-1" }).ok, "unknown reply type");
  assert.ok(!clash.validateClashWorkerReply(null).ok, "null reply");
});

// ── Final invariant ──────────────────────────────────────────────────────
t("Object.prototype is clean at the end of the suite", () => { assertNoPollution(); });

console.log(`\nfile-import-hostile: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
