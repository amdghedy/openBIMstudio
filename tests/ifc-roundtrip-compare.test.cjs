/**
 * IFC round-trip exchange comparison — the "transparent compatibility" gate.
 *
 * The SAME authored model is exported twice (IFC4 and IFC2X3) by the
 * platform's own writer, re-read by the INDEPENDENT step reader
 * (src/modules/ifc-semantics — shares no code with the writer or web-ifc),
 * and compared across the exchanges:
 *
 *   element totals (schema-mapped classes) · GlobalId determinism ·
 *   unit assignment · property sets (names + values) · quantity sets ·
 *   relationship topology (voids/fills/containment) · spatial structure ·
 *   geometry presence per element.
 *
 * Schema differences are mapped explicitly (IFCWALL↔IFCWALLSTANDARDCASE,
 * IFCDUCTSEGMENT↔IFCFLOWSEGMENT, …) — anything outside the map is a failure,
 * so silent class drift cannot pass.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("ok  -", name); }
  catch (err) { console.error("FAIL -", name, "\n ", err.message); process.exitCode = 1; }
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), "ifc-exchange-"));
execSync(
  `npx tsc --rootDir src --outDir ${out} --module commonjs --moduleResolution node --target es2020 --skipLibCheck --ignoreDeprecations 5.0 src/modules/bim-gaps/authored-ifc.ts src/modules/ifc-semantics/index.ts`,
  { stdio: "inherit", cwd: path.join(__dirname, "..") },
);
const { exportAuthoredToIfc } = require(path.join(out, "modules/bim-gaps/authored-ifc.js"));
const M = require(path.join(out, "modules/ifc-semantics/index.js"));

// ── source model: architectural + structural + MEP representatives ──────
const levels = [{ id: "L0", name: "Ground", elevation: 0 }, { id: "L1", name: "First", elevation: 3 }];
const MODEL = [
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [6, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0", properties: { material: "Brick" } },
  { id: "w2", type: "wall", name: "Wall B", params: { start: [6, 0], end: [6, 4], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "d1", type: "door", name: "Door 1", hostId: "w1", params: { width: 0.9, height: 2.1, thickness: 0.2, elevation: 0, offsetAlongHost: 2, sillHeight: 0 } },
  { id: "s1", type: "slab", name: "Floor", params: { polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], height: 0.2, thickness: 0.2, elevation: -0.2 }, levelId: "L0" },
  { id: "c1", type: "column", name: "Column 1", params: { point: [3, 2], height: 3, thickness: 0.3, depth: 0.3, elevation: 0 }, levelId: "L0" },
  { id: "st1", type: "stairs", name: "Stair 1", params: { start: [0, 1], end: [2, 1], height: 3, width: 1.2, elevation: 0 }, levelId: "L0" },
  { id: "du1", type: "duct", name: "Duct 1", params: { start: [0, 3], end: [6, 3], height: 3, thickness: 0.4, depth: 0.25, elevation: 2.9 }, levelId: "L0" },
];
const OPTS = { levels, projectName: "Exchange Compare", projectId: "exchange-compare", timestamp: "2026-11-15T00:00:00Z" };

const r4 = exportAuthoredToIfc(MODEL, { ...OPTS, schema: "IFC4" });
const r23 = exportAuthoredToIfc(MODEL, { ...OPTS, schema: "IFC2X3" });
const A = M.buildSemanticModel(r4.text); // IFC4 exchange
const B = M.buildSemanticModel(r23.text); // IFC2X3 exchange

/** Schema class mapping: semantic role → per-schema entity class. */
const CLASS_MAP = {
  wall: { IFC4: "IFCWALL", IFC2X3: "IFCWALLSTANDARDCASE" },
  door: { IFC4: "IFCDOOR", IFC2X3: "IFCDOOR" },
  slab: { IFC4: "IFCSLAB", IFC2X3: "IFCSLAB" },
  column: { IFC4: "IFCCOLUMN", IFC2X3: "IFCCOLUMN" },
  stairs: { IFC4: "IFCSTAIR", IFC2X3: "IFCSTAIR" },
  duct: { IFC4: "IFCDUCTSEGMENT", IFC2X3: "IFCFLOWSEGMENT" },
  opening: { IFC4: "IFCOPENINGELEMENT", IFC2X3: "IFCOPENINGELEMENT" },
};

const count = (m, role) => (m.byClass.get(CLASS_MAP[role][m.schema] ?? "") || []).length;

