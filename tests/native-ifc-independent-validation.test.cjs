/**
 * Independent external-parser validation of Native Twin IFC export.
 *
 * Every other native-twin test in this repository reads files back with code
 * from THIS repository (the STEP-text assertions in
 * tests/native-ifc-entities.test.cjs, or the in-repo semantic parser in
 * tests/ifc-semantics.test.cjs). That proves internal coherence only. This
 * test is different: it validates through IfcOpenShell
 * (https://ifcopenshell.org), an independent IFC implementation that shares
 * no code with the openBIMstudio writer, its in-repo parser, or web-ifc.
 *
 * What passing means here (see scripts/validate_native_ifc_export.py):
 *   - a mixed export of all 18 genuinely supported typed entities plus one
 *     explicit proxy fallback parses as IFC4 in a third-party reader;
 *   - every element is present with the expected IFC entity type (not
 *     silently downgraded to IfcBuildingElementProxy);
 *   - every element has a valid 22-char GlobalId, a valid local placement
 *     at the exported position, a Body tessellation representation, and
 *     exactly one spatial containment (to the storey);
 *   - every property set is attached via IfcRelDefinesByProperties;
 *   - door/window OverallHeight/OverallWidth are positive and match the
 *     exported dimensions;
 *   - the IfcOpenShell geometry kernel builds a real shape from EVERY
 *     element (this caught a real writer defect: integer-valued
 *     IfcDirection ratios — "0" instead of "0." — made shape creation fail
 *     with "Unexpected topology" even though the file parsed).
 *   - the writer's own conversion report agrees with the independent
 *     reader's entity inventory (typed/proxied counts, per-element types).
 *
 * What passing does NOT mean (honesty rules):
 *   - it is NOT proof that a desktop BIM tool (Revit/ArchiCAD/etc.) opens
 *     these files - no desktop tool was run here;
 *   - it does NOT validate openings/fills relationships for doors/windows
 *     (the twin writer deliberately emits none - see
 *     docs/engineering/NATIVE_IFC_ENTITY_EXPORT.md).
 *
 * Runs IfcOpenShell via scripts/validate_native_ifc_export.py. Skips
 * (exit 0) when python3/ifcopenshell is unavailable; CI installs it
 * (see .github/workflows/unit-tests.yml, next to the ezdxf install).
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { execSync, spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const VALIDATOR = path.join(root, "scripts", "validate_native_ifc_export.py");

// 0. IfcOpenShell available? (pip install ifcopenshell). CI installs it; local dev may not.
const probe = spawnSync("python3", ["-c", "import ifcopenshell"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.log("SKIP: python3 ifcopenshell not available - the independent native-IFC validation needs `pip install ifcopenshell`");
  process.exit(0);
}

const out = fs.mkdtempSync(path.join(root, ".native-ifc-independent-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
const cleanup = () => fs.rmSync(out, { recursive: true, force: true });

/** Closed box, 5 (X) x 0.2 (Y) x 3 (Z): 36 vertices, 12 triangles. */
function boxPositions() {
  const v = [[0, 0, 0], [5, 0, 0], [5, 0.2, 0], [0, 0.2, 0], [0, 0, 3], [5, 0, 3], [5, 0.2, 3], [0, 0.2, 3]];
  const tris = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3],
  ];
  const positions = [];
  for (const [a, b, c] of tris) positions.push(...v[a], ...v[b], ...v[c]);
  return positions;
}

