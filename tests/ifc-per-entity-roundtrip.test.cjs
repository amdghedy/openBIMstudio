/**
 * tests/ifc-per-entity-roundtrip.test.cjs
 *
 * Round-trip fidelity test (#106): import → export → re-import, with the
 * per-entity report as the measurement instrument.
 *
 *   import  generated-small.ifc through the semantic model (9 products);
 *   export  its 5 physical products through the REAL native-twin writer
 *           (src/modules/export/native-twin-ifc.ts, main behaviour);
 *   re-import the exported text through the semantic model AND through
 *           web-ifc 0.0.77 (Node API, the application's own import parser).
 *
 * What is asserted (invariants, not fixed outcomes — the test must stay
 * green when the §5 typed-entity fix lands and the numbers improve):
 *   - every export row's emitted type equals the type an independent
 *     re-parse finds for the same GlobalId (the report tells the truth
 *     about the exported text, whatever the writer did);
 *   - every proxied row is flagged proxyFallback + PROXY_FALLBACK
 *     (the fallback is reported, never hidden);
 *   - every emitted type survives the re-import (typeSurvival all true);
 *   - geometry and property sets survive the twin round-trip;
 *   - web-ifc sees the same per-entity types/GlobalIds as the report
 *     (when web-ifc is installed; skipped gracefully otherwise, like the
 *     §5 independent-validation test skips without IfcOpenShell).
 *
 * What is NOT asserted: a fixed preserved/proxied count. The twin writer
 * used to emit IfcBuildingElementProxy for every element (native-twin-ifc.ts
 * discarded safeEntityName()'s result); fix/native-ifc-entities (#246,
 * main eabab92) made it emit typed entities, and the measured count on
 * eabab92 is 1/5 sources proxied. The count is printed and recorded in
 * docs/engineering/PER_ENTITY_IFC_REPORT.md, not pinned here — pinning it
 * would break the moment the writer improves again.
 *
 * Run: `node tests/ifc-per-entity-roundtrip.test.cjs`
 */

const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-per-entity-rt-"));
execSync(
  `npx tsc src/modules/ifc-semantics/index.ts src/modules/ifc-semantics/per-entity-report.ts ` +
  `src/modules/export/native-twin-ifc.ts --outDir ${out} --rootDir src ` +
  `--module commonjs --target es2020 --lib es2020,dom --skipLibCheck --strict --ignoreDeprecations 5.0`,
  { cwd: root, stdio: "inherit" },
);
const sem = require(path.join(out, "modules", "ifc-semantics", "index.js"));
const perEntity = require(path.join(out, "modules", "ifc-semantics", "per-entity-report.js"));
const twin = require(path.join(out, "modules", "export", "native-twin-ifc.js"));

const CORPUS = path.join(__dirname, "fixtures", "ifc-corpus");
const read = (rel) => fs.readFileSync(path.join(CORPUS, rel), "utf8");

let passed = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passed++; console.log("  PASS " + name); }
  catch (e) { failures.push(name + ": " + (e instanceof Error ? e.message : String(e))); console.log("  FAIL " + name + ": " + (e instanceof Error ? e.message : String(e))); }
}

/** Non-indexed unit-box triangle soup: 12 triangles, 36 vertices. */
function boxPositions() {
  const c = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const tris = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [2, 6, 7], [2, 7, 3],
    [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2],
  ];
  return tris.flatMap((tri) => tri.flatMap((i) => c[i]));
}

