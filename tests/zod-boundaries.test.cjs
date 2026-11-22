/**
 * tests/zod-boundaries.test.cjs — PE-20: Zod boundary discipline beyond JSON.
 *
 * Proves, per boundary, that malformed input is rejected with a typed
 * error (safeLoad stage "schema", a throwing validator, or a recorded
 * per-parameter error) and that valid files/fixtures still load unchanged:
 *   - project element contents (LegacyProjectJsonSchema — no more z.unknown())
 *   - clash scenario contents (ClashScenarioImportSchema)
 *   - DXF document model (validateDxfDocument / parseDxf gate)
 *   - IFC/STEP as far as Node can reach it (StepPreflightResultSchema +
 *     parseStepHeader; the web-ifc importer is browser-only and is NOT
 *     covered here — see the PR description)
 *   - BCF zip entries (parsed markup.bcf topic + viewpoint.bcfv viewpoint)
 *   - formula boundary (parameter declarations + expression identifiers)
 *   - the safe-load coverage audit enforces the new boundaries in CI
 *
 * Compiles the real modules with tsc (same pattern as
 * tests/safe-load.test.cjs / tests/dxf-malformed.test.cjs /
 * tests/bcf21-roundtrip.test.cjs); nothing is mocked.
 */
const { execSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-zod-boundaries-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction");
execSync(
  "npx tsc src/core/safeLoad.ts src/modules/drawings/dxf-reader.ts " +
  "src/modules/ifc-semantics/step-preflight.ts src/modules/issues/bcf-markup.ts " +
  "src/modules/families/formula-engine.ts src/modules/families/safe-expr.ts " +
  "src/modules/clash/scenario-io.ts " +
  "--outDir " + out + " --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0",
  { cwd: root, stdio: "inherit" },
);
const findJs = (name) => {
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (f.name === name) return p;
    }
    return null;
  };
  const found = walk(out);
  assert.ok(found, "expected compiled " + name);
  return found;
};
const safe = require(findJs("safeLoad.js"));
const dxf = require(findJs("dxf-reader.js"));
const preflight = require(findJs("step-preflight.js"));
const bcfMarkup = require(findJs("bcf-markup.js"));
const formula = require(findJs("formula-engine.js"));
const safeExpr = require(findJs("safe-expr.js"));
const scenarios = require(findJs("scenario-io.js"));

let pass = 0;
function t(name, fn) { fn(); pass++; console.log("  PASS " + name); }

/* ── Minimal XML-tree shim for parseBcfMarkup (same subset as
 * tests/bcf21-roundtrip.test.cjs — the parser's DOM contract) ────────── */
