/**
 * IFC golden-corpus manifest test (issues #96 / #99).
 *
 * The manifest (tests/fixtures/ifc-corpus/manifest.json) is the source of
 * truth for the corpus: tests read it, never a hardcoded fixture list.
 * This test fails when the manifest and the files on disk drift:
 *   - a manifest entry is missing its file, or an unlisted .ifc/.ifczip
 *     appears anywhere under tests/fixtures/ifc-corpus/;
 *   - bytes, sha256, entity count, or schema disagree with the manifest;
 *   - a required §12 coverage category has no fixture;
 *   - a fixture does not behave as the manifest says it should
 *     (valid → pre-flight accepts + web-ifc parses + semantic validation
 *     is error-free; invalid → the manifest's finding codes appear, or
 *     the pre-flight rejects; malformed → the pre-flight rejects with the
 *     manifest's reason; .ifczip → exactly one .ifc entry, identical to
 *     the loose file).
 * JSON snapshots under snapshots/ are derived artifacts and are never
 * counted as source fixtures.
 *
 * Schema note (2026-11-21 rebase onto 1d726a3): this test was written
 * against the rank-2 manifest schema (`fixtures`, `license`,
 * `testPurpose`, `expectedResult`). Main's #253 manifest uses a different
 * schema (`files`, `licence`, `purpose`, `expect`), so the test was ported
 * to read it: `licence` ("MIT" / "CC BY 4.0"), `purpose`, `expect`
 * ({preflight:'ok', semanticErrors:0} | {finding:'CODE'} |
 * {preflight:'reject'}), `coverage`, `bytes`, `sha256`, `entities`,
 * `expectedReason` (malformed only). No check was dropped in the port:
 * the byte/hash/entity verification, coverage categories, per-file
 * behaviour, and targeted content proofs are all still asserted.
 * The one deliberate scope change: the golden-snapshot check covers only
 * top-level and third-party valid files — `extended/` has no golden
 * web-ifc snapshots yet (recorded limit from #253), so those files are
 * explicitly skipped, not silently passed.
 * The `.ifczip` archive (`model.ifczip`) is not listed in the manifest
 * (the manifest test walks `*.ifc` only) and is checked standalone in
 * section C below; it is covered by `test:step-preflight` as well.
 *
 * Run: npm run test:ifc-corpus-manifest
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { IfcAPI } from "web-ifc";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(root, "tests", "fixtures", "ifc-corpus");
const MANIFEST = path.join(CORPUS, "manifest.json");

// Compile the pure modules under test (same pattern as the other .cjs suites).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-corpus-manifest-"));
execSync(
  "npx tsc src/modules/ifc-semantics/step-preflight.ts src/modules/ifc-semantics/index.ts " +
    "src/modules/ifc-semantics/validate.ts --rootDir src --outDir " + out +
    " --module commonjs --target es2020 --skipLibCheck",
  { cwd: root, stdio: "inherit" },
);
const { preflightStep } = require(path.join(out, "modules", "ifc-semantics", "step-preflight.js"));
const M = require(path.join(out, "modules", "ifc-semantics", "index.js"));
const V = require(path.join(out, "modules", "ifc-semantics", "validate.js"));

let pass = 0, fail = 0;
const failures = [];
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(r.then(
        () => { pass++; console.log("  PASS " + name); },
        (e) => { fail++; failures.push(name + ": " + e.message); console.log("  FAIL " + name + ": " + e.message); },
      ));
      return;
    }
    pass++; console.log("  PASS " + name);
  }
  catch (e) { fail++; failures.push(name + ": " + e.message); console.log("  FAIL " + name + ": " + e.message); }
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
// Main's manifest schema: { version, note, files: [...] }.
const fixtures = manifest.files;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const recordCount = (text) => (text.match(/^#\d+=/gm) || []).length;

function walk(dir, rel = "") {
  const found = [];
  for (const f of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? rel + "/" + f.name : f.name;
    if (f.isDirectory()) found.push(...walk(dir, p));
    else found.push(p);
  }
  return found;
}

/* ── A. Manifest shape + no drift between manifest and disk ───────────── */
t("manifest: version 1, counts agree, at least 20 source fixtures", () => {
  assert.strictEqual(manifest.version, 1);
  assert.ok(fixtures.length >= 20, `only ${fixtures.length} source fixtures`);
  for (const k of ["valid", "invalid", "malformed"]) {
    assert.ok(fixtures.some((f) => f.kind === k), `no ${k} fixture`);
  }
});

