/**
 * tests/ifc-per-entity-report.test.cjs
 *
 * Unit tests for the per-entity IFC fidelity report (#106,
 * src/modules/ifc-semantics/per-entity-report.ts):
 *
 *   1. import fidelity on the main corpus fixtures (preserved / transformed /
 *      failed / skipped / unsupported + reason codes + aggregation),
 *   2. export fidelity on synthetic source/export pairs (proxy fallback
 *      reported, type normalisation, GUID / geometry / pset loss),
 *   3. round-trip joining (export → re-import type survival),
 *   4. deterministic JSON shape (byte-identical regeneration, no timestamps).
 *
 * The report measures STEP/semantic-model fidelity — see the module header
 * for what it does and does not claim about the web-ifc FRAG conversion.
 * The web-ifc leg is measured separately by scripts/ifc-per-entity-report.mjs
 * and tests/ifc-per-entity-roundtrip.test.cjs.
 *
 * Run: `node tests/ifc-per-entity-report.test.cjs`
 */

const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log("  PASS " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
};

const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-per-entity-"));
execSync(
  `npx tsc src/modules/ifc-semantics/per-entity-report.ts --outDir ${out} --rootDir src ` +
  `--module commonjs --target es2020 --lib es2020,dom --skipLibCheck --strict --ignoreDeprecations 5.0`,
  { cwd: root, stdio: "inherit" },
);
const compiled = path.join(out, "modules", "ifc-semantics", "per-entity-report.js");
assert.ok(fs.existsSync(compiled), "expected compiled module at " + compiled);
const M = require(compiled);
const {
  buildImportFidelityReport, buildImportFidelityReportFromText,
  buildExportFidelityReport, buildRoundTripReport,
  formatFidelitySummary, fidelityReportToJson, normaliseIfcType,
} = M;

const CORPUS = path.join(__dirname, "fixtures", "ifc-corpus");
const read = (rel) => fs.readFileSync(path.join(CORPUS, rel), "utf8");
const rowByType = (rep, type) => rep.rows.filter((r) => r.ifcType === type);

// ── 1. Import fidelity on the main corpus ─────────────────────────────────

t("import: generated-small.ifc — 9 products, all preserved", () => {
  const rep = buildImportFidelityReportFromText("generated-small.ifc", read("generated-small.ifc"));
  assert.ok(rep, "report missing");
  assert.strictEqual(rep.kind, "import");
  assert.strictEqual(rep.schema, "IFC4");
  assert.strictEqual(rep.schemaVersion, 1);
  assert.strictEqual(rep.totalProducts, 9, `products=${rep.totalProducts}`);
  assert.strictEqual(rep.totals.preserved, 9, JSON.stringify(rep.totals));
  assert.strictEqual(rep.totals.lostPct, 0);
  const wall = rowByType(rep, "IFCWALL")[0];
  assert.ok(wall, "wall row missing");
  assert.strictEqual(wall.status, "preserved");
  assert.deepStrictEqual(wall.reasonCodes, []);
  assert.strictEqual(wall.typeMapping, "typed");
  assert.strictEqual(wall.geometry, "present");
  assert.strictEqual(wall.placement, "present");
  assert.strictEqual(wall.tag, "w1");
  assert.ok(wall.propertySets.length >= 1, "wall psets missing");
  assert.ok(wall.propertySets.some((p) => p.name === "OpenBIMStudio"));
  assert.ok(wall.relationships.includes("containment"));
  assert.ok(wall.relationships.includes("properties"));
  assert.strictEqual(wall.containedIn?.type, "IFCBUILDINGSTOREY");
  const opening = rowByType(rep, "IFCOPENINGELEMENT")[0];
  assert.ok(opening, "opening row missing");
  assert.strictEqual(opening.status, "preserved");
  assert.ok(opening.relationships.includes("voids"), "opening should record its voids relationship");
});