function parseXml(xml) {
  let i = 0;
  const n = xml.length;
  const doc = { tagName: "#document", attrs: {}, childNodes: [], parent: null };
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  const nameRe = /[A-Za-z_:][\w.:-]*/y;
  function readName() {
    nameRe.lastIndex = i;
    const m = nameRe.exec(xml);
    if (!m) throw new Error(`bad name at ${i}`);
    i = nameRe.lastIndex;
    return m[0];
  }
  function decodeEntities(s) {
    return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (m, e) => {
      if (e === "amp") return "&";
      if (e === "lt") return "<";
      if (e === "gt") return ">";
      if (e === "quot") return '"';
      if (e === "apos") return "'";
      if (e[1] === "x" || e[1] === "X") return String.fromCodePoint(parseInt(e.slice(2), 16));
      return String.fromCodePoint(parseInt(e.slice(1), 10));
    });
  }
  while (i < n) {
    if (xml.startsWith("<?", i)) { const e = xml.indexOf("?>", i); if (e < 0) throw new Error("unterminated PI"); i = e + 2; continue; }
    if (xml.startsWith("<!--", i)) { const e = xml.indexOf("-->", i); if (e < 0) throw new Error("unterminated comment"); i = e + 3; continue; }
    if (xml.startsWith("<!", i)) { const e = xml.indexOf(">", i); if (e < 0) throw new Error("unterminated doctype"); i = e + 1; continue; }
    if (xml.startsWith("</", i)) {
      i += 2;
      const name = readName();
      while (i < n && /\s/.test(xml[i])) i++;
      if (xml[i] !== ">") throw new Error(`expected > at ${i}`);
      i++;
      const node = top();
      if (node.tagName !== name) throw new Error(`mismatched </${name}>, open <${node.tagName}>`);
      stack.pop();
      continue;
    }
    if (xml[i] === "<") {
      i++;
      const name = readName();
      const node = { tagName: name, attrs: {}, childNodes: [], parent: top() };
      while (i < n && /\s/.test(xml[i])) i++;
      while (i < n && xml[i] !== ">" && !(xml[i] === "/" && xml[i + 1] === ">")) {
        const an = readName();
        while (i < n && /\s/.test(xml[i])) i++;
        let av = "";
        if (xml[i] === "=") {
          i++;
          const q = xml[i];
          if (q !== '"' && q !== "'") throw new Error(`attr ${an}: expected quote at ${i}`);
          const e = xml.indexOf(q, i + 1); if (e < 0) throw new Error("unterminated attr");
          av = xml.slice(i + 1, e); i = e + 1;
          while (i < n && /\s/.test(xml[i])) i++;
        }
        node.attrs[an] = decodeEntities(av);
      }
      let selfClose = false;
      if (xml[i] === "/") { selfClose = true; i++; }
      if (xml[i] !== ">") throw new Error(`expected > at ${i}`);
      i++;
      top().childNodes.push(node);
      if (!selfClose) stack.push(node);
      continue;
    }
    const e = xml.indexOf("<", i);
    const text = e < 0 ? xml.slice(i) : xml.slice(i, e);
    i = e < 0 ? n : e;
    if (text) top().childNodes.push({ textNode: true, value: decodeEntities(text) });
  }
  if (stack.length !== 1) throw new Error(`unclosed element <${top().tagName}>`);
  return doc;
}
function textOfNode(node) {
  let s = "";
  for (const c of node.childNodes) {
    if (c.textNode) s += c.value;
    else s += textOfNode(c);
  }
  return s;
}
function elementChildren(node) { return node.childNodes.filter((c) => !c.textNode); }
function descendants(node) {
  const out = [];
  for (const c of elementChildren(node)) { out.push(c); for (const d of descendants(c)) out.push(d); }
  return out;
}
function matchSelector(node, sel) {
  const parts = sel.split(">").map((p) => p.trim()).filter(Boolean);
  let cur = node;
  for (let k = parts.length - 1; k >= 0; k--) {
    if (!cur || cur.tagName !== parts[k]) return null;
    cur = cur.parent;
  }
  return node;
}
function makeElement(node) {
  return {
    tagName: node.tagName,
    get textContent() { return textOfNode(node); },
    get children() { return elementChildren(node).map(makeElement); },
    getAttribute(name) { return node.attrs[name] ?? null; },
    querySelector(sel) {
      const d = descendants(node).find((x) => !!matchSelector(x, sel));
      return d ? makeElement(d) : null;
    },
    querySelectorAll(sel) {
      return descendants(node).filter((x) => !!matchSelector(x, sel)).map(makeElement);
    },
  };
}
function makeDocument(node) {
  return {
    querySelector(sel) {
      const hit = descendants(node).find((x) => !!matchSelector(x, sel));
      return hit ? makeElement(hit) : null;
    },
    querySelectorAll(sel) {
      return descendants(node).filter((x) => !!matchSelector(x, sel)).map(makeElement);
    },
  };
}
bcfMarkup.setBcfDomParserFactory(() => ({
  parseFromString(xml, _mime) { return makeDocument(parseXml(xml)); },
}));

/* ── A. Project element contents ─────────────────────────────────────── */

const validWall = {
  id: "w1", type: "wall", name: "Wall 1",
  properties: { Mark: "W-1", Material: "Concrete" },
  params: { start: [0, 0], end: [6, 0], thickness: 0.2, height: 3, elevation: 0 },
  nativeGeometry: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
  ifc: { entity: "IfcWall", globalId: "0YvctVUKr0kugbFTf53O9L" },
  futureField: { whatever: true },
};