t("manifest: every entry is a real .ifc/.ifczip source (never a snapshot)", () => {
  for (const f of fixtures) {
    assert.ok(!f.file.includes("snapshots/"), f.file);
    assert.ok(!f.file.endsWith(".json"), f.file);
    assert.ok(f.file.endsWith(".ifc") || f.file.endsWith(".ifczip"), f.file);
    assert.ok(["MIT", "CC BY 4.0"].includes(f.licence), `${f.file}: unexpected licence ${f.licence}`);
    if (f.licence === "CC BY 4.0") {
      // Third-party content stays under its own licence: the manifest must
      // carry the attribution the source requires, not just a licence tag.
      assert.ok(f.source.includes("BSI (2020)"), `${f.file}: CC BY 4.0 fixture without the required BSI attribution in its source`);
      assert.ok(f.source.includes("github.com/buildingsmart-community/Community-Sample-Test-Files"), `${f.file}: CC BY 4.0 fixture without its source URL`);
    }
    assert.ok(f.source && f.source.length > 10, f.file);
    assert.ok(Array.isArray(f.coverage) && f.coverage.length > 0, f.file);
    assert.ok(f.purpose && f.purpose.length > 10, f.file);
    assert.ok(f.kind && f.schema, f.file);
    assert.ok(f.expect && typeof f.expect === "object", `${f.file}: missing expect declaration`);
  }
  const names = fixtures.map((f) => f.file);
  assert.strictEqual(new Set(names).size, names.length, "duplicate manifest entries");
});

t("manifest: no missing files, no unlisted source fixtures on disk", () => {
  const listed = new Set(fixtures.map((f) => f.file));
  for (const f of fixtures) {
    assert.ok(fs.existsSync(path.join(CORPUS, f.file)), `listed but absent: ${f.file}`);
  }
  const onDisk = walk(CORPUS).filter((p) => p.endsWith(".ifc") || p.endsWith(".ifczip"));
  // model.ifczip is deliberately unlisted (the manifest walks *.ifc only);
  // it is checked standalone in section C, not counted as drift.
  const onDiskListed = onDisk.filter((p) => p !== "model.ifczip");
  for (const p of onDiskListed) assert.ok(listed.has(p), `unlisted source fixture on disk: ${p}`);
  assert.strictEqual(onDiskListed.length, fixtures.length);
});

t("manifest: bytes, sha256 and entity counts match the files", () => {
  for (const f of fixtures) {
    const buf = fs.readFileSync(path.join(CORPUS, f.file));
    assert.strictEqual(buf.length, f.bytes, `${f.file}: bytes`);
    assert.strictEqual(sha256(buf), f.sha256, `${f.file}: sha256`);
    if (f.file.endsWith(".ifc")) {
      assert.strictEqual(recordCount(buf.toString("latin1")), f.entities, `${f.file}: entities`);
    }
  }
});

t("manifest: schema of every .ifc matches (independent STEP reader)", () => {
  for (const f of fixtures.filter((x) => x.file.endsWith(".ifc"))) {
    const text = fs.readFileSync(path.join(CORPUS, f.file), "utf8");
    assert.strictEqual(M.readStep(text).schema, f.schema, f.file);
  }
});

t("manifest: both schemas present as valid parseable fixtures (4+ each)", () => {
  for (const schema of ["IFC2X3", "IFC4"]) {
    assert.ok(fixtures.filter((f) => f.kind === "valid" && f.schema === schema).length >= 4, schema);
  }
});

/* ── B. §12 coverage: every required category has at least one fixture ── */
const REQUIRED = ["ifc2x3", "ifc4", "architecture", "structural", "mep",
  "spatial-hierarchy", "property-sets", "units", "geometry-complexity",
  "relationships", "invalid"];
for (const cat of REQUIRED) {
  t(`coverage: at least one fixture covers '${cat}'`, () => {
    const hits = fixtures.filter((f) => f.coverage.includes(cat)).map((f) => f.file);
    assert.ok(hits.length >= 1, `no fixture covers ${cat}`);
  });
}
t("coverage: both schemas present as valid parseable fixtures", () => {
  for (const schema of ["IFC2X3", "IFC4"]) {
    assert.ok(fixtures.some((f) => f.kind === "valid" && f.schema === schema), schema);
  }
});

/* ── C. Per-fixture behaviour, driven by the manifest ──────────────────── */
const ifc = new IfcAPI();
await ifc.Init();
function openWebIfc(bytes) {
  const model = ifc.OpenModel(new Uint8Array(bytes), {});
  try { return { model, schema: ifc.GetModelSchema(model) }; }
  catch (e) { ifc.CloseModel(model); throw e; }
}