t("import: generated-2x3.ifc — WallStandardCase rows are transformed, not preserved", () => {
  const rep = buildImportFidelityReportFromText("generated-2x3.ifc", read("generated-2x3.ifc"));
  assert.ok(rep);
  assert.strictEqual(rep.totalProducts, 9);
  const std = rowByType(rep, "IFCWALLSTANDARDCASE");
  assert.strictEqual(std.length, 2);
  for (const r of std) {
    assert.strictEqual(r.status, "transformed", JSON.stringify(r));
    assert.ok(r.reasonCodes.includes("TYPE_NORMALISED"));
    assert.strictEqual(r.typeMapping, "normalised");
  }
  assert.strictEqual(rep.totals.preserved, 7);
  assert.strictEqual(rep.totals.transformed, 2);
  assert.strictEqual(rep.totals.degradedPct, 22.2);
});

t("import: generated-structural.ifc — 5 products (beam, no column)", () => {
  // Records the corpus as it is: the fixture's purpose says "1 beam +
  // 1 column" but the file contains no IFCCOLUMN. The report measures
  // reality; fixing the fixture is out of scope for #106.
  const rep = buildImportFidelityReportFromText("generated-structural.ifc", read("generated-structural.ifc"));
  assert.ok(rep);
  assert.strictEqual(rep.totalProducts, 5, `products=${rep.totalProducts}: ` + rep.rows.map((r) => r.ifcType).join(","));
  assert.strictEqual(rowByType(rep, "IFCCOLUMN").length, 0);
  assert.strictEqual(rowByType(rep, "IFCBEAM").length, 1);
  assert.strictEqual(rep.totals.preserved, 5);
});

t("import: bad-guid.ifc — project failed with INVALID_GLOBALID, rest preserved", () => {
  const rep = buildImportFidelityReportFromText("bad-guid.ifc", read("invalid/bad-guid.ifc"));
  assert.ok(rep);
  const proj = rowByType(rep, "IFCPROJECT")[0];
  assert.ok(proj, "project row missing");
  assert.strictEqual(proj.status, "failed");
  assert.ok(proj.reasonCodes.includes("INVALID_GLOBALID"));
  // The invalid value is kept on the row so it can be seen, not nulled.
  assert.strictEqual(proj.globalId, "!@#%^&*()!@#%^&*()!@#%");
  assert.strictEqual(rep.totals.failed, 1);
  assert.strictEqual(rep.totals.preserved, rep.totalProducts - 1);
});

t("import: dangling-ref.ifc — dangling containment member warns, no product fails for it", () => {
  const rep = buildImportFidelityReportFromText("dangling-ref.ifc", read("invalid/dangling-ref.ifc"));
  assert.ok(rep);
  assert.ok(rep.warningCount > 0, "dangling relationship should surface as a warning");
  assert.ok(rep.warnings.some((w) => /99999|dangling/i.test(w)), rep.warnings.join(" | "));
  assert.strictEqual(rep.totals.failed, 0, "no product references #99999 itself");
});

t("import: missing-units.ifc — units are file-level, products still preserved", () => {
  const rep = buildImportFidelityReportFromText("missing-units.ifc", read("invalid/missing-units.ifc"));
  assert.ok(rep);
  assert.strictEqual(rep.totals.preserved, rep.totalProducts);
});

t("import: truncated.ifc — prefix products reported, truncation warned", () => {
  const rep = buildImportFidelityReportFromText("truncated.ifc", read("invalid/truncated.ifc"));
  assert.ok(rep, "prefix should still yield a report");
  assert.ok(rep.totalProducts >= 4, `products=${rep.totalProducts}`);
  assert.ok(rep.warnings.some((w) => /truncated|ENDSEC/i.test(w)), rep.warnings.join(" | "));
  assert.strictEqual(rowByType(rep, "IFCWALL").length, 0, "wall is past the cut and must not be invented");
});