t("project element: valid authored element loads, unknown fields preserved (passthrough policy)", () => {
  const r = safe.safeLoad("p.obs.json", JSON.stringify({ id: "p1", elements: [validWall] }), safe.LegacyProjectJsonSchema);
  assert.strictEqual(r.ok, true, JSON.stringify(r.ok === false ? r.error : null));
  assert.strictEqual(r.value.elements[0].id, "w1");
  assert.deepStrictEqual(r.value.elements[0].nativeGeometry, validWall.nativeGeometry);
  assert.deepStrictEqual(r.value.elements[0].ifc, validWall.ifc);
  assert.deepStrictEqual(r.value.elements[0].futureField, { whatever: true });
  assert.strictEqual(r.value.elements[0].properties.Mark, "W-1");
});

t("project element: fixture-shaped elements load (no params, no name)", () => {
  const doc = { id: "p1", name: "Tower", createdAt: 1, updatedAt: 2, elements: [{ id: "w1", type: "wall" }], models: [] };
  assert.strictEqual(safe.safeLoad("p.obs.json", JSON.stringify(doc), safe.LegacyProjectJsonSchema).ok, true);
  const slab = { id: "f1", type: "slab", properties: { slope: 2 }, params: { polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] } };
  assert.strictEqual(safe.safeLoad("p.obs.json", JSON.stringify({ id: "p1", elements: [slab] }), safe.LegacyProjectJsonSchema).ok, true);
});

t("project element: missing id / unknown type / mistyped param reject the whole file at schema stage", () => {
  const cases = [
    [{ id: "", type: "wall" }],
    [{ type: "wall" }],
    [{ id: "e1", type: "mesh" }],
    [{ id: "e1", type: "wall", params: { height: "3" } }],
    [{ id: "e1", type: "wall", params: { polygon: "not-an-array" } }],
    [{ id: "e1", type: "wall", params: { start: [0, "x"] } }],
    [{ id: "e1", type: "wall", params: { doorPanel: "barn" } }],
    ["not-an-object"],
    [null],
  ];
  for (const elements of cases) {
    const r = safe.safeLoad("p.obs.json", JSON.stringify({ id: "p1", elements }), safe.LegacyProjectJsonSchema);
    assert.strictEqual(r.ok, false, JSON.stringify(elements) + " must be rejected");
    assert.strictEqual(r.error.stage, "schema");
  }
  // One bad element among good ones rejects the file — it is not silently admitted.
  const mixed = safe.safeLoad("p.obs.json",
    JSON.stringify({ id: "p1", elements: [validWall, { id: "bad", type: "nope" }] }),
    safe.LegacyProjectJsonSchema);
  assert.strictEqual(mixed.ok, false);
  assert.match(mixed.error.issues.join("; "), /elements\.1\.type/);
});

t("project element: non-finite param values are rejected (direct schema parse)", () => {
  assert.strictEqual(safe.ProjectElementSchema.safeParse({ id: "e1", type: "wall", params: { height: Infinity } }).success, false);
  assert.strictEqual(safe.ProjectElementSchema.safeParse({ id: "e1", type: "wall", params: { height: NaN } }).success, false);
  assert.strictEqual(safe.ProjectElementSchema.safeParse({ id: "e1", type: "wall", params: { height: 3 } }).success, true);
});

/* ── B. Clash scenario contents ──────────────────────────────────────── */

const writerScenario = {
  id: "s1", name: "Scenario", createdAt: 1700000000000, updatedAt: 1700000000000,
  testName: "Test 1", tolerance: 0.005, clearance: 0, cropMargin: 0.3,
  scope: "both", method: "convex-gjk", selectionA: ["wall"], selectionB: ["duct"],
  clashStates: { "c1": { status: "new", comments: [{ id: "cm1", author: "Ada", date: 1700000000000, text: "look" }], updatedAt: 1700000000000 } },
  lastRun: { total: 3, intersect: 1, touching: 1, clearance: 1, duplicate: 0, at: 1700000000000 },
};

t("clash scenario: the writer's own output passes the schema (both envelopes)", () => {
  // What serializeScenarios writes is exactly what the schema accepts.
  const roundTripped = scenarios.serializeScenarios([writerScenario]);
  assert.strictEqual(roundTripped.length, 1);
  assert.strictEqual(safe.safeLoad("s.json", JSON.stringify(roundTripped), safe.ClashScenarioImportSchema).ok, true);
  assert.strictEqual(safe.safeLoad("s.json", JSON.stringify({ scenarios: roundTripped }), safe.ClashScenarioImportSchema).ok, true);
});