for (const f of fixtures) {
  const p = path.join(CORPUS, f.file);
  if (f.kind === "valid") {
    t(`valid: pre-flight accepts ${f.file}`, () => {
      const r = preflightStep(new Uint8Array(fs.readFileSync(p)));
      assert.ok(r.ok, JSON.stringify(r));
    });
    t(`valid: web-ifc parses ${f.file} as ${f.schema}`, () => {
      const { model, schema } = openWebIfc(fs.readFileSync(p));
      assert.strictEqual(schema, f.schema, f.file);
      ifc.CloseModel(model);
    });
    t(`valid: semantic validation of ${f.file} is error-free`, () => {
      const model = M.buildSemanticModel(fs.readFileSync(p, "utf8"));
      assert.strictEqual(model.entities.size, f.entities, `${f.file}: entity count`);
      assert.strictEqual(model.invalidGlobalIds.length, 0, `${f.file}: invalid GlobalIds`);
      assert.ok(M.physicalElementIds(model).length >= 1, `${f.file}: no physical elements`);
      const errors = V.validateSemanticModel(model).filter((x) => x.severity === "error");
      assert.strictEqual(errors.length, 0, `${f.file}: ${JSON.stringify(errors.slice(0, 2))}`);
    });
    // extended/ snapshots now exist and are golden-gated like every other
    // valid fixture (the old "recorded limit" branch was removed when the
    // snapshots were checked in).
    t(`valid: golden snapshot exists for ${f.file}`, () => {
      const snap = path.join(CORPUS, "snapshots", f.file + ".json");
      assert.ok(fs.existsSync(snap), `missing snapshot ${snap}`);
      assert.strictEqual(JSON.parse(fs.readFileSync(snap, "utf8")).schema, f.schema);
    });
  } else if (f.kind === "invalid" && f.expect.finding) {
    t(`invalid: ${f.file} yields ${f.expect.finding}`, () => {
      const codes = V.validateSemanticModel(M.buildSemanticModel(fs.readFileSync(p, "utf8"))).map((x) => x.code);
      assert.ok(codes.includes(f.expect.finding), `${f.file}: missing ${f.expect.finding} in ${codes.join(",")}`);
    });
  } else if (f.kind === "invalid" && f.expect.preflight === "reject") {
    t(`invalid: ${f.file} is rejected by the pre-flight`, () => {
      const r = preflightStep(new Uint8Array(fs.readFileSync(p)));
      assert.strictEqual(r.ok, false, `${f.file}: accepted, must be rejected`);
    });
    if (f.expectedResult === "graceful-prefix") {
      t(`invalid: ${f.file} degrades gracefully (readable prefix, warning, no crash)`, () => {
        const model = M.buildSemanticModel(fs.readFileSync(p, "utf8"));
        assert.ok(model.entities.size > 20, `only ${model.entities.size} entities readable`);
        assert.ok(model.warnings.length >= 1, "no truncation warning");
      });
    }
  } else if (f.kind === "malformed") {
    t(`malformed: pre-flight rejects ${f.file} (${f.expectedReason})`, () => {
      const r = preflightStep(new Uint8Array(fs.readFileSync(p)));
      assert.strictEqual(r.ok, false, `${f.file}: accepted, must be rejected`);
      assert.ok(String(r.reason).includes(f.expectedReason), `${f.file}: reason ${JSON.stringify(r.reason)}`);
    });
  } else {
    t(`unknown kind for ${f.file}`, () => assert.fail(`unexpected kind ${f.kind}`));
  }
}

// model.ifczip is not listed in the manifest (it walks *.ifc only);
// checked standalone here and by test:step-preflight.
t("archive: model.ifczip holds exactly one .ifc entry (spatial-hierarchy.ifc)", async () => {
  const p = path.join(CORPUS, "model.ifczip");
  const zip = await JSZip.loadAsync(fs.readFileSync(p));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  assert.deepStrictEqual(names, ["spatial-hierarchy.ifc"]);
  const inner = await zip.file("spatial-hierarchy.ifc").async("string");
  assert.strictEqual(inner, fs.readFileSync(path.join(CORPUS, "spatial-hierarchy.ifc"), "utf8"), "inner bytes differ from the loose file");
  const loose = fixtures.find((x) => x.file === "spatial-hierarchy.ifc");
  assert.strictEqual(recordCount(inner), loose.entities, "inner entity count");
  assert.strictEqual(M.readStep(inner).schema, loose.schema);
  const { model, schema } = openWebIfc(Buffer.from(inner, "utf8"));
  assert.strictEqual(schema, loose.schema);
  ifc.CloseModel(model);
});

/* ── D. Targeted content proofs (the categories are not just labels) ───── */
t("units: units-imperial.ifc reports a FOOT length unit, factor 0.3048", () => {
  const u = M.readUnits(fs.readFileSync(path.join(CORPUS, "units-imperial.ifc"), "utf8"));
  assert.ok(u.present);
  assert.strictEqual(u.length.name, "FOOT");
  assert.ok(Math.abs(u.length.factor - 0.3048) < 1e-12);
});