t("import: type objects are definitions, not products — never counted as lost", () => {
  // The first real-world file exposed this: duplex-mep.ifc carries 407
  // IfcPipeSegmentType definitions, which the old heuristic counted as
  // `unsupported` product rows (lostPct 35.7% on definitions alone).
  const text = read("generated-small.ifc").replace(
    "ENDSEC;\nEND-ISO-10303-21;",
    "#9001=IFCPIPESEGMENTTYPE('0A1B2C3D4E5F6G7H8I9J0K',#5,'Pipe type',$,$,$,$,$,$);\n" +
    "#9004=IFCWINDOWSTYLE('3A1B2C3D4E5F6G7H8I9J0K',#5,'Window style',$,$,$,$,$);\n" +
    "#9005=IFCDOORLININGPROPERTIES('4A1B2C3D4E5F6G7H8I9J0K',#5,'Door lining',$,$,$,$,$,$,$);\n" +
    "ENDSEC;\nEND-ISO-10303-21;",
  );
  const rep = buildImportFidelityReportFromText("defs.ifc", text);
  assert.ok(rep);
  assert.strictEqual(rep.totalProducts, 9, "definitions must not become product rows");
  assert.strictEqual(rep.totals.unsupported, 0);
  assert.strictEqual(rep.totals.lostPct, 0);
  // 3 injected definitions + the 3 IfcSurfaceStyle records the base file
  // already carries (presentation styles are definitions, not products).
  assert.strictEqual(rep.definitions.total, 6);
  assert.deepStrictEqual(
    rep.definitions.byType.map((d) => [d.type, d.count]),
    [["IFCSURFACESTYLE", 3], ["IFCDOORLININGPROPERTIES", 1], ["IFCPIPESEGMENTTYPE", 1], ["IFCWINDOWSTYLE", 1]],
  );
  for (const type of ["IFCPIPESEGMENTTYPE", "IFCWINDOWSTYLE", "IFCDOORLININGPROPERTIES"]) {
    assert.strictEqual(rowByType(rep, type).length, 0, `${type} must not be a row`);
  }
});

t("import: real product classes outside the old known set are rows (stair flight, energy conversion device)", () => {
  const text = read("generated-small.ifc")
    .replace(
      "ENDSEC;\nEND-ISO-10303-21;",
      "#9002=IFCSTAIRFLIGHT('1A1B2C3D4E5F6G7H8I9J0K',#5,'Stair flight',$,$,#36,#38);\n" +
      "#9003=IFCENERGYCONVERSIONDEVICE('2A1B2C3D4E5F6G7H8I9J0K',#5,'AHU',$,$,#36,#38);\n" +
      "ENDSEC;\nEND-ISO-10303-21;",
    )
    .replace("(#39,#67,#99,#121)", "(#39,#67,#99,#121,#9002,#9003)");
  const rep = buildImportFidelityReportFromText("realprods.ifc", text);
  assert.ok(rep);
  assert.strictEqual(rep.totalProducts, 11);
  for (const [type, id] of [["IFCSTAIRFLIGHT", 9002], ["IFCENERGYCONVERSIONDEVICE", 9003]]) {
    const row = rep.rows.find((r) => r.expressId === id);
    assert.ok(row, `${type} row missing`);
    assert.strictEqual(row.ifcType, type);
    assert.strictEqual(row.typeMapping, "typed", `${type} must be a known product class`);
    assert.strictEqual(row.status, "preserved", `${type} row: ${JSON.stringify(row.reasonCodes)}`);
  }
  assert.strictEqual(rep.totals.unsupported, 0);
  // The base file's 3 IfcSurfaceStyle records are the only definitions here.
  assert.strictEqual(rep.definitions.total, 3);
});