// ── 1. Element totals across exchanges ──────────────────────────────────
t("exchange: element totals identical under schema class mapping", () => {
  assert.strictEqual(A.schema, "IFC4");
  assert.strictEqual(B.schema, "IFC2X3");
  for (const role of Object.keys(CLASS_MAP)) {
    const ca = count(A, role), cb = count(B, role);
    assert.strictEqual(ca, cb, `role ${role}: IFC4 ${ca} vs IFC2X3 ${cb}`);
  }
  assert.strictEqual(count(A, "wall"), 2, "two walls");
  assert.strictEqual(count(A, "door"), 1, "one door");
  assert.strictEqual(count(A, "duct"), 1, "one duct");
});

t("exchange: writer stats agree with independent re-read", () => {
  for (const [role, cls] of Object.entries(CLASS_MAP)) {
    if (role === "opening") continue; // openings tracked via stats.openings, not byClass
    const statKey = cls.IFC4;
    const statCount = r4.stats.byClass[statKey] ?? 0;
    const readCount = (A.byClass.get(statKey) || []).length;
    assert.strictEqual(statCount, readCount, `${statKey}: writer stats ${statCount} vs independent read ${readCount}`);
  }
  assert.strictEqual(r4.stats.openings, 1, "writer openings counter");
  assert.strictEqual((A.byClass.get("IFCOPENINGELEMENT") || []).length, 1, "independent opening read");
});

// ── 2. GUID determinism across exchanges ────────────────────────────────
t("exchange: same element keeps the same GlobalId in both schemas", () => {
  for (const el of MODEL) {
    const ga = M.findByGlobalId(A, globalIdOf(A, el.id));
    const gidA = globalIdOf(A, el.id), gidB = globalIdOf(B, el.id);
    if (!gidA && !gidB) continue; // element skipped in both (stats.skipped would say why)
    assert.ok(gidA && gidB, `${el.id}: GlobalId present in both exchanges`);
    assert.strictEqual(gidA, gidB, `${el.id}: GlobalId identical across IFC4/IFC2X3`);
    assert.ok(M.isValidIfcGuid(gidA), `${el.id}: valid buildingSMART GUID`);
    void ga;
  }
});

function globalIdOf(m, elementId) {
  // Element GlobalIds are derived from the stable key: find by Name.
  const el = MODEL.find((x) => x.id === elementId);
  const name = `'${(el.name || el.id).replace(/'/g, "''")}'`;
  for (const e of m.entities.values()) {
    if (e.args[2] === name && /^IFC(WALL|DOOR|SLAB|COLUMN|STAIR|DUCTSEGMENT|FLOWSEGMENT|WALLSTANDARDCASE)/.test(e.name)) {
      return m.globalIds.get(e.id) ?? null;
    }
  }
  return null;
}

// ── 3. Units ────────────────────────────────────────────────────────────
t("exchange: unit assignment identical (metre / m² / m³ / radian)", () => {
  for (const m of [A, B]) {
    assert.ok(m.units.present, `${m.schema}: units present`);
    assert.strictEqual(m.units.length?.name, "METRE");
    assert.strictEqual(m.units.area?.name, "SQUARE_METRE");
    assert.strictEqual(m.units.volume?.name, "CUBIC_METRE");
    assert.strictEqual(m.units.angle?.name, "RADIAN");
    assert.strictEqual(m.units.length?.factor, 1);
  }
});

// ── 4. Property sets ────────────────────────────────────────────────────
t("exchange: property set names + values identical across schemas", () => {
  const psetSignature = (m) => {
    const sig = [];
    for (const p of [...m.psets.values()].sort((x, y) => x.name.localeCompare(y.name))) {
      const props = p.props
        .map((pr) => `${pr.name}=${pr.value.type}:${pr.value.value}`)
        .sort()
        .join("|");
      sig.push(`${p.name}{${props}}`);
    }
    return sig.sort().join("\n");
  };
  const sa = psetSignature(A), sb = psetSignature(B);
  assert.ok(sa.length > 0, "psets exist in IFC4");
  assert.strictEqual(sa, sb, `pset signatures differ:\n--- IFC4 ---\n${sa}\n--- IFC2X3 ---\n${sb}`);
  assert.ok(sa.includes("material=label:Brick"), "authored material property survived");
});

