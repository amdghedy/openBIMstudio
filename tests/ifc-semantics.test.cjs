/**
 * IFC semantic intelligence tests — geometry + inspection contract.
 *
 * Covers the pure module (src/modules/ifc-semantics) compiled standalone:
 *   1. independent STEP reader (args, tolerance, unknown preservation)
 *   2. IFC units (SI, prefixes, conversion-based, missing units)
 *   3. semantic model on the writer's own output (IFC4 + IFC2X3)
 *   4. element inspection (identity, psets, relationships, placements)
 *   5. semantic validation (clean corpus + the four invalid fixtures)
 *   6. twin writer GlobalId integrity (all 22-char base64 valid)
 *
 * The reader shares no code with web-ifc or the writers — assertions here
 * are the independent cross-check behind the IFC compatibility matrix.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("ok  -", name); }
  catch (err) { console.error("FAIL -", name, "\n ", err.message); process.exitCode = 1; }
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), "ifc-semantics-"));
execSync(
  `npx tsc src/modules/ifc-semantics/index.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
  { stdio: "inherit", cwd: path.join(__dirname, "..") },
);
const M = require(path.join(out, "ifc-semantics", "index.js"));
const V = require(path.join(out, "ifc-semantics", "validate.js"));

const CORPUS = path.join(__dirname, "fixtures", "ifc-corpus");
const read = (rel) => fs.readFileSync(path.join(CORPUS, rel), "utf8");

// ── 1. Independent STEP reader ──────────────────────────────────────────
t("readStep: schema + entity enumeration + argument splitting", () => {
  const f = M.readStep(read("generated-small.ifc"));
  assert.strictEqual(f.schema, "IFC4");
  assert.ok(f.entities.size > 40, "entities parsed");
  const wall = [...f.entities.values()].find((e) => e.name === "IFCWALL");
  assert.ok(wall, "wall entity present");
  assert.ok(/^'[0-9A-Za-z_$]{22}'$/.test(wall.args[0]), "GlobalId kept as quoted 22-char string");
  const nameArg = wall.args[2];
  assert.ok(nameArg.startsWith("'") && nameArg.endsWith("'"), "name kept as quoted string");
});

t("readStep: malformed content → warnings, never throws", () => {
  // Unterminated strings make the remainder unreadable by design, so the
  // malformed line here is recoverable (no opening paren) and parsing resumes.
  const f = M.readStep("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nIFCWALL 'abc');\ngarbage here\n#2=IFCSLAB($);\n");
  assert.ok(f.warnings.length >= 1, "warnings collected");
  assert.ok(f.entities.size >= 1, "readable entities still returned");
  assert.ok(f.entities.get(2)?.name === "IFCSLAB", "parsing resumed after malformed line");
});

t("readStep: truncated file → entities so far preserved", () => {
  const full = read("generated-structural.ifc");
  const cut = full.slice(0, Math.floor(full.length * 0.5));
  const f = M.readStep(cut);
  assert.ok(f.entities.size > 0, "prefix entities readable");
  assert.ok(f.warnings.some((w) => /truncated|ENDSEC/i.test(w)), "truncation flagged");
});

t("readStep: unknown entities are preserved, never dropped", () => {
  const text = read("generated-small.ifc").replace("ENDSEC;\nEND-ISO-10303-21;", "#9001=IFCMYCUSTOMTHING('x',42);\nENDSEC;\nEND-ISO-10303-21;");
  const m = M.buildSemanticModel(text);
  assert.ok(m.entities.get(9001), "unknown entity retained in entity map");
  assert.strictEqual((m.unknownClasses.get("IFCMYCUSTOMTHING") ?? 0), 1, "unknown class counted");
});

// ── 2. IFC units ────────────────────────────────────────────────────────
t("units: SI metre assignment parsed with factor 1", () => {
  const u = M.readUnits(read("generated-small.ifc"));
  assert.ok(u.present);
  assert.strictEqual(u.length.name, "METRE");
  assert.strictEqual(u.length.factor, 1);
  assert.strictEqual(u.angle.name, "RADIAN");
});

t("units: MILLI prefix multiplies correctly", () => {
  const text = [
    "ISO-10303-21;", "HEADER;", "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;",
    "#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);",
    "#2=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);",
    "ENDSEC;", "END-ISO-10303-21;",
  ].join("\n");
  const u = M.readUnits(text);
  assert.strictEqual(u.length.name, "METRE");
  assert.strictEqual(u.length.prefix, "MILLI");
  assert.strictEqual(u.length.factor, 1e-3);
  assert.strictEqual(M.toBase(2500, u.length), 2.5);
});

t("units: conversion-based FOOT chains onto SI METRE", () => {
  const text = [
    "ISO-10303-21;", "HEADER;", "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;",
    "#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
    "#2=IFCMEASUREWITHUNIT(0.3048,#1);",
    "#3=IFCCONVERSIONBASEDUNIT('FOOT',.LENGTHUNIT.,#2,$);",
    "ENDSEC;", "END-ISO-10303-21;",
  ].join("\n");
  const u = M.readUnits(text);
  assert.strictEqual(u.length.name, "FOOT");
  assert.ok(Math.abs(u.length.factor - 0.3048) < 1e-12);
  assert.strictEqual(M.toBase(10, u.length).toFixed(6), "3.048000");
});

t("units: absent unit assignment → present=false (never fabricated)", () => {
  const u = M.readUnits("ISO-10303-21;\nDATA;\n#1=IFCWALL('0xScRe4drE$QuCcyMkXutA');\nENDSEC;");
  assert.strictEqual(u.present, false);
  assert.strictEqual(u.length, null);
});

// ── 3. Semantic model over the writer's own output ──────────────────────
const small = M.buildSemanticModel(read("generated-small.ifc"));
const structural = M.buildSemanticModel(read("generated-structural.ifc"));
const mep = M.buildSemanticModel(read("mep-model.ifc"));
const classified = M.buildSemanticModel(read("arch-classified.ifc"));

t("semantic-model: entity counts match writer intent (walls/doors/slabs)", () => {
  assert.strictEqual((small.byClass.get("IFCWALL") || []).length, 2);
  assert.strictEqual((small.byClass.get("IFCDOOR") || []).length, 1);
  assert.strictEqual((small.byClass.get("IFCSLAB") || []).length, 1);
  assert.strictEqual((small.byClass.get("IFCOPENINGELEMENT") || []).length, 1);
});

t("semantic-model: all GlobalIds valid + unique on valid corpus", () => {
  for (const model of [small, structural, mep, classified]) {
    assert.strictEqual(model.invalidGlobalIds.length, 0, "no invalid GUIDs");
    const dups = [...model.duplicateGlobalIds.values()].filter((a) => a.length > 1);
    assert.strictEqual(dups.length, 0, "no duplicate GUIDs");
  }
});

t("semantic-model: a 22-char property NAME is not a GlobalId (Duplex regression)", () => {
  // 'Top Extension Distance' and 'Actual Exhaust Airflow' are exactly 22
  // characters — the old class-blind rule read them as GlobalId candidates
  // and flagged IFC-E-BAD-GUID (107 false errors in duplex-a, 429 in
  // duplex-mep). Only IfcRoot subtypes carry a GlobalId as argument 0.
  const text = [
    "ISO-10303-21;", "HEADER;", "ENDSEC;", "DATA;",
    "#1=IFCPROJECT('0xScRe4drE$QuCcyMkXutA',#2,'P',$,$,$,$,$,$);",
    "#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,#3,#4,1794586356);",
    "#3=IFCPERSON($,'A',$,$,$,$,$,$);",
    "#4=IFCORGANIZATION($,'O',$,$,$);",
    "#5=IFCPROPERTYSINGLEVALUE('Top Extension Distance',$,IFCLENGTHMEASURE(0.),$);",
    "#6=IFCPROPERTYSINGLEVALUE('Actual Exhaust Airflow',$,IFCREAL(0.),$);",
    "#7=IFCQUANTITYLENGTH('Gross Floor Area Calcs',$,0.,$);",
    "#8=IFCSURFACESTYLE('TwentyTwoCharStyleName',(#9));",
    "#9=IFCCOLOURRGB($,0.5,0.5,0.5);",
    "ENDSEC;", "END-ISO-10303-21;",
  ].join("\n");
  const model = M.buildSemanticModel(text);
  assert.strictEqual(model.invalidGlobalIds.length, 0, JSON.stringify(model.invalidGlobalIds));
  assert.strictEqual(model.globalIds.size, 1, "only the project root carries a GlobalId");
  assert.strictEqual(model.globalIds.get(1), "0xScRe4drE$QuCcyMkXutA");
  const errors = V.validateSemanticModel(model).filter((x) => x.severity === "error");
  assert.strictEqual(errors.length, 0, JSON.stringify(errors));
});

t("semantic-model: spatial tree Project→Site→Building→Storey", () => {
  const p = small.spatial.project;
  assert.ok(p, "project present");
  assert.strictEqual(p.cls, "IFCPROJECT");
  assert.strictEqual(p.children[0]?.cls, "IFCSITE");
  assert.strictEqual(p.children[0]?.children[0]?.cls, "IFCBUILDING");
  const storey = p.children[0]?.children[0]?.children[0];
  assert.strictEqual(storey?.cls, "IFCBUILDINGSTOREY");
  assert.strictEqual(storey?.name, "Ground");
  assert.ok(storey?.contained?.length >= 2, "walls contained in storey");
});

t("semantic-model: voids/fills topology for the hosted door", () => {
  const voids = small.relationships.filter((r) => r.kind === "voids");
  const fills = small.relationships.filter((r) => r.kind === "fills");
  assert.strictEqual(voids.length, 1, "one opening voids the host wall");
  assert.strictEqual(fills.length, 1, "the door fills the opening");
  // opening → host and door → opening links resolve
  const opening = voids[0].related[0];
  const host = voids[0].relating;
  assert.strictEqual(fills[0].relating, opening, "fill's opening matches the void's opening");
  assert.ok(small.entities.has(opening) && small.entities.has(host), "topology refs resolve");
});

t("semantic-model: property sets parsed with typed values", () => {
  const psets = [...small.psets.values()];
  assert.ok(psets.length >= 3, "psets present");
  const withProps = psets.find((p) => p.props.length > 0);
  assert.ok(withProps, "pset carries properties");
  const material = withProps.props.find((p) => p.name === "material");
  assert.ok(material, "authored material property serialized");
  assert.strictEqual(material.value.type, "label");
});

t("semantic-model: quantity sets parsed with numeric values", () => {
  const qtos = [...small.qtos.values()].filter((q) => q.quantities.length > 0);
  assert.ok(qtos.length >= 1, "quantity sets present");
  const q = qtos[0].quantities[0];
  assert.ok(q.name, "quantity named");
  assert.ok(q.value === null || Number.isFinite(q.value), "value numeric or explicitly absent");
});

t("semantic-model: MEP corpus carries MEP classes + equipment", () => {
  assert.ok((mep.byClass.get("IFCDUCTSEGMENT") || []).length === 2, "ducts");
  assert.ok((mep.byClass.get("IFCPIPESEGMENT") || []).length === 1, "pipe");
  // IFC4 routes both cable trays and conduits through IfcCableCarrierSegment
  // (IfcConduitSegment does not exist in IFC4); the conduit is distinguished
  // by its PredefinedType .CONDUITSEGMENT.
  assert.ok((mep.byClass.get("IFCCABLECARRIERSEGMENT") || []).length === 2, "tray + conduit");
  const conduit = (mep.byClass.get("IFCCABLECARRIERSEGMENT") || [])
    .map((id) => mep.entities.get(id))
    .find((e) => e.args[e.args.length - 1] === ".CONDUITSEGMENT.");
  assert.ok(conduit, "conduit distinguished by PredefinedType");
  assert.ok((mep.byClass.get("IFCBUILDINGELEMENTPROXY") || []).length >= 1, "equipment proxy");
  assert.strictEqual(mep.spatial.storeys, 2, "two storeys in MEP model");
});

t("semantic-model: placements resolve to world matrices", () => {
  const wallId = small.byClass.get("IFCWALL")[0];
  const ins = M.inspectElement(small, wallId);
  assert.ok(ins.placement, "wall placement resolved");
  assert.strictEqual(ins.placement.translation.length, 3);
  assert.ok(ins.placement.translation.every((v) => Number.isFinite(v)), "finite translation");
});

// ── 4. Inspection ───────────────────────────────────────────────────────
t("inspect: wall identity + containment + psets", () => {
  const wallId = small.byClass.get("IFCWALL")[0];
  const ins = M.inspectElement(small, wallId);
  assert.strictEqual(ins.cls, "IFCWALL");
  assert.ok(ins.globalId && ins.globalId.length === 22);
  assert.strictEqual(ins.containedIn?.cls, "IFCBUILDINGSTOREY");
  assert.ok(ins.psets.length >= 1, "wall carries psets via RelDefinesByProperties");
});

t("inspect: door sees its opening + host void", () => {
  const doorId = small.byClass.get("IFCDOOR")[0];
  const ins = M.inspectElement(small, doorId);
  assert.strictEqual(ins.fills.length, 1, "door fills one opening");
});

t("inspect: findByGlobalId round-trips to the same element", () => {
  const wallId = small.byClass.get("IFCWALL")[0];
  const gid = small.globalIds.get(wallId);
  const found = M.findByGlobalId(small, gid);
  assert.strictEqual(found?.expressId, wallId);
});

t("inspect: missing element → null (no fabrication)", () => {
  assert.strictEqual(M.inspectElement(small, 999999), null);
  assert.strictEqual(M.findByGlobalId(small, "0XScRe4drE$QuCcyMkXutZ"), null);
});

// ── 5. Classifications ──────────────────────────────────────────────────
t("classification: system + references + element associations parsed", () => {
  const recs = [...classified.classifications.values()];
  const sys = recs.find((r) => r.cls === "IFCCLASSIFICATION");
  assert.ok(sys, "IfcClassification present");
  assert.strictEqual(sys.name, "Uniclass 2015");
  assert.strictEqual(sys.source, "NBS");
  const refs = recs.filter((r) => r.cls === "IFCCLASSIFICATIONREFERENCE");
  assert.strictEqual(refs.length, 4, "four classification references");
  assert.ok(refs.every((r) => r.referencedSource === sys.id), "every reference points at the system");
  const hosted = refs.filter((r) => r.hosts.length === 1);
  assert.strictEqual(hosted.length, 4, "each reference associated to exactly one element");
  const codes = refs.map((r) => r.identification).sort();
  assert.deepStrictEqual(codes, ["Do_07_10_20", "Ss_25_10_30", "Ss_25_30_40", "Ss_25_30_40"]);
});

t("classification: validation finds no dangling references", () => {
  const findings = V.validateSemanticModel(classified);
  assert.ok(!findings.some((f) => f.code === "IFC-W-CLASSIF-DANGLING"), "classification topology intact");
});

// ── 6. Validation ───────────────────────────────────────────────────────
t("validate: valid corpus → zero errors", () => {
  for (const model of [small, structural, mep, classified]) {
    const findings = V.validateSemanticModel(model);
    const errors = findings.filter((f) => f.severity === "error");
    assert.strictEqual(errors.length, 0, `no errors in ${model.schema} model: ${JSON.stringify(errors.slice(0, 2))}`);
  }
});

t("validate: bad-guid fixture → IFC-E-BAD-GUID", () => {
  const m = M.buildSemanticModel(read("invalid/bad-guid.ifc"));
  const f = V.validateSemanticModel(m);
  assert.ok(f.some((x) => x.code === "IFC-E-BAD-GUID"), "invalid charset flagged");
  assert.ok(m.entities.size > 40, "model still fully readable");
});

t("validate: dangling-ref fixture → IFC-E-DANGLING-REF with entity attribution", () => {
  const m = M.buildSemanticModel(read("invalid/dangling-ref.ifc"));
  const f = V.validateSemanticModel(m).filter((x) => x.code === "IFC-E-DANGLING-REF");
  assert.ok(f.length >= 1, "dangling reference flagged");
  assert.ok(f[0].message.includes("#99999"), "missing id named");
});

t("validate: missing-units fixture → IFC-W-UNITS-MISSING", () => {
  const m = M.buildSemanticModel(read("invalid/missing-units.ifc"));
  const f = V.validateSemanticModel(m);
  assert.ok(f.some((x) => x.code === "IFC-W-UNITS-MISSING"));
  assert.strictEqual(m.units.present, false, "units honestly absent");
});

t("validate: truncated fixture → graceful (readable prefix, no crash)", () => {
  const m = M.buildSemanticModel(read("invalid/truncated.ifc"));
  assert.ok(m.entities.size > 20, "partial model readable");
  assert.ok(m.warnings.length >= 1, "truncation warning recorded");
});

t("validate: summary counts severities", () => {
  const s = V.summarizeFindings(V.validateSemanticModel(M.buildSemanticModel(read("invalid/bad-guid.ifc"))));
  assert.ok(s.errors >= 1 && s.byCode["IFC-E-BAD-GUID"] >= 1);
});

// ── 7. Twin writer GUID integrity ───────────────────────────────────────
t("twin writer: every emitted GlobalId is a valid 22-char base64 GUID", () => {
  execSync(
    `npx tsc src/modules/export/native-twin-ifc.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
    { stdio: "pipe", cwd: path.join(__dirname, "..") },
  );
  const W = require(path.join(out, "export", "native-twin-ifc.js"));
  const text = W.writeFederatedNativeTwinIfc([
    { name: "Twin A", modelId: "m1", nativeId: "n1", position: [0, 0, 0], quaternion: [0, 0, 0, 1], propertySets: { Pset_Custom: { Rating: "F60", Area: 12.5 } } },
    { name: "Twin B", modelId: "m1", nativeId: "n2", sourceGlobalId: "0XScRe4drE$QuCcyMkXutA", position: [1, 1, 0], quaternion: [0, 0, 0, 1] },
    { name: "Twin C", modelId: "m2", nativeId: "n3", sourceGlobalId: "NOT-A-GUID!!", position: [2, 2, 0], quaternion: [0, 0, 0, 1] },
  ], "TwinGuidTest");
  const m = M.buildSemanticModel(text);
  assert.strictEqual(m.schema, "IFC4");
  assert.strictEqual(m.invalidGlobalIds.length, 0, `all GUIDs valid: ${JSON.stringify(m.invalidGlobalIds)}`);
  const dups = [...m.duplicateGlobalIds.values()].filter((a) => a.length > 1);
  assert.strictEqual(dups.length, 0, "no duplicate GUIDs across twins");
  // The real source GUID is preserved; the junk one replaced by a derived valid GUID.
  const twins = [...m.byClass.get("IFCBUILDINGELEMENTPROXY") || []];
  assert.strictEqual(twins.length, 3);
  const gids = twins.map((id) => m.globalIds.get(id));
  assert.ok(gids.includes("0XScRe4drE$QuCcyMkXutA"), "valid source GUID kept");
  assert.ok(!gids.includes("NOT-A-GUID!!"), "junk source GUID replaced");
});

t("twin writer: deterministic element GUIDs across exports", () => {
  const W = require(path.join(out, "export", "native-twin-ifc.js"));
  const edit = { name: "Stable Twin", modelId: "m1", nativeId: "n9", position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
  const a = M.buildSemanticModel(W.writeNativeTwinIfc(edit));
  const b = M.buildSemanticModel(W.writeNativeTwinIfc(edit));
  const ga = [...a.globalIds.values()].sort().join(",");
  const gb = [...b.globalIds.values()].sort().join(",");
  // element GUID is derived deterministically (instance GUIDs for rels/psets are random)
  const twinA = a.findByGlobalId ? null : null;
  const elA = a.byClass.get("IFCBUILDINGELEMENTPROXY")[0];
  const elB = b.byClass.get("IFCBUILDINGELEMENTPROXY")[0];
  assert.strictEqual(a.globalIds.get(elA), b.globalIds.get(elB), "element GlobalId stable across exports");
  void ga; void gb; void twinA;
});

console.log(`\nIFC semantics tests: ${passed} passed${process.exitCode ? " (FAILURES)" : ""}.`);