/** web-ifc version: package.json is not in its `exports` map, so walk up from the resolved entry. */
function webIfcVersion() {
  let dir = path.dirname(require.resolve("web-ifc"));
  while (dir !== path.parse(dir).root) {
    const p = path.join(dir, "package.json");
    if (fs.existsSync(p)) {
      try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (j.name === "web-ifc") return j.version;
      } catch { /* keep walking */ }
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}

/** web-ifc per-entity enumeration: GlobalId → type, for product classes. */
async function webIfcProducts(bytes) {
  const { IfcAPI } = require("web-ifc");
  const W = require("web-ifc");
  const version = webIfcVersion();
  const api = new IfcAPI();
  await api.Init();
  const model = api.OpenModel(bytes, {});
  try {
    const byGuid = new Map();
    const TYPE_IDS = Object.entries(W).filter(
      ([k, v]) => typeof v === "number" && /^IFC[A-Z0-9_]+$/.test(k),
    );
    for (const [name, id] of TYPE_IDS) {
      const lines = api.GetLineIDsWithType(model, id);
      if (lines.size() === 0) continue;
      for (const lineId of lines) {
        const props = api.GetLine(model, lineId);
        const gid = props?.GlobalId?.value ?? null;
        if (gid) byGuid.set(gid, name);
      }
    }
    return { version, byGuid };
  } finally {
    api.CloseModel(model);
  }
}

async function main() {
  const sourceText = read("generated-small.ifc");
  const importReport = perEntity.buildImportFidelityReportFromText("generated-small.ifc", sourceText);
  assert.ok(importReport, "import report missing");
  assert.strictEqual(importReport.totalProducts, 9);

  // Physical products only — the twin writer exports physical twins, not
  // the spatial skeleton (it writes its own).
  const physical = importReport.rows.filter(
    (r) => !["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE"].includes(r.ifcType),
  );
  assert.strictEqual(physical.length, 5, "expected 5 physical products: " + physical.map((r) => r.ifcType).join(","));

  // Reconstruct source psets from the semantic model (label/real/integer/
  // boolean values only — the writer only emits those).
  const model = sem.buildSemanticModel(sourceText);
  const psetsByHost = new Map();
  for (const ps of model.psets.values()) {
    for (const host of ps.hosts) {
      const props = {};
      for (const p of ps.props) {
        const v = p.value;
        if (v.type === "label" || v.type === "real" || v.type === "integer" || v.type === "boolean") {
          if (v.value !== null) props[p.name] = v.value;
        }
      }
      if (Object.keys(props).length > 0) {
        const arr = psetsByHost.get(host) ?? [];
        arr.push({ name: ps.name, props });
        psetsByHost.set(host, arr);
      }
    }
  }

  const twins = [];
  const sources = [];
  physical.forEach((row, i) => {
    const hostPsets = psetsByHost.get(row.expressId) ?? [];
    const propertySets = {};
    for (const ps of hostPsets) propertySets[ps.name] = ps.props;
    twins.push({
      name: row.name ?? row.ifcType,
      modelId: "per-entity-roundtrip",
      position: [1.5 + i, 2.5, 3.5],
      quaternion: [0, 0, 0, 1],
      nativeEntity: row.ifcType,
      sourceEntity: row.ifcType,
      sourceGlobalId: row.globalId,
      propertySets,
      geometry: { positions: boxPositions() },
    });
    sources.push({
      globalId: row.globalId,
      name: row.name ?? undefined,
      sourceType: row.ifcType,
      propertySets: hostPsets.map((ps) => ps.name),
      hasGeometry: true,
    });
  });

  const exported = twin.writeFederatedNativeTwinIfc(twins, "Per-entity round-trip");
  assert.ok(exported.includes("FILE_SCHEMA(('IFC4'))"), "exported text is not IFC4 STEP");
  fs.writeFileSync(path.join(out, "roundtrip-export.ifc"), exported);

  const rt = perEntity.buildRoundTripReport(sources, exported);

  await t("round-trip: all 5 sources emitted, matched by GlobalId, none failed", () => {
    assert.strictEqual(rt.export.sourceCount, 5);
    assert.strictEqual(rt.export.totals.failed, 0, JSON.stringify(rt.export.rows, null, 2));
    for (const r of rt.export.rows) {
      assert.strictEqual(r.matchedBy, "globalId", JSON.stringify(r));
      assert.ok(r.emittedType, "emitted type missing for " + r.sourceType);
    }
  });

  await t("round-trip: report agrees with an independent re-parse per GlobalId", () => {
    assert.ok(rt.reimport, "re-import report missing");
    // 5 twins + the writer's own 4-node spatial skeleton.
    assert.strictEqual(rt.reimport.totalProducts, 9, `reimport products=${rt.reimport.totalProducts}`);
    for (const row of rt.export.rows) {
      const re = rt.reimport.rows.find((r) => r.globalId === row.sourceGlobalId);
      assert.ok(re, "re-import has no row for " + row.sourceGlobalId);
      assert.strictEqual(
        perEntity.normaliseIfcType(re.ifcType),
        perEntity.normaliseIfcType(row.emittedType),
        `report says ${row.emittedType} but re-parse finds ${re.ifcType} for ${row.sourceGlobalId}`,
      );
    }
  });

  await t("round-trip: every emitted type survives the re-import", () => {
    assert.strictEqual(rt.typeSurvival.length, 5);
    for (const s of rt.typeSurvival) {
      assert.strictEqual(s.survived, true, JSON.stringify(s));
    }
  });

  await t("round-trip: every proxied row is flagged + reasoned, never hidden", () => {
    const proxied = rt.export.rows.filter((r) => r.proxyFallback);
    console.log(`    measured on main: ${proxied.length}/${rt.export.rows.length} sources proxied`);
    for (const r of rt.export.rows) {
      const isProxy = perEntity.normaliseIfcType(r.emittedType) === "BUILDINGELEMENTPROXY"
        && perEntity.normaliseIfcType(r.sourceType) !== "BUILDINGELEMENTPROXY";
      assert.strictEqual(r.proxyFallback, isProxy, JSON.stringify(r));
      if (isProxy) {
        assert.ok(r.reasonCodes.includes("PROXY_FALLBACK"), JSON.stringify(r));
        assert.strictEqual(r.status, "approximated", JSON.stringify(r));
      }
    }
    // The report must never claim a row preserved while its type changed.
    for (const r of rt.export.rows) {
      if (r.status === "preserved") {
        assert.strictEqual(perEntity.normaliseIfcType(r.emittedType), perEntity.normaliseIfcType(r.sourceType));
      }
    }
  });

  await t("round-trip: geometry and property sets survive the twin export", () => {
    for (const r of rt.export.rows) {
      assert.strictEqual(r.geometrySurvived, true, JSON.stringify(r));
      assert.deepStrictEqual(r.propertySetsLost, [], JSON.stringify(r));
    }
  });

  await t("round-trip: web-ifc 0.0.77 sees the same per-entity types/GlobalIds", async () => {
    let webIfc;
    try {
      webIfc = await webIfcProducts(new Uint8Array(Buffer.from(sourceText, "latin1")));
    } catch (e) {
      if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(e && e.message))) {
        console.log("    SKIP web-ifc leg: web-ifc not installed");
        return;
      }
      throw e;
    }
    console.log(`    web-ifc ${webIfc.version}: source fixture enumerated`);
    for (const row of importReport.rows) {
      assert.strictEqual(
        webIfc.byGuid.get(row.globalId), row.ifcType,
        `web-ifc disagrees on ${row.globalId}: report ${row.ifcType}`,
      );
    }
    const exportedWeb = await webIfcProducts(new Uint8Array(Buffer.from(exported, "latin1")));
    for (const row of rt.export.rows) {
      assert.strictEqual(
        exportedWeb.byGuid.get(row.sourceGlobalId), row.emittedType,
        `web-ifc disagrees on exported ${row.sourceGlobalId}: report ${row.emittedType}`,
      );
    }
    console.log(`    web-ifc ${exportedWeb.version}: exported file enumerated, ${exportedWeb.byGuid.size} GlobalIds`);
  });

  await t("round-trip: import report carries the scope caveat", () => {
    assert.ok(/Not a per-entity web-ifc FRAG-conversion claim/.test(importReport.scope));
  });

  if (failures.length) {
    console.log(`=== ifc-per-entity-roundtrip tests complete: ${passed} passed, ${failures.length} failed ===`);
    process.exit(1);
  }
  console.log(`=== ifc-per-entity-roundtrip tests complete: ${passed} passed, 0 failed ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