// ── 5. Quantities ───────────────────────────────────────────────────────
t("exchange: quantity set names + values identical across schemas", () => {
  const qtoSignature = (m) => {
    const sig = [];
    for (const q of [...m.qtos.values()].sort((x, y) => x.name.localeCompare(y.name))) {
      const qs = q.quantities
        .map((x) => `${x.name}=${x.value}`)
        .sort()
        .join("|");
      sig.push(`${q.name}{${qs}}`);
    }
    return sig.sort().join("\n");
  };
  const qa = qtoSignature(A), qb = qtoSignature(B);
  assert.ok(qa.length > 0, "quantities exist in IFC4");
  assert.strictEqual(qa, qb, `quantity signatures differ:\n--- IFC4 ---\n${qa}\n--- IFC2X3 ---\n${qb}`);
});

// ── 6. Relationship topology ────────────────────────────────────────────
t("exchange: voids/fills/containment topology identical", () => {
  for (const kind of ["voids", "fills", "containment", "aggregates"]) {
    const ra = A.relationships.filter((r) => r.kind === kind);
    const rb = B.relationships.filter((r) => r.kind === kind);
    assert.strictEqual(ra.length, rb.length, `${kind}: IFC4 ${ra.length} vs IFC2X3 ${rb.length}`);
  }
  const voidsA = A.relationships.filter((r) => r.kind === "voids").length;
  assert.strictEqual(voidsA, 1, "one opening voids the host wall in IFC4");
  const fillsA = A.relationships.filter((r) => r.kind === "fills").length;
  assert.strictEqual(fillsA, 1, "one fill relationship in IFC4");
});

// ── 7. Spatial structure ────────────────────────────────────────────────
t("exchange: spatial tree depth + storey contents identical", () => {
  assert.strictEqual(A.spatial.storeys, B.spatial.storeys, "storey count");
  assert.strictEqual(A.spatial.storeys, 2, "two storeys");
  const containedCount = (m) => {
    let n = 0;
    for (const r of m.relationships) if (r.kind === "containment") n += r.related.length;
    return n;
  };
  assert.strictEqual(containedCount(A), containedCount(B), "contained element totals");
  assert.ok(containedCount(A) >= 5, "walls/door/slab/column/stairs/duct contained");
});

// ── 8. Geometry presence per element ────────────────────────────────────
t("exchange: every element with a body representation in IFC4 has one in IFC2X3", () => {
  const hasBody = (m) => {
    const set = new Set();
    for (const r of m.relationships) {
      if (r.kind !== "containment") continue;
      for (const el of r.related) {
        const e = m.entities.get(el);
        if (e && e.args[6] && e.args[6] !== "$") set.add(m.globalIds.get(el) ?? el);
      }
    }
    return set;
  };
  const ba = hasBody(A), bb = hasBody(B);
  assert.ok(ba.size >= 5, "IFC4 bodies present");
  for (const gid of ba) {
    assert.ok(bb.has(gid), `${gid}: body representation missing in IFC2X3 exchange`);
  }
  for (const gid of bb) {
    assert.ok(ba.has(gid), `${gid}: body representation missing in IFC4 exchange`);
  }
});

// ── 9. Exchange report (machine-readable, for the compatibility matrix) ─
t("exchange: comparison report emitted with all dimensions", () => {
  const report = {
    generatedAt: "test",
    sourceModel: { elements: MODEL.length },
    exchanges: {
      IFC4: { schema: A.schema, entities: A.entities.size, globalIds: A.globalIds.size, invalidGlobalIds: A.invalidGlobalIds.length, units: A.units.present },
      IFC2X3: { schema: B.schema, entities: B.entities.size, globalIds: B.globalIds.size, invalidGlobalIds: B.invalidGlobalIds.length, units: B.units.present },
    },
    invariantChecks: ["element-totals", "writer-stats", "guid-determinism", "units", "psets", "quantities", "relationships", "spatial", "geometry-presence"],
  };
  assert.strictEqual(report.exchanges.IFC4.invalidGlobalIds, 0);
  assert.strictEqual(report.exchanges.IFC2X3.invalidGlobalIds, 0);
  assert.ok(report.exchanges.IFC4.globalIds >= 8, "IFC4 carries GlobalIds for all roots");
  assert.ok(report.exchanges.IFC2X3.globalIds >= 8, "IFC2X3 carries GlobalIds for all roots");
  fs.writeFileSync(path.join(__dirname, "..", "docs", "ifc-exchange-report.json"), JSON.stringify(report, null, 2));
});

console.log(`\nIFC exchange comparison tests: ${passed} passed${process.exitCode ? " (FAILURES)" : ""}.`);