t("import: unknown product-shaped type is unsupported, never dropped", () => {
  const text = read("generated-small.ifc").replace(
    "ENDSEC;\nEND-ISO-10303-21;",
    "#9001=IFCMYCUSTOMTHING('0A1B2C3D4E5F6G7H8I9J0K',#5,'Custom',$,$,#36,#38);\nENDSEC;\nEND-ISO-10303-21;",
  );
  const rep = buildImportFidelityReportFromText("custom.ifc", text);
  assert.ok(rep);
  assert.strictEqual(rep.totalProducts, 10);
  const custom = rowByType(rep, "IFCMYCUSTOMTHING")[0];
  assert.ok(custom, "unknown row missing");
  assert.strictEqual(custom.status, "unsupported");
  assert.ok(custom.reasonCodes.includes("UNKNOWN_TYPE"));
  assert.strictEqual(custom.typeMapping, "unknown-type");
  assert.strictEqual(rep.totals.unsupported, 1);
  assert.strictEqual(rep.totals.lostPct, 10);
});

t("import: duplicate GlobalId — second occurrence skipped, first kept", () => {
  const wallLine = read("generated-small.ifc").split("\n").find((l) => l.startsWith("#39=IFCWALL"));
  assert.ok(wallLine, "wall line not found");
  const dup = wallLine.replace("#39=", "#9002=");
  const text = read("generated-small.ifc").replace(
    "ENDSEC;\nEND-ISO-10303-21;",
    dup + "\nENDSEC;\nEND-ISO-10303-21;",
  );
  const rep = buildImportFidelityReportFromText("dup.ifc", text);
  assert.ok(rep);
  const walls = rowByType(rep, "IFCWALL");
  assert.strictEqual(walls.length, 3);
  const skipped = walls.filter((r) => r.status === "skipped");
  assert.strictEqual(skipped.length, 1);
  assert.ok(skipped[0].reasonCodes.includes("DUPLICATE_GLOBALID"));
  assert.strictEqual(skipped[0].expressId, 9002);
  assert.strictEqual(rep.totals.skipped, 1);
});

t("import: wall with $ representation is approximated with GEOMETRY_MISSING", () => {
  const text = read("generated-small.ifc").replace(
    "#39=IFCWALL('3XWIjBjlwysekZUfJStEq5',#5,'Wall A',$,'wall',#36,#38,'w1',.STANDARD.);",
    "#39=IFCWALL('3XWIjBjlwysekZUfJStEq5',#5,'Wall A',$,'wall',#36,$,'w1',.STANDARD.);",
  );
  const rep = buildImportFidelityReportFromText("nogeom.ifc", text);
  assert.ok(rep);
  const wall = rep.rows.find((r) => r.expressId === 39);
  assert.ok(wall);
  assert.strictEqual(wall.status, "approximated");
  assert.ok(wall.reasonCodes.includes("GEOMETRY_MISSING"));
  assert.strictEqual(wall.geometry, "absent");
});

t("import: non-STEP input returns null; empty input returns null", () => {
  assert.strictEqual(buildImportFidelityReportFromText("a.ifc", "hello world"), null);
  assert.strictEqual(buildImportFidelityReport("a.ifc", new Uint8Array(0)), null);
  assert.strictEqual(buildImportFidelityReport("a.ifc", null), null);
});

t("import: byType aggregates per type with percentages", () => {
  const rep = buildImportFidelityReportFromText("generated-2x3.ifc", read("generated-2x3.ifc"));
  const agg = rep.byType.find((a) => a.type === "IFCWALLSTANDARDCASE");
  assert.ok(agg);
  assert.strictEqual(agg.total, 2);
  assert.strictEqual(agg.transformed, 2);
  assert.strictEqual(agg.preservedPct, 0);
  assert.strictEqual(agg.degradedPct, 100);
  assert.strictEqual(agg.lostPct, 0);
  // Sorted by total desc, then type asc.
  assert.ok(rep.byType[0].total >= rep.byType[rep.byType.length - 1].total);
});

// ── 2. Export fidelity on synthetic pairs ─────────────────────────────────