t("clash scenario: bad contents rejected — empty id, numeric tolerance, bogus scope, bad state", () => {
  const cases = [
    [{ ...writerScenario, id: "" }],
    [{ ...writerScenario, tolerance: "0.005" }],
    [{ ...writerScenario, scope: "bogus-scope" }],
    [{ ...writerScenario, selectionA: "wall" }],
    [{ ...writerScenario, clashStates: { c1: { status: "new", comments: [{ id: "x", author: "A", date: "soon", text: "t" }], updatedAt: 1 } } }],
    [{ ...writerScenario, lastRun: { total: -1, intersect: 0, touching: 0, clearance: 0, duplicate: 0, at: 0 } }],
  ];
  for (const list of cases) {
    const r = safe.safeLoad("s.json", JSON.stringify(list), safe.ClashScenarioImportSchema);
    assert.strictEqual(r.ok, false, JSON.stringify(list).slice(0, 120) + " must be rejected");
    assert.strictEqual(r.error.stage, "schema");
  }
});

/* ── C. DXF document model ───────────────────────────────────────────── */

const SEED_DXF = [
  "0", "SECTION", "2", "HEADER",
  "9", "$ACADVER", "1", "AC1015",
  "9", "$INSUNITS", "70", "4",
  "0", "ENDSEC",
  "0", "SECTION", "2", "TABLES",
  "0", "TABLE", "2", "LAYER",
  "0", "LAYER", "2", "WALLS", "70", "0", "62", "7", "6", "CONTINUOUS",
  "0", "ENDTAB",
  "0", "ENDSEC",
  "0", "SECTION", "2", "ENTITIES",
  "0", "LINE", "8", "WALLS", "10", "0", "20", "0", "11", "5", "21", "0",
  "0", "CIRCLE", "8", "WALLS", "10", "2", "20", "2", "40", "1.5",
  "0", "ARC", "8", "WALLS", "10", "0", "20", "0", "40", "3", "50", "0", "51", "90",
  "0", "LWPOLYLINE", "8", "WALLS", "90", "3", "70", "1", "10", "0", "20", "0", "10", "4", "20", "0", "10", "4", "20", "3",
  "0", "TEXT", "8", "WALLS", "10", "1", "20", "1", "40", "0.2", "1", "Hello",
  "0", "ENDSEC",
  "0", "EOF",
].join("\n");

t("DXF: the ASCII reader's own document validates, and a 100k-entity document validates in-bounds", () => {
  const doc = dxf.parseDxf(SEED_DXF);
  assert.strictEqual(safe.validateDxfDocument(doc).ok, true);
  assert.strictEqual(doc.entities.length, 5);
  assert.strictEqual(doc.units, "mm");
  const big = ["0", "SECTION", "2", "ENTITIES"];
  for (let i = 0; i < 100000; i++) big.push("0", "LINE", "8", "0", "10", "0", "20", "0", "11", "1", "21", "1");
  big.push("0", "ENDSEC", "0", "EOF");
  const t0 = Date.now();
  const bigDoc = dxf.parseDxf(big.join("\n"));
  const ms = Date.now() - t0;
  assert.strictEqual(bigDoc.entities.length, 100000);
  assert.ok(ms < 3000, `100k-entity parse+validate took ${ms} ms (bound 3000)`);
  console.log(`    (100k-entity parse+validate: ${ms} ms)`);
});

t("DXF: tampered documents are rejected with named issues (gate, not silent admission)", () => {
  const doc = dxf.parseDxf(SEED_DXF);
  const bad = (mutate) => {
    const copy = JSON.parse(JSON.stringify(doc));
    mutate(copy);
    const r = safe.validateDxfDocument(copy);
    assert.strictEqual(r.ok, false, "tampered doc must be rejected");
    return r.issues.join("; ");
  };
  assert.match(bad((d) => { d.entities = "nope"; }), /entities/);
  assert.match(bad((d) => { d.entities[0] = { type: "SPLINE-ISH", layer: "0" }; }), /entities\.0\.type/);
  assert.match(bad((d) => { d.entities[1].radius = "1.5"; }), /radius/);
  assert.match(bad((d) => { d.layers = [{ color: 7 }]; }), /layers\.0\.name/);
  assert.match(bad((d) => { d.entities[4].height = "tall"; }), /height/);
  assert.match(bad((d) => { d.entities[0].start = { x: 0, y: 0, z: 0 }; d.entities[0].end = { x: 1 }; }), /end\.y/);
  assert.strictEqual(safe.DxfDocumentSchema.safeParse({ ...doc, entities: [{ ...doc.entities[0], start: { x: NaN, y: 0 } }] }).success, false);
  assert.throws(() => safe.assertValidDxfDocument({ layers: [], entities: [{ type: "LINE" }] }), /failed validation/);
});