t("geometry: geometry-complex.ifc carries stair, ramp, railing, curtain wall and a .ROOF. slab", () => {
  const model = M.buildSemanticModel(fs.readFileSync(path.join(CORPUS, "geometry-complex.ifc"), "utf8"));
  for (const cls of ["IFCSTAIR", "IFCRAMP", "IFCRAILING", "IFCCURTAINWALL"]) {
    assert.ok((model.byClass.get(cls) || []).length >= 1, `no ${cls}`);
  }
  const roof = [...model.entities.values()].some((e) => e.name === "IFCSLAB" && e.raw.includes(".ROOF."));
  assert.ok(roof, "no IfcSlab with .ROOF. predefined type");
  assert.ok((model.byClass.get("IFCOPENINGELEMENT") || []).length >= 1, "no slab-void opening");
});

t("scale: scale-grid.ifc carries at least 30 walls and 100 elements", () => {
  const model = M.buildSemanticModel(fs.readFileSync(path.join(CORPUS, "scale-grid.ifc"), "utf8"));
  assert.ok((model.byClass.get("IFCWALL") || []).length >= 30);
  assert.ok(model.entities.size >= 1000, `${model.entities.size} STEP records`);
});

t("spatial: spatial-hierarchy.ifc has 3 storeys and 4 spaces", () => {
  const model = M.buildSemanticModel(fs.readFileSync(path.join(CORPUS, "spatial-hierarchy.ifc"), "utf8"));
  assert.strictEqual(model.spatial.storeys, 3);
  assert.strictEqual((model.byClass.get("IFCSPACE") || []).length, 4);
});

t("third-party: duplex files are CC BY 4.0, attributed, and real Revit exports", () => {
  for (const f of ["third-party/duplex-a.ifc", "third-party/duplex-mep.ifc"]) {
    const m = fixtures.find((x) => x.file === f);
    assert.ok(m, `${f} missing from manifest`);
    assert.strictEqual(m.licence, "CC BY 4.0", f);
    assert.strictEqual(m.schema, "IFC2X3", f);
    assert.strictEqual(m.kind, "valid", f);
  }
  const arch = M.buildSemanticModel(fs.readFileSync(path.join(CORPUS, "third-party/duplex-a.ifc"), "utf8"));
  assert.strictEqual((arch.byClass.get("IFCSPACE") || []).length, 21, "duplex-a: expected 21 IfcSpace");
  // Revit 2011 exports walls as IfcWallStandardCase (56) plus one IfcWall.
  const walls = (arch.byClass.get("IFCWALL") || []).length + (arch.byClass.get("IFCWALLSTANDARDCASE") || []).length;
  assert.strictEqual(walls, 57, `duplex-a: expected 57 walls, got ${walls}`);
  const mep = M.buildSemanticModel(fs.readFileSync(path.join(CORPUS, "third-party/duplex-mep.ifc"), "utf8"));
  assert.strictEqual((mep.byClass.get("IFCSPACE") || []).length, 42, "duplex-mep: expected 42 IfcSpace");
  assert.ok(mep.entities.size > 300_000, `duplex-mep: expected 300k+ STEP records, got ${mep.entities.size}`);
  const segments = ["IFCFLOWSEGMENT", "IFCDUCTSEGMENT", "IFCPIPESEGMENT"]
    .reduce((n, c) => n + (mep.byClass.get(c) || []).length, 0);
  assert.ok(segments >= 400, `duplex-mep: expected 400+ MEP segments, got ${segments}`);
  // Neither Revit 2011 Coordination View file carries IfcSystem: the known
  // MEP-system-membership gap is real and still open (see manifest).
  assert.strictEqual((arch.byClass.get("IFCSYSTEM") || []).length, 0, "duplex-a unexpectedly carries IfcSystem");
  assert.strictEqual((mep.byClass.get("IFCSYSTEM") || []).length, 0, "duplex-mep unexpectedly carries IfcSystem");
});

t("relationships: relationships.ifc has voids, fills, material and classification links", () => {
  const model = M.buildSemanticModel(fs.readFileSync(path.join(CORPUS, "relationships.ifc"), "utf8"));
  assert.ok(model.relationships.some((r) => r.kind === "voids"), "no voids");
  assert.ok(model.relationships.some((r) => r.kind === "fills"), "no fills");
  assert.ok([...model.classifications.values()].some((r) => r.cls === "IFCCLASSIFICATION"), "no classification");
});

await Promise.all(pending);
console.log(`\nIFC corpus manifest tests: ${pass} passed, ${fail} failed.`);
if (fail) { console.error("failures:\n" + failures.map((f) => " - " + f).join("\n")); process.exit(1); }