const EXPORTED = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,'OpenBIMStudio',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'OpenBIMStudio',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1.0','OpenBIMStudio IFC writer','OpenBIMStudio');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,#3,#4,1794700800);
#10=IFCPROJECT('0CaUheUo_wNhgNp5BDAPpa',#5,'Project',$,$,$,$,(#13),#14);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCSHAPEREPRESENTATION(#23,$,'Body','Tessellation',(#31));
#31=IFCTRIANGULATEDFACESET(#32,$,$);
#32=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.)));
#33=IFCPRODUCTDEFINITIONSHAPE($,$,(#30));
#40=IFCWALL('3XWIjBjlwysekZUfJStEq5',#5,'Wall A',$,'wall',#20,#33,'w1',.STANDARD.);
#41=IFCPROPERTYSET('2RU28WMY$uMoeZKC$hT8gq',#5,'Pset_WallCommon',$,(#42));
#42=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('F60'),$);
#43=IFCRELDEFINESBYPROPERTIES('3eZTmqApVNjAOFOLTbjMhN',#5,$,$,(#40),#41);
#50=IFCBUILDINGELEMENTPROXY('1DMb_KxyrAfJxB_YgSNEyR',#5,'Door D1',$,'door',#20,#33,'d1',.NOTDEFINED.);
#60=IFCWALL('2WBwqgbCMTHedBh2Az8PnE',#5,'Wall Std',$,'wall',#20,#33,'w2',.STANDARD.);
#70=IFCBUILDINGELEMENTPROXY('3Ea9n1dGLCu6M7fBKs4dGK',#5,'NoType',$,'x',#20,#33,'nt',.NOTDEFINED.);
#71=IFCBUILDINGELEMENTPROXY('0Q9XpI1NFLeVyVMBlRIf78',#5,'Mystery',$,'x',#20,#33,'my',.NOTDEFINED.);
#80=IFCRELCONTAINEDINSPATIALSTRUCTURE('1DMb_KxyrAfJxB_YgSNEyS',#5,$,$,(#40,#50,#60,#70,#71),#10);
ENDSEC;
END-ISO-10303-21;`;

t("export: typed wall preserved with pset survival; proxy door flagged, not hidden", () => {
  const rep = buildExportFidelityReport([
    { globalId: "3XWIjBjlwysekZUfJStEq5", name: "Wall A", sourceType: "IfcWall", propertySets: ["Pset_WallCommon"], hasGeometry: true },
    { globalId: "1DMb_KxyrAfJxB_YgSNEyR", name: "Door D1", sourceType: "IfcDoor", hasGeometry: true },
  ], EXPORTED);
  assert.strictEqual(rep.kind, "export");
  assert.strictEqual(rep.sourceCount, 2);
  const wall = rep.rows[0];
  assert.strictEqual(wall.status, "preserved", JSON.stringify(wall));
  assert.strictEqual(wall.emittedType, "IFCWALL");
  assert.strictEqual(wall.matchedBy, "globalId");
  assert.strictEqual(wall.proxyFallback, false);
  assert.strictEqual(wall.geometrySurvived, true);
  assert.deepStrictEqual(wall.propertySetsSurvived, ["Pset_WallCommon"]);
  assert.deepStrictEqual(wall.propertySetsLost, []);
  const door = rep.rows[1];
  assert.strictEqual(door.status, "approximated", JSON.stringify(door));
  assert.strictEqual(door.emittedType, "IFCBUILDINGELEMENTPROXY");
  assert.strictEqual(door.proxyFallback, true);
  assert.ok(door.reasonCodes.includes("PROXY_FALLBACK"));
  assert.strictEqual(rep.totals.preserved, 1);
  assert.strictEqual(rep.totals.approximated, 1);
});

t("export: WallStandardCase → Wall is transformed; unknown source is unsupported; missing is failed", () => {
  const rep = buildExportFidelityReport([
    { globalId: "2WBwqgbCMTHedBh2Az8PnE", name: "Wall Std", sourceType: "IfcWallStandardCase", hasGeometry: true },
    { globalId: "0Q9XpI1NFLeVyVMBlRIf78", name: "Mystery", sourceType: "IfcKlingonBulkhead", hasGeometry: false },
    { globalId: "0Z9XpI1NFLeVyVMBlRIf79", name: "Ghost", sourceType: "IfcSlab", hasGeometry: true },
    { globalId: "3Ea9n1dGLCu6M7fBKs4dGK", name: "NoType", sourceType: "", hasGeometry: false },
  ], EXPORTED);
  const [std, mystery, ghost, noType] = rep.rows;
  assert.strictEqual(std.status, "transformed");
  assert.ok(std.reasonCodes.includes("TYPE_NORMALISED"));
  assert.strictEqual(mystery.status, "unsupported");
  assert.ok(mystery.reasonCodes.includes("UNKNOWN_SOURCE_TYPE"));
  assert.strictEqual(ghost.status, "failed");
  assert.ok(ghost.reasonCodes.includes("EXPORTED_ENTITY_MISSING"));
  assert.strictEqual(noType.status, "unsupported");
  assert.ok(noType.reasonCodes.includes("NO_SOURCE_TYPE"));
  assert.strictEqual(rep.totals.transformed, 1);
  assert.strictEqual(rep.totals.unsupported, 2);
  assert.strictEqual(rep.totals.failed, 1);
});

t("export: GlobalId not preserved — name match is approximated with GUID_NOT_PRESERVED", () => {
  const rep = buildExportFidelityReport([
    { globalId: "0AAAAAAAAAAAAAAAAAAAAA", name: "Wall A", sourceType: "IfcWall", hasGeometry: true },
  ], EXPORTED);
  const row = rep.rows[0];
  assert.strictEqual(row.matchedBy, "name");
  assert.strictEqual(row.emittedType, "IFCWALL");
  assert.strictEqual(row.status, "approximated");
  assert.ok(row.reasonCodes.includes("GUID_NOT_PRESERVED"));
});

t("export: lost geometry and lost psets downgrade preserved → approximated", () => {
  const noGeom = EXPORTED.replace(
    "#40=IFCWALL('3XWIjBjlwysekZUfJStEq5',#5,'Wall A',$,'wall',#20,#33,'w1',.STANDARD.);",
    "#40=IFCWALL('3XWIjBjlwysekZUfJStEq5',#5,'Wall A',$,'wall',#20,$,'w1',.STANDARD.);",
  );
  const rep = buildExportFidelityReport([
    { globalId: "3XWIjBjlwysekZUfJStEq5", name: "Wall A", sourceType: "IfcWall", propertySets: ["Pset_WallCommon", "Pset_Missing"], hasGeometry: true },
  ], noGeom);
  const row = rep.rows[0];
  assert.strictEqual(row.status, "approximated");
  assert.ok(row.reasonCodes.includes("GEOMETRY_LOST"));
  assert.ok(row.reasonCodes.includes("PSETS_LOST"));
  assert.strictEqual(row.geometrySurvived, false);
  assert.deepStrictEqual(row.propertySetsSurvived, ["Pset_WallCommon"]);
  assert.deepStrictEqual(row.propertySetsLost, ["Pset_Missing"]);
});

t("export: type labels normalise (Wall / IFCWALL / IfcWall are the same)", () => {
  assert.strictEqual(normaliseIfcType("Wall"), "WALL");
  assert.strictEqual(normaliseIfcType("IFCWALL"), "WALL");
  assert.strictEqual(normaliseIfcType("IfcWall"), "WALL");
  assert.strictEqual(normaliseIfcType(null), "");
});

// ── 3. Round-trip joining ─────────────────────────────────────────────────

t("round-trip: emitted types survive re-import; survival joins on GlobalId", () => {
  const rt = buildRoundTripReport([
    { globalId: "3XWIjBjlwysekZUfJStEq5", name: "Wall A", sourceType: "IfcWall", hasGeometry: true },
    { globalId: "1DMb_KxyrAfJxB_YgSNEyR", name: "Door D1", sourceType: "IfcDoor", hasGeometry: true },
  ], EXPORTED);
  assert.strictEqual(rt.kind, "round-trip");
  assert.ok(rt.reimport, "re-import report missing");
  assert.strictEqual(rt.export.totals.preserved, 1);
  assert.strictEqual(rt.export.totals.approximated, 1);
  const wallSurvival = rt.typeSurvival.find((s) => s.sourceType === "IfcWall");
  assert.ok(wallSurvival);
  assert.strictEqual(wallSurvival.emittedType, "IFCWALL");
  assert.strictEqual(wallSurvival.reimportedType, "IFCWALL");
  assert.strictEqual(wallSurvival.survived, true);
  const doorSurvival = rt.typeSurvival.find((s) => s.sourceType === "IfcDoor");
  assert.ok(doorSurvival);
  assert.strictEqual(doorSurvival.emittedType, "IFCBUILDINGELEMENTPROXY");
  assert.strictEqual(doorSurvival.reimportedType, "IFCBUILDINGELEMENTPROXY");
  assert.strictEqual(doorSurvival.survived, true, "the proxy itself round-trips — the loss is wall→proxy, already reported on the export leg");
  // The re-imported wall is preserved in the re-imported file's own terms.
  const reWall = rt.reimport.rows.find((r) => r.globalId === "3XWIjBjlwysekZUfJStEq5");
  assert.ok(reWall);
  assert.strictEqual(reWall.status, "preserved");
});

// ── 4. Determinism + summary ─────────────────────────────────────────────

t("json: regeneration is byte-identical and carries no timestamps", () => {
  const rep = buildImportFidelityReportFromText("generated-small.ifc", read("generated-small.ifc"));
  const a = fidelityReportToJson(rep);
  const b = fidelityReportToJson(buildImportFidelityReportFromText("generated-small.ifc", read("generated-small.ifc")));
  assert.strictEqual(a, b, "same bytes must regenerate byte-identical JSON");
  assert.ok(!/parsedAt|generatedAt|Date\.now/.test(a), "report must not embed wall-clock data");
  const parsed = JSON.parse(a);
  assert.strictEqual(parsed.totalProducts, 9);
  assert.strictEqual(parsed.rows.length, 9);
  assert.deepStrictEqual(parsed.rows.map((r) => r.expressId), [...parsed.rows.map((r) => r.expressId)].sort((x, y) => x - y));
});

t("format: summary lines state preserved/degraded/lost and the scope caveat", () => {
  const rep = buildImportFidelityReportFromText("generated-2x3.ifc", read("generated-2x3.ifc"));
  const lines = formatFidelitySummary(rep);
  const joined = lines.join("\n");
  assert.ok(/preserved 7/.test(joined), joined);
  assert.ok(/degraded 2/.test(joined), joined);
  assert.ok(/IFCWALLSTANDARDCASE: 2/.test(joined), joined);
  assert.ok(/Not a per-entity web-ifc FRAG-conversion claim/.test(joined), joined);
  const exp = buildExportFidelityReport([
    { globalId: "1DMb_KxyrAfJxB_YgSNEyR", name: "Door D1", sourceType: "IfcDoor", hasGeometry: true },
  ], EXPORTED);
  const expLines = formatFidelitySummary(exp).join("\n");
  assert.ok(/proxy fallback \(reported, not hidden\): 1 of 1/.test(expLines), expLines);
});

if (fail) process.exit(1);
console.log(`=== ifc-per-entity-report tests complete: ${pass} passed, ${fail} failed ===`);