/* ── D. IFC / STEP — as far as Node can reach ─────────────────────────── */

const VALID_STEP =
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n" +
  "FILE_NAME('a','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\n" +
  "DATA;\n#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);\n" +
  "#2=IFCCARTESIANPOINT((0.,1.5,-2.));\nENDSEC;\nEND-ISO-10303-21;\n";

t("IFC/STEP: valid header parses (IFC4) and every valid corpus file parses", () => {
  const enc = new TextEncoder();
  const r = preflight.parseStepHeader(enc.encode(VALID_STEP));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.value.fileSchema, "IFC4");
  assert.strictEqual(r.value.fileName, "a");
  const corpus = path.join(root, "tests/fixtures/ifc-corpus");
  const files = fs.readdirSync(corpus).filter((f) => f.endsWith(".ifc"));
  assert.ok(files.length >= 10, "expected the IFC corpus, found " + files.length);
  for (const f of files) {
    const h = preflight.parseStepHeader(new Uint8Array(fs.readFileSync(path.join(corpus, f))));
    assert.strictEqual(h.ok, true, f + " header must parse: " + JSON.stringify(h));
    assert.ok(h.value.fileSchema.length > 0, f);
  }
  console.log(`    (${files.length} corpus headers parsed)`);
});

t("IFC/STEP: header without FILE_SCHEMA / FILE_NAME, and truncated files, are rejected", () => {
  const enc = new TextEncoder();
  const noSchema = VALID_STEP.replace("FILE_SCHEMA(('IFC4'));", "");
  assert.strictEqual(preflight.parseStepHeader(enc.encode(noSchema)).ok, false);
  const noName = VALID_STEP.replace("FILE_NAME('a','',(''),(''),'','','');", "");
  assert.strictEqual(preflight.parseStepHeader(enc.encode(noName)).ok, false);
  assert.strictEqual(preflight.parseStepHeader(enc.encode(VALID_STEP.slice(0, 60))).ok, false);
  // Structural preflight still rejects truncations, and its result shape validates.
  const pre = preflight.preflightStep(enc.encode(VALID_STEP.slice(0, 120)));
  assert.strictEqual(pre.ok, false);
  assert.strictEqual(safe.StepPreflightResultSchema.safeParse(pre).success, true);
  assert.strictEqual(safe.StepPreflightResultSchema.safeParse({ ok: "yes" }).success, false);
  assert.strictEqual(safe.StepPreflightResultSchema.safeParse({ ok: false, line: -1 }).success, false);
  assert.throws(() => safe.assertValidStepPreflightResult({ ok: 1 }, "x.ifc"), /invalid result/);
  safe.assertValidStepPreflightResult({ ok: false, reason: "truncated", line: 4 }, "x.ifc");
});

t("IFC/STEP: the parsed header is Zod-validated at the load path (length caps)", () => {
  // parseStepHeader stays dependency-free for the fuzz harness, so the
  // schema's length caps are enforced by assertValidStepFileHeader, called
  // by the importer on the parsed header — not by the parser itself.
  const good = { fileSchema: "IFC4", fileName: "a", fileDescription: [] };
  safe.assertValidStepFileHeader(good, "a.ifc");
  assert.throws(
    () => safe.assertValidStepFileHeader({ ...good, fileSchema: "X".repeat(129) }, "a.ifc"),
    /STEP header failed validation/,
  );
  assert.throws(
    () => safe.assertValidStepFileHeader({ ...good, fileDescription: Array(101).fill("d") }, "a.ifc"),
    /STEP header failed validation/,
  );
});

