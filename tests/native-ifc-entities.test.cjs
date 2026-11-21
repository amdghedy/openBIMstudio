/**
 * Native IFC entity export — GAP-05 regression tests.
 *
 * Before fix/native-ifc-entities the writer called safeEntityName() and
 * discarded the result, emitting IFCBUILDINGELEMENTPROXY for every element
 * (native-twin-ifc.ts, old lines ~99-100/164). These tests pin the corrected
 * behaviour: the real IFC4 entity per supported type, with the correct
 * per-type attribute arity from the IFC4 schema, a validated PredefinedType,
 * the source Tag, door/window OverallHeight/OverallWidth, valid placements,
 * storey containment, property-set relationships, stable GUIDs, and an
 * explicit (reported, never silent) proxy fallback for unsupported types.
 *
 * What these tests prove (STEP-text level, no parser):
 *   - entity inventory: which IFC entity each twin becomes;
 *   - semantic conversion: arity, PredefinedType, Tag, overall sizes;
 *   - geometry conversion: tessellation vertex/triangle counts in the report.
 * Round-trip fidelity against an independent reader is proven separately by
 * tests/native-ifc-independent-validation.test.cjs (IfcOpenShell), which
 * also proves the geometry kernel can build a shape from each element.
 *
 * Compiles src/modules/export/native-twin-ifc.ts with tsc into a repo-local
 * temp dir (same pattern as tests/ifc-semantics.test.cjs; avoids /tmp).
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(root, ".native-ifc-entities-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
const cleanup = () => fs.rmSync(out, { recursive: true, force: true });

let passed = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Split a STEP argument list at top level (parens + quoted strings respected). */
function splitArgs(inner) {
  const args = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      cur += ch;
      if (ch === "'" && inner[i - 1] !== "\\") inStr = false;
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { args.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur !== "") args.push(cur);
  return args;
}

/** Parse `#id=ENTITY(args);` lines into { id, entity, args }. */
function parseEntities(ifc) {
  const found = [];
  for (const line of ifc.split("\n")) {
    const m = /^#(\d+)=([A-Z0-9]+)\((.*)\);$/.exec(line.trim());
    if (m) found.push({ id: Number(m[1]), entity: m[2], args: splitArgs(m[3]), line: line.trim() });
  }
  return found;
}

function elementByName(ifc, name) {
  const all = parseEntities(ifc);
  const el = all.find((e) => e.args[2] === `'${name}'`);
  assert.ok(el, `no element named '${name}' in export`);
  return { el, all };
}

/** Closed box, 5 (X) x 0.2 (Y) x 3 (Z): 36 vertices, 12 triangles. */
function boxPositions() {
  const v = [[0, 0, 0], [5, 0, 0], [5, 0.2, 0], [0, 0.2, 0], [0, 0, 3], [5, 0, 3], [5, 0.2, 3], [0, 0.2, 3]];
  const tris = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3],
  ];
  const out = [];
  for (const [a, b, c] of tris) out.push(...v[a], ...v[b], ...v[c]);
  return out;
}

const BOX = boxPositions();
function twin(name, extra = {}) {
  return {
    name,
    modelId: "m",
    nativeId: `n-${name}`,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    geometry: { positions: BOX },
    ...extra,
  };
}