try {
  execSync(
    `npx tsc src/modules/export/native-twin-ifc.ts src/modules/bim-gaps/ifc-guid.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --lib es2020,dom`,
    { cwd: root, stdio: "pipe" },
  );
  const find = (d, n) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { const r = find(p, n); if (r) return r; }
      else if (f.name === n) return p;
    }
    return null;
  };
  const W = require(find(out, "native-twin-ifc.js"));
  const BOX = boxPositions();

  // 1. Mixed export: all 18 supported typed entities + one explicit proxy fallback.
  const typedNames = Object.keys(W.NATIVE_IFC_ENTITY_MAP);
  assert.strictEqual(typedNames.length, 18, "mapping table under test has 18 typed entities");
  const edits = typedNames.map((entity, i) => ({
    name: entity,
    nativeEntity: entity,
    modelId: "m",
    nativeId: `n-${entity}`,
    position: [i * 10, 0, 0],
    quaternion: [0, 0, 0, 1],
    geometry: { positions: BOX },
    ...(entity === "IfcDoor" ? { dimensions: { width: 0.9, height: 2.1, depth: 0.05 } } : {}),
    ...(entity === "IfcWall" ? { predefinedType: "STANDARD", sourceTag: "W-01", propertySets: { Pset_WallCommon: { IsExternal: true, LoadBearing: true } } } : {}),
  }));
  edits.push({
    name: "IfcSpace", nativeEntity: "IfcSpace", modelId: "m", nativeId: "n-space",
    position: [999, 0, 0], quaternion: [0, 0, 0, 1], geometry: { positions: BOX },
  });
  const { ifc, report } = W.writeFederatedNativeTwinIfcWithReport(edits, "IndependentValidation");
  assert.strictEqual(report.counts.total, 19);
  assert.strictEqual(report.counts.typed, 18);
  assert.strictEqual(report.counts.proxied, 1);

  const ifcPath = path.join(out, "mixed.ifc");
  fs.writeFileSync(ifcPath, ifc);
  const expect = {};
  // Validator counts by IFC entity name (e.g. IfcWall); the map keys already are those.
  for (const name of typedNames) expect[name] = 1;
  expect.IfcBuildingElementProxy = 1;
  const expectPath = path.join(out, "expect.json");
  fs.writeFileSync(expectPath, JSON.stringify(expect));

  // 2. Independent validation (IfcOpenShell). Exit non-zero on any error.
  const run = spawnSync("python3", [VALIDATOR, ifcPath, "--expect", expectPath], { encoding: "utf8" });
  assert.ok(run.stdout, "validator produced output");
  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    console.error(run.stdout, run.stderr);
    assert.fail("validator output was not JSON");
  }
  assert.strictEqual(result.schema, "IFC4", "independent reader sees IFC4");
  assert.ok(result.validator.startsWith("IfcOpenShell "), `validated by ${result.validator}`);
  assert.deepStrictEqual(result.errors, [], `independent validation errors: ${JSON.stringify(result.errors)}`);
  assert.strictEqual(run.status, 0, "validator exit code 0");
  assert.strictEqual(result.totalElements, 19, "independent reader finds all 19 elements");

  // 3. Writer report and independent reader agree, element by element.
  assert.deepStrictEqual(
    Object.keys(result.counts).sort(),
    [...typedNames, "IfcBuildingElementProxy"].sort(),
    "independent reader inventory matches the mapping table + fallback",
  );
  const byName = new Map(result.elements.map((e) => [e.name, e]));
  for (const entry of report.elements) {
    const seen = byName.get(entry.name);
    assert.ok(seen, `independent reader found ${entry.name}`);
    assert.strictEqual(seen.type, entry.emittedEntity, `${entry.name}: reader type matches writer report`);
    assert.strictEqual(seen.globalId, entry.globalId, `${entry.name}: GlobalId matches`);
    assert.strictEqual(seen.predefinedType, entry.predefinedType, `${entry.name}: PredefinedType matches`);
    assert.strictEqual(seen.tag, entry.tag, `${entry.name}: Tag matches`);
    assert.deepStrictEqual(seen.placement, [entry.name === "IfcSpace" ? 999 : typedNames.indexOf(entry.emittedEntity) * 10, 0, 0],
      `${entry.name}: placement matches the exported position`);
    assert.strictEqual(seen.representation, "Tessellation", `${entry.name}: Body tessellation`);
    assert.strictEqual(seen.vertices, 36, `${entry.name}: 36 vertices`);
    assert.strictEqual(seen.triangles, 12, `${entry.name}: 12 triangles`);
    assert.strictEqual(seen.containedIn, "IfcBuildingStorey", `${entry.name}: contained in the storey`);
    assert.ok(seen.propertySets.includes("Pset_NativeTwinLineage"), `${entry.name}: lineage pset attached`);
    // Geometry conversion is real: the independent kernel builds a shape from every element.
    assert.strictEqual(seen.shapeOk, true, `${entry.name}: IfcOpenShell geometry kernel builds a shape (shapeError: ${seen.shapeError})`);
  }
  const wall = byName.get("IfcWall");
  assert.strictEqual(wall.predefinedType, "STANDARD");
  assert.strictEqual(wall.tag, "W-01");
  assert.ok(wall.propertySets.includes("Pset_WallCommon"), "source Pset_WallCommon attached");
  assert.strictEqual(wall.lineage.SourceEntity, "IfcWall", "lineage records the source entity");
  const door = byName.get("IfcDoor");
  assert.strictEqual(door.overall.OverallHeight, 2.1);
  assert.strictEqual(door.overall.OverallWidth, 0.9);
  const window = byName.get("IfcWindow");
  assert.strictEqual(window.overall.OverallHeight, 0.2, "window height from geometry bbox (Y extent)");
  assert.strictEqual(window.overall.OverallWidth, 5, "window width from geometry bbox (X extent)");
  const space = byName.get("IfcSpace");
  assert.strictEqual(space.type, "IfcBuildingElementProxy", "unsupported IfcSpace is an explicit proxy in the independent reader too");

  console.log(
    `native-ifc-independent-validation.test.cjs: ok (${result.validator}, 19 elements: 18 typed + 1 proxy, ` +
    `all placements/containments/psets verified, all ${result.elements.length} kernel shapes built)`,
  );
  cleanup();
} catch (e) {
  cleanup();
  console.error(e);
  process.exit(1);
}