t("IFC/STEP: the browser-only web-ifc path is stated out of Node reach (no fake cover)", () => {
  const importer = fs.readFileSync(path.join(root, "src/features/importer.ts"), "utf8");
  assert.match(importer, /parseStepHeader\(bytes\)/);
  assert.match(importer, /assertValidStepPreflightResult\(pre/);
  // PE-20: the parsed header is Zod-validated at the load path (the
  // preflight module itself stays dependency-free for the fuzz harness).
  assert.match(importer, /assertValidStepFileHeader\(header\.value/);
  assert.match(importer, /web-ifc/);
});

/* ── E. BCF zip entries ───────────────────────────────────────────────── */

const T0 = Date.parse("2026-03-05T10:20:30Z");
const T1 = Date.parse("2026-03-06T11:21:32Z");
const bcfTopic = {
  guid: "9b2f4c1e-1111-4222-8333-444455556666",
  topicType: "Issue",
  topicStatus: "In Progress",
  title: "Duct runs through wall",
  priority: "High",
  labels: ["Envelope", "MEP"],
  createdAt: T0,
  createdBy: "Ada Arch",
  modifiedAt: T1,
  modifiedBy: "Bob MEP",
  dueDate: T0,
  assignedTo: "Cara Str",
  description: "Clash description",
  comments: [
    { guid: "aa2f4c1e-1111-4222-8333-444455556666", author: "Bob MEP", date: T1, text: "Confirmed on site" },
  ],
};

t("BCF: the writer's own markup round-trips through parse + topic schema", () => {
  const xml = bcfMarkup.buildBcfMarkup(bcfTopic);
  const parsed = bcfMarkup.parseBcfMarkup(xml);
  assert.strictEqual(safe.validateBcfParsedTopic(parsed).ok, true);
  assert.strictEqual(parsed.title, bcfTopic.title);
  assert.strictEqual(parsed.comments.length, 1);
});

t("BCF: tampered parsed topics are rejected (bad guid, non-finite date, mistyped comment)", () => {
  const parsed = bcfMarkup.parseBcfMarkup(bcfMarkup.buildBcfMarkup(bcfTopic));
  const bad = (mutate) => {
    const copy = JSON.parse(JSON.stringify(parsed));
    mutate(copy);
    const r = safe.validateBcfParsedTopic(copy);
    assert.strictEqual(r.ok, false, "tampered topic must be rejected");
    return r.issues.join("; ");
  };
  assert.match(bad((p) => { p.guid = "not-a-uuid"; }), /guid/);
  assert.match(bad((p) => { p.createdAt = "yesterday"; }), /createdAt/);
  assert.match(bad((p) => { p.title = ""; }), /title/);
  assert.match(bad((p) => { p.comments[0].date = 1e999; }), /comments/);
  // Legacy empty guid is still accepted (importBCF falls back to the folder name).
  assert.strictEqual(safe.validateBcfParsedTopic({ ...parsed, guid: "" }).ok, true);
});

t("BCF: viewpoints validate — good camera passes, NaN camera / bad projection fail", () => {
  const good = {
    cam: [0, 10, 10], target: [0, 0, 0], projection: "perspective",
    up: [0, 1, 0], selection: { m1: [1, 2, 3] },
    clippingPlanes: [{ location: [0, 0, 0], direction: [0, 0, 1] }],
  };
  assert.strictEqual(safe.validateBcfViewpoint(good).ok, true);
  const ortho = { cam: [1, 2, 3], target: [0, 0, 0], projection: "orthographic", orthoScale: 2.5 };
  assert.strictEqual(safe.validateBcfViewpoint(ortho).ok, true);
  for (const badVp of [
    { ...good, cam: [0, NaN, 10] },
    { ...good, projection: "isometric" },
    { ...good, orthoScale: -1 },
    { ...good, selection: { m1: [1.5] } },
    { cam: [0, 10, 10] },
  ]) {
    assert.strictEqual(safe.validateBcfViewpoint(badVp).ok, false, JSON.stringify(badVp) + " must be rejected");
  }
  const bcf = fs.readFileSync(path.join(root, "src/modules/issues/bcf.ts"), "utf8");
  assert.match(bcf, /validateBcfParsedTopic\(parsed\)/);
  assert.match(bcf, /validateBcfViewpoint\(viewpoint\)/);
});

/* ── F. Formula boundary ──────────────────────────────────────────────── */

const decls = [
  { name: "width", type: "length", scope: "type", default: 2, editable: true },
  { name: "depth", type: "length", scope: "type", default: 0, editable: true, formula: "width * 3" },
  { name: "area", type: "area", scope: "instance", default: 0, editable: true, formula: "width * depth" },
  { name: "diag", type: "length", scope: "instance", default: 0, editable: true, formula: "sqrt(width ^ 2 + depth ^ 2)" },
  { name: "label", type: "text", scope: "instance", default: "W", editable: true, formula: "\"W-\" + width" },
];

t("formula: valid declarations + builtins evaluate unchanged", () => {
  const r = formula.evaluateParameters(decls, {});
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.values.depth, 6);
  assert.strictEqual(r.values.area, 12);
  assert.ok(Math.abs(r.values.diag - Math.sqrt(40)) < 1e-12, String(r.values.diag));
  assert.strictEqual(r.values.label, "W-2");
  // Seed-only names stay referenceable; string literals are never mistaken for names.
  const r2 = formula.evaluateParameters(
    [{ name: "a", type: "number", scope: "instance", default: 0, editable: true, formula: "seeded + 1" }],
    { seeded: 41 },
  );
  assert.deepStrictEqual(r2.errors, []);
  assert.strictEqual(r2.values.a, 42);
  assert.strictEqual(formula.evaluateFormula("width * 2", { width: 3 }), 6);
  assert.strictEqual(formula.evaluateFormula("\"width\" + \"x\"", {}), "widthx");
});

t("formula: unknown names and bad declarations are recorded per-parameter, not thrown", () => {
  const r = formula.evaluateParameters([
    { name: "ok", type: "number", scope: "instance", default: 1, editable: true, formula: "1 + 1" },
    { name: "bad", type: "number", scope: "instance", default: 0, editable: true, formula: "nope + 1" },
    { name: "my param", type: "number", scope: "instance", default: 0, editable: true, formula: "1" },
    { name: "weird", type: "colour", scope: "sideways", default: 0, editable: true },
    { name: "toolong", type: "number", scope: "instance", default: 0, editable: true, formula: "1+" + "1".repeat(3000) },
  ], {});
  assert.strictEqual(r.values.ok, 2, "the good parameter still evaluates");
  assert.strictEqual(r.values.bad, 0, "the unknown-name parameter keeps its default");
  const byParam = new Map(r.errors.map((e) => [e.parameter, e.message]));
  assert.match(byParam.get("bad"), /Unknown name "nope"/);
  assert.match(byParam.get("my param"), /Invalid parameter declaration/);
  assert.match(byParam.get("weird"), /Invalid parameter declaration/);
  assert.match(byParam.get("toolong"), /Unknown name|2000|too long/i);
  assert.strictEqual(formula.evaluateFormula("nope + 1", {}), null);
  assert.strictEqual(formula.evaluateFormula("", {}), null);
  assert.strictEqual(formula.evaluateFormula("1 +", { }), null);
  // The validator itself never throws and names the unknown identifier.
  const v = safeExpr.validateFormulaExpression("a + missing", new Set(["a"]));
  assert.strictEqual(v.ok, false);
  assert.match(v.issues.join("; "), /Unknown name "missing"/);
  assert.strictEqual(safeExpr.validateFormulaExpression("a + 1", new Set(["a"])).ok, true);
});

/* ── G. Coverage audit enforces the new boundaries ───────────────────── */

t("coverage audit: passes and lists the PE-20 boundaries + hub schemas", () => {
  const audit = fs.readFileSync(path.join(root, "scripts/check-safe-load-coverage.mjs"), "utf8");
  for (const marker of [
    "src/modules/drawings/dxf-reader.ts",
    "src/modules/ifc-semantics/step-preflight.ts",
    "src/features/importer.ts",
    "src/modules/issues/bcf.ts",
    "src/modules/families/formula-engine.ts",
    "ProjectElementSchema",
    "ClashScenarioSchema",
    "DxfDocumentSchema",
    "z.array(z.unknown())",
  ]) {
    assert.ok(audit.includes(marker), "audit must mention " + marker);
  }
  const run = spawnSync("node", ["scripts/check-safe-load-coverage.mjs"], { cwd: root, encoding: "utf8" });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /17 required boundaries/);
});

console.log(`=== zod-boundaries: ${pass} passed ===`);