async function main() {
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
  assert.ok(typeof W.writeFederatedNativeTwinIfcWithReport === "function", "WithReport API exists");
  assert.ok(typeof W.resolveNativeIfcEntity === "function", "resolver is exported");

  const EIGHT = ["IfcFurnishingElement", "IfcFlowSegment", "IfcFlowTerminal", "IfcFlowFitting", "IfcDistributionElement"];
  const NINE = ["IfcWall", "IfcSlab", "IfcBeam", "IfcColumn", "IfcMember", "IfcPlate", "IfcFooting", "IfcRailing", "IfcStair", "IfcRamp"];

  await t("every supported typed entity emits its own IFC4 entity with correct arity", () => {
    const edits = [
      ...EIGHT.map((e) => twin(e, { nativeEntity: e })),
      ...NINE.map((e) => twin(e, { nativeEntity: e })),
      twin("IfcPile", { nativeEntity: "IfcPile" }),
      twin("IfcDoor", { nativeEntity: "IfcDoor" }),
      twin("IfcWindow", { nativeEntity: "IfcWindow" }),
    ];
    const { ifc, report } = W.writeFederatedNativeTwinIfcWithReport(edits, "Arity");
    assert.strictEqual(report.counts.total, 18, "5 eight-attr + 10 nine-attr + pile + door + window");
    assert.strictEqual(report.counts.typed, 18);
    assert.strictEqual(report.counts.proxied, 0);
    for (const e of EIGHT) {
      const { el } = elementByName(ifc, e);
      assert.strictEqual(el.entity, e.toUpperCase(), `${e} entity`);
      assert.strictEqual(el.args.length, 8, `${e} arity (IfcRoot 4 + ObjectType + Placement + Representation + Tag)`);
    }
    for (const e of NINE) {
      const { el } = elementByName(ifc, e);
      assert.strictEqual(el.entity, e.toUpperCase(), `${e} entity`);
      assert.strictEqual(el.args.length, 9, `${e} arity (+ PredefinedType)`);
      assert.strictEqual(el.args[8], ".NOTDEFINED.", `${e} PredefinedType defaults to .NOTDEFINED.`);
    }
    const pile = elementByName(ifc, "IfcPile").el;
    assert.strictEqual(pile.entity, "IFCPILE");
    assert.strictEqual(pile.args.length, 10, "IfcPile arity (+ PredefinedType + ConstructionType)");
    assert.strictEqual(pile.args[8], ".NOTDEFINED.");
    assert.strictEqual(pile.args[9], ".NOTDEFINED.", "IfcPile ConstructionType .NOTDEFINED. (twins carry none)");
    for (const e of ["IfcDoor", "IfcWindow"]) {
      const { el } = elementByName(ifc, e);
      assert.strictEqual(el.entity, e.toUpperCase());
      assert.strictEqual(el.args.length, 13, `${e} arity`);
      assert.strictEqual(el.args[8], "0.2", `${e} OverallHeight from geometry bbox (Y extent; no dimensions supplied)`);
      assert.strictEqual(el.args[9], "5.", `${e} OverallWidth from geometry bbox (X extent; no dimensions supplied)`);
      assert.strictEqual(el.args[10], ".NOTDEFINED.");
      assert.strictEqual(el.args[11], "$", `${e} OperationType/PartitioningType unknown`);
      assert.strictEqual(el.args[12], "$", `${e} UserDefined type unknown`);
    }
    // Report agrees with the STEP text for every element.
    for (const entry of report.elements) {
      const { el } = elementByName(ifc, entry.name);
      assert.strictEqual(el.entity, entry.emittedEntity.toUpperCase(), `report/STEP agree for ${entry.name}`);
      assert.strictEqual(entry.geometry.vertices, 36, `${entry.name} vertices`);
      assert.strictEqual(entry.geometry.triangles, 12, `${entry.name} triangles`);
      assert.strictEqual(entry.geometry.representation, "tessellation");
      assert.ok(entry.propertySets.includes("Pset_NativeTwinLineage"), `${entry.name} lineage pset`);
    }
  });

  await t("entity labels are matched case-insensitively; WallStandardCase maps to IfcWall", () => {
    const { ifc, report } = W.writeFederatedNativeTwinIfcWithReport([
      twin("A", { nativeEntity: "IFCWALL" }),
      twin("B", { nativeEntity: "IfcWall" }),
      twin("C", { nativeEntity: "Wall" }),
      twin("D", { nativeEntity: "ifcwall" }),
      twin("E", { nativeEntity: "IfcWallStandardCase" }),
      twin("F", { nativeEntity: "IfcWallElementedCase" }),
      twin("G", { sourceEntity: "IFCSLAB" }),
    ], "Cases");
    assert.strictEqual(report.counts.typed, 7, "all seven resolve typed");
    assert.strictEqual(report.counts.proxied, 0);
    for (const n of ["A", "B", "C", "D", "E", "F"]) {
      assert.strictEqual(elementByName(ifc, n).el.entity, "IFCWALL", `${n} is IFCWALL`);
    }
    assert.strictEqual(elementByName(ifc, "G").el.entity, "IFCSLAB", "sourceEntity is used when nativeEntity is absent");
    const std = report.elements.find((e) => e.name === "E");
    assert.ok(std.notes.some((x) => x.includes("IfcWallStandardCase")), "StandardCase mapping is noted, not silent");
    assert.ok(report.elements.every((e) => e.status === "typed"));
  });

  await t("PredefinedType: valid values pass through, invalid/USERDEFINED fall back to .NOTDEFINED. with a note", () => {
    const { ifc, report } = W.writeFederatedNativeTwinIfcWithReport([
      twin("WallStd", { nativeEntity: "IfcWall", predefinedType: "STANDARD" }),
      twin("WallLower", { nativeEntity: "IfcWall", predefinedType: "standard" }),
      twin("SlabRoof", { nativeEntity: "IfcSlab", predefinedType: "ROOF" }),
      twin("DoorGate", { nativeEntity: "IfcDoor", predefinedType: "GATE" }),
      twin("WallBad", { nativeEntity: "IfcWall", predefinedType: "BANANA" }),
      twin("WallUser", { nativeEntity: "IfcWall", predefinedType: "USERDEFINED" }),
      twin("BeamWrongEnum", { nativeEntity: "IfcBeam", predefinedType: "FLOOR" }),
    ], "Predef");
    assert.strictEqual(elementByName(ifc, "WallStd").el.args[8], ".STANDARD.");
    assert.strictEqual(elementByName(ifc, "WallLower").el.args[8], ".STANDARD.", "lowercase enum normalised");
    assert.strictEqual(elementByName(ifc, "SlabRoof").el.args[8], ".ROOF.");
    assert.strictEqual(elementByName(ifc, "DoorGate").el.args[10], ".GATE.");
    assert.strictEqual(elementByName(ifc, "WallBad").el.args[8], ".NOTDEFINED.");
    assert.strictEqual(elementByName(ifc, "WallUser").el.args[8], ".NOTDEFINED.", "USERDEFINED without ObjectType must not be emitted");
    assert.strictEqual(elementByName(ifc, "BeamWrongEnum").el.args[8], ".NOTDEFINED.", "FLOOR is not a beam enum value");
    const bad = report.elements.find((e) => e.name === "WallBad");
    assert.ok(bad.notes.some((x) => x.includes("BANANA")), "invalid enum recorded in the report");
    const user = report.elements.find((e) => e.name === "WallUser");
    assert.ok(user.notes.some((x) => x.includes("USERDEFINED")), "USERDEFINED downgrade recorded");
    assert.ok(report.elements.every((e) => e.status === "typed"), "enum problems never demote a supported type to proxy");
  });

  await t("door/window OverallHeight/OverallWidth: overrides > dimensions > geometry bbox > omitted", () => {
    const { ifc, report } = W.writeFederatedNativeTwinIfcWithReport([
      twin("DoorDims", { nativeEntity: "IfcDoor", dimensions: { width: 0.9, height: 2.1, depth: 0.05 } }),
      twin("DoorOverride", { nativeEntity: "IfcDoor", dimensions: { width: 0.9, height: 2.1, depth: 0.05 }, overrides: { OverallHeight: 2.4, OverallWidth: 1.0 } }),
      twin("WindowBbox", { nativeEntity: "IfcWindow" }),
      twin("DoorNoGeom", { nativeEntity: "IfcDoor", geometry: {} }),
    ], "Sizes");
    const dims = elementByName(ifc, "DoorDims").el;
    assert.strictEqual(dims.args[8], "2.1", "OverallHeight from dimensions");
    assert.strictEqual(dims.args[9], "0.9", "OverallWidth from dimensions");
    const over = elementByName(ifc, "DoorOverride").el;
    assert.strictEqual(over.args[8], "2.4", "override wins over dimensions (height)");
    assert.strictEqual(over.args[9], "1.", "override wins over dimensions (width, REAL literal)");
    const bbox = elementByName(ifc, "WindowBbox").el;
    assert.strictEqual(bbox.args[8], "0.2", "OverallHeight from geometry bbox (Y extent)");
    assert.strictEqual(bbox.args[9], "5.", "OverallWidth from geometry bbox (X extent)");
    const noGeom = elementByName(ifc, "DoorNoGeom").el;
    assert.strictEqual(noGeom.args[8], "$", "no size source -> OverallHeight omitted, not invented");
    assert.strictEqual(noGeom.args[9], "$");
    const winEntry = report.elements.find((e) => e.name === "WindowBbox");
    assert.strictEqual(winEntry.overallHeight, 0.2);
    assert.strictEqual(winEntry.overallWidth, 5);
    assert.ok(winEntry.notes.some((x) => x.includes("bounding box")), "bbox derivation is disclosed in the report");
  });

  await t("Tag: tag and sourceTag are emitted, absent tag is $", () => {
    const { ifc, report } = W.writeFederatedNativeTwinIfcWithReport([
      twin("Tagged", { nativeEntity: "IfcWall", tag: "W-01" }),
      twin("SourceTagged", { nativeEntity: "IfcWall", sourceTag: "W-02" }),
      twin("Untagged", { nativeEntity: "IfcWall" }),
    ], "Tags");
    assert.strictEqual(elementByName(ifc, "Tagged").el.args[7], "'W-01'");
    assert.strictEqual(elementByName(ifc, "SourceTagged").el.args[7], "'W-02'", "FragEdit.sourceTag flows through");
    assert.strictEqual(elementByName(ifc, "Untagged").el.args[7], "$");
    assert.strictEqual(report.elements[0].tag, "W-01");
    assert.strictEqual(report.elements[2].tag, null);
  });

  await t("unsupported types fall back to proxy explicitly, with a reason in the report", () => {
    const { ifc, report } = W.writeFederatedNativeTwinIfcWithReport([
      twin("Space", { nativeEntity: "IfcSpace" }),
      twin("Roof", { nativeEntity: "IfcRoof" }),
      twin("Curtain", { nativeEntity: "IfcCurtainWall" }),
      twin("Bogus", { nativeEntity: "IfcFooBar" }),
      twin("AlreadyProxy", { nativeEntity: "IfcBuildingElementProxy" }),
      twin("NoEntity", {}),
      twin("WallOk", { nativeEntity: "IfcWall" }),
    ], "Fallback");
    assert.strictEqual(report.counts.total, 7);
    assert.strictEqual(report.counts.typed, 1);
    assert.strictEqual(report.counts.proxied, 6);
    for (const n of ["Space", "Roof", "Curtain", "Bogus", "AlreadyProxy", "NoEntity"]) {
      const { el } = elementByName(ifc, n);
      assert.strictEqual(el.entity, "IFCBUILDINGELEMENTPROXY", `${n} is an explicit proxy`);
      assert.strictEqual(el.args.length, 9, "proxy arity unchanged");
      assert.strictEqual(el.args[8], ".NOTDEFINED.");
      const entry = report.elements.find((e) => e.name === n);
      assert.strictEqual(entry.status, "proxied");
      assert.ok(entry.fallbackReason && entry.fallbackReason.length > 0, `${n} fallback reason recorded`);
      assert.ok(entry.notes.some((x) => x.includes("IfcBuildingElementProxy")), `${n} fallback noted`);
    }
    assert.ok(report.elements.find((e) => e.name === "Space").fallbackReason.includes("IfcSpace"));
    assert.ok(report.elements.find((e) => e.name === "NoEntity").fallbackReason.includes("no entity information"));
    assert.ok(report.elements.find((e) => e.name === "AlreadyProxy").fallbackReason.includes("already IfcBuildingElementProxy"));
    assert.strictEqual(elementByName(ifc, "WallOk").el.entity, "IFCWALL");
  });

  await t("GUIDs: valid source GUID preserved, junk replaced, element GUID stable across exports", () => {
    const edit = twin("Stable", { nativeEntity: "IfcWall", nativeId: "n-stable", sourceGlobalId: "0XScRe4drE$QuCcyMkXutA" });
    const a = W.writeFederatedNativeTwinIfcWithReport([edit], "G1");
    const b = W.writeFederatedNativeTwinIfcWithReport([edit], "G1");
    assert.strictEqual(a.report.elements[0].globalId, "0XScRe4drE$QuCcyMkXutA", "valid source GUID kept");
    assert.strictEqual(b.report.elements[0].globalId, "0XScRe4drE$QuCcyMkXutA", "stable across exports");
    const junk = W.writeFederatedNativeTwinIfcWithReport(
      [twin("Junk", { nativeEntity: "IfcWall", nativeId: "n-junk", sourceGlobalId: "NOT-A-GUID!!" })], "G2");
    const junkEl = elementByName(junk.ifc, "Junk").el;
    assert.notStrictEqual(junkEl.args[0], "'NOT-A-GUID!!'", "junk GUID never emitted as the element GlobalId");
    // The raw source value is still recorded as provenance in Pset_NativeTwinLineage (SourceGlobalId label), not as a GlobalId.
    assert.match(junk.report.elements[0].globalId, /^[0-9A-Za-z_$]{22}$/, "replacement GUID is valid 22-char base64");
    const again = W.writeFederatedNativeTwinIfcWithReport(
      [twin("Junk", { nativeEntity: "IfcWall", nativeId: "n-junk", sourceGlobalId: "NOT-A-GUID!!" })], "G2");
    assert.strictEqual(junk.report.elements[0].globalId, again.report.elements[0].globalId, "derived GUID is deterministic");
  });

  await t("placements: non-finite/degenerate repaired and reported; non-unit quaternions normalised", () => {
    const s = Math.SQRT1_2;
    const { ifc, report } = W.writeFederatedNativeTwinIfcWithReport([
      twin("BadPos", { nativeEntity: "IfcWall", position: [NaN, 0, 0] }),
      twin("ZeroQuat", { nativeEntity: "IfcWall", position: [1, 2, 3], quaternion: [0, 0, 0, 0] }),
      twin("ScaledQuat", { nativeEntity: "IfcWall", position: [0, 0, 0], quaternion: [0, 0, 0, 2] }),
      twin("RotatedZ", { nativeEntity: "IfcWall", position: [0, 0, 0], quaternion: [0, 0, s, s] }),
    ], "Place");
    const bad = report.elements.find((e) => e.name === "BadPos");
    assert.strictEqual(bad.placementValid, false);
    assert.ok(bad.notes.some((x) => x.includes("non-finite position")));
    const badEl = elementByName(ifc, "BadPos").el;
    const badPlaceId = Number(badEl.args[5].slice(1));
    const badPlace = parseEntities(ifc).find((e) => e.id === badPlaceId);
    assert.ok(badPlace, "placement exists for repaired element");
    const zero = report.elements.find((e) => e.name === "ZeroQuat");
    assert.strictEqual(zero.placementValid, false);
    assert.ok(zero.notes.some((x) => x.includes("zero-norm")));
    const scaled = elementByName(ifc, "ScaledQuat").el;
    assert.ok(report.elements.find((e) => e.name === "ScaledQuat").placementValid, "non-unit (but valid) quaternion normalises cleanly");
    assert.ok(ifc.includes("IFCDIRECTION((0.,0.,1.))"), "normalised identity rotation emits unit Z direction");
    // 90-degree rotation about Z: local X axis must map to world +Y.
    const rotEl = elementByName(ifc, "RotatedZ").el;
    const rotPlaceId = Number(rotEl.args[5].slice(1));
    const rotPlace = parseEntities(ifc).find((e) => e.id === rotPlaceId);
    const axisId = Number(rotPlace.args[1].slice(1));
    const axis = parseEntities(ifc).find((e) => e.id === axisId);
    const refDirId = Number(axis.args[2].slice(1));
    const refDir = parseEntities(ifc).find((e) => e.id === refDirId);
    assert.deepStrictEqual(refDir.args[0], "(0.,1.,0.)", "local X maps to world +Y after 90-degree Z rotation");
  });

  await t("STEP REAL literals: no integer-valued direction or coordinate is emitted", () => {
    const { ifc } = W.writeFederatedNativeTwinIfcWithReport(
      [twin("Wall", { nativeEntity: "IfcWall", position: [1, 2, 3] })], "Reals");
    // Every number inside IFCDIRECTION / IFCCARTESIANPOINT must carry a decimal point.
    for (const line of ifc.split("\n")) {
      if (/^#\d+=IFC(DIRECTION|CARTESIANPOINT)\(/.test(line)) {
        const body = line.slice(line.indexOf("=") + 1); // skip the "#id" prefix (its digits are not literals)
        const nums = body.match(/-?\d+(\.\d*)?/g) || [];
        for (const n of nums) assert.ok(n.includes("."), `${line.trim()} contains integer literal ${n}`);
      }
    }
    assert.ok(!/IFCDIRECTION\(\(0,0,1\)\)/.test(ifc), "integer direction ratios are gone (they broke IfcOpenShell shape creation)");
  });

  await t("non-finite geometry emits no representation and is reported", () => {
    const { ifc, report } = W.writeFederatedNativeTwinIfcWithReport([
      twin("BadGeom", { nativeEntity: "IfcWall", geometry: { positions: [0, 0, 0, NaN, 0, 0, 0, 1, 0] } }),
      twin("NoGeom", { nativeEntity: "IfcWall", geometry: {} }),
    ], "Geom");
    for (const n of ["BadGeom", "NoGeom"]) {
      const entry = report.elements.find((e) => e.name === n);
      assert.strictEqual(entry.geometry.representation, "none");
      assert.strictEqual(entry.geometry.triangles, 0);
      assert.strictEqual(elementByName(ifc, n).el.args[6], "$", `${n} Representation is $`);
    }
    assert.ok(report.elements.find((e) => e.name === "BadGeom").notes.some((x) => x.includes("non-finite geometry")));
    assert.strictEqual(report.counts.typed, 2, "missing geometry never demotes a supported type");
  });

  await t("property sets: source psets + overrides + lineage are attached via RelDefinesByProperties", () => {
    const { ifc, report } = W.writeFederatedNativeTwinIfcWithReport([
      twin("WallPsets", {
        nativeEntity: "IfcWall",
        propertySets: { Pset_WallCommon: { IsExternal: true, LoadBearing: false, FireRating: "F60" } },
        overrides: { Comment: "moved 1m east" },
      }),
    ], "Psets");
    const { el, all } = elementByName(ifc, "WallPsets");
    assert.ok(ifc.includes("IFCPROPERTYSET(") && ifc.includes("'Pset_WallCommon'"), "source pset emitted");
    assert.ok(ifc.includes("'NativeOverrides'"), "overrides pset emitted");
    assert.ok(ifc.includes("'Pset_NativeTwinLineage'"), "lineage pset emitted");
    assert.ok(ifc.includes("IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$)"), "boolean property typed");
    assert.ok(ifc.includes("IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('F60'),$)"), "label property typed");
    const rels = all.filter((e) => e.entity === "IFCRELDEFINESBYPROPERTIES");
    const mine = rels.filter((r) => r.args[4] === `(#${el.id})`);
    assert.strictEqual(mine.length, 3, "one RelDefinesByProperties per attached pset");
    const entry = report.elements[0];
    assert.deepStrictEqual([...entry.propertySets].sort(), ["NativeOverrides", "Pset_NativeTwinLineage", "Pset_WallCommon"]);
  });

  await t("spatial containment: one storey, each element contained exactly once in it", () => {
    const { ifc } = W.writeFederatedNativeTwinIfcWithReport([
      twin("W1", { nativeEntity: "IfcWall" }),
      twin("W2", { nativeEntity: "IfcSlab" }),
      twin("W3", { nativeEntity: "IfcSpace" }),
    ], "Contain");
    const all = parseEntities(ifc);
    const storeys = all.filter((e) => e.entity === "IFCBUILDINGSTOREY");
    assert.strictEqual(storeys.length, 1, "single storey");
    assert.strictEqual(all.filter((e) => e.entity === "IFCPROJECT").length, 1, "single project");
    const contained = all.filter((e) => e.entity === "IFCRELCONTAINEDINSPATIALSTRUCTURE");
    assert.strictEqual(contained.length, 3, "one containment rel per element");
    for (const c of contained) {
      assert.strictEqual(c.args[5], `#${storeys[0].id}`, "contained in the storey");
      assert.match(c.args[4], /^\(#\d+\)$/, "exactly one element per containment rel");
    }
  });

  await t("async writer emits the same typed entities as the sync writer", async () => {
    const edits = [
      twin("AWall", { nativeEntity: "IfcWall" }),
      twin("ADoor", { nativeEntity: "IfcDoor", dimensions: { width: 1, height: 2.2, depth: 0.1 } }),
      twin("ASpace", { nativeEntity: "IfcSpace" }),
    ];
    const sync = W.writeFederatedNativeTwinIfc(edits, "Async");
    const asyncText = await W.writeFederatedNativeTwinIfcAsync(edits, "Async", { yieldEvery: 1 });
    const syncEls = parseEntities(sync).filter((e) => /^(IFCWALL|IFCDOOR|IFCBUILDINGELEMENTPROXY)$/.test(e.entity));
    const asyncEls = parseEntities(asyncText).filter((e) => /^(IFCWALL|IFCDOOR|IFCBUILDINGELEMENTPROXY)$/.test(e.entity));
    assert.deepStrictEqual(asyncEls.map((e) => e.entity), syncEls.map((e) => e.entity), "same entity sequence");
    const door = asyncEls.find((e) => e.entity === "IFCDOOR");
    assert.strictEqual(door.args[8], "2.2");
    assert.strictEqual(door.args[9], "1.");
  });

  await t("empty export throws", () => {
    assert.throws(() => W.writeFederatedNativeTwinIfc([], "Empty"), /No Native Twins/);
    assert.throws(() => W.writeFederatedNativeTwinIfcWithReport([], "Empty"), /No Native Twins/);
  });

  await t("resolveNativeIfcEntity is pure and covers the full mapping table", () => {
    for (const [name, spec] of Object.entries(W.NATIVE_IFC_ENTITY_MAP)) {
      const r = W.resolveNativeIfcEntity({ nativeEntity: name, modelId: "m", position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
      assert.strictEqual(r.entity, name, `${name} resolves to itself`);
      assert.strictEqual(r.status, "typed");
      assert.strictEqual(r.fallbackReason, null);
      assert.strictEqual(r.predefinedType, spec.predefinedTypeEnum ? "NOTDEFINED" : null);
    }
    assert.strictEqual(Object.keys(W.NATIVE_IFC_ENTITY_MAP).length, 18, "18 genuinely supported typed entities");
  });

  if (failures.length) {
    console.error(`native-ifc-entities: ${passed} passed, ${failures.length} failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(`native-ifc-entities.test.cjs: ${passed} passed`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(cleanup);
