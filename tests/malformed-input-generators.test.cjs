/* Bounded malformed-input generators for IFC, BCF and DXF (issue #99).
 *
 * Behaviour: run scripts/malformed-generators.mjs (seed 42) twice and
 * require byte-identical output (determinism); require every case to stay
 * inside the documented caps; then feed every case to the real guard or
 * parser and require a controlled outcome — a rejection, or a bounded
 * result — never a hang, a throw out of the guard, or an unbounded
 * allocation. IFC goes to the STEP pre-flight (never to web-ifc: the
 * malformed kinds are exactly the ones that hang OpenModel) plus the header
 * validator for header-content defects; BCF goes to the file-guard ZIP audit
 * + the BCF markup parser behind a strict XML shim (same DOM subset as
 * tests/bcf21-roundtrip.test.cjs, but strict: mismatched or unclosed tags
 * throw instead of being repaired) + the import's schema gate; DXF goes to
 * the platform DXF reader with a per-case wall-clock bound.
 *
 * X-4 adds the issue's missing categories — malformed headers and broken
 * references for all three formats (plus binary garbage for DXF) — the
 * import-flow ordering pins (a malformed file must never partially mutate
 * the active project), and the BCF guid-gate regression: the gate rejected
 * IFC GlobalId topic guids, so the valid control fixture itself failed it.
 *
 * Run: npm run test:malformed-generators
 */
const { execFileSync, execSync } = require("node:child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createHash } = require("node:crypto");
const JSZip = require("jszip");

const root = path.resolve(__dirname, "..");
const GEN = path.join(root, "scripts", "malformed-generators.mjs");
const SEED = 42, COUNT = 13;

let pass = 0, fail = 0;
const failures = [];
const pending = [];
const t = (n, f) => {
  try {
    const r = f();
    if (r && typeof r.then === "function") {
      pending.push(r.then(
        () => { pass++; console.log("  PASS " + n); },
        (e) => { fail++; failures.push(n + ": " + e.message); console.log("  FAIL " + n + ": " + e.message); },
      ));
      return;
    }
    pass++; console.log("  PASS " + n);
  } catch (e) { fail++; failures.push(n + ": " + e.message); console.log("  FAIL " + n + ": " + e.message); }
};

/* ── 1. Generate twice, require determinism + caps ─────────────────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-malformed-"));
const dirA = path.join(tmp, "a"), dirB = path.join(tmp, "b");
execFileSync(process.execPath, [GEN, "--seed", String(SEED), "--count", String(COUNT), "--out", dirA], { cwd: root, stdio: "pipe" });
execFileSync(process.execPath, [GEN, "--seed", String(SEED), "--count", String(COUNT), "--out", dirB], { cwd: root, stdio: "pipe" });
const manifestA = JSON.parse(fs.readFileSync(path.join(dirA, "cases.json"), "utf8"));
const manifestB = JSON.parse(fs.readFileSync(path.join(dirB, "cases.json"), "utf8"));
const byId = (dir) => {
  const m = JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf8"));
  return new Map(m.cases.map((c) => [c.id, c]));
};
const casesA = byId(dirA), casesB = byId(dirB);
const load = (dir, c) => fs.readFileSync(path.join(dir, c.file));

t("generator: same seed produces byte-identical cases (deterministic)", () => {
  assert.deepStrictEqual(manifestB, manifestA);
  for (const [id, c] of casesA) {
    assert.ok(casesB.has(id), `missing ${id} in second run`);
    assert.strictEqual(createHash("sha256").update(load(dirB, casesB.get(id))).digest("hex"), c.sha256, id);
  }
});

t("generator: caps respected (<=64 KiB per case, 13 cases per format)", () => {
  assert.strictEqual(manifestA.seed, SEED);
  for (const fmt of ["ifc", "bcf", "dxf"]) {
    const cs = manifestA.cases.filter((c) => c.format === fmt);
    assert.strictEqual(cs.length, COUNT, fmt);
    for (const c of cs) {
      assert.ok(c.bytes <= 64 * 1024, `${c.id}: ${c.bytes} bytes`);
      assert.strictEqual(load(dirA, c).length, c.bytes, c.id);
    }
  }
});

t("generator: --count clamps to the 100-case cap", () => {
  const dirC = path.join(tmp, "c");
  execFileSync(process.execPath, [GEN, "--format", "ifc", "--seed", "7", "--count", "1000", "--out", dirC], { cwd: root, stdio: "pipe" });
  const m = JSON.parse(fs.readFileSync(path.join(dirC, "cases.json"), "utf8"));
  assert.strictEqual(m.cases.length, 100);
});

/* ── 2. Compile the real modules under test ───────────────────────────── */
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-malformed-mod-"));
fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction");
execSync(
  "npx tsc src/modules/ifc-semantics/step-preflight.ts src/core/file-guard.ts " +
    "src/modules/issues/bcf-markup.ts src/modules/drawings/dxf-reader.ts src/core/safeLoad.ts " +
    "--rootDir src --outDir " + out + " --module commonjs --target es2020 --lib es2020,dom --skipLibCheck",
  { cwd: root, stdio: "inherit" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const { preflightStep, parseStepHeader } = require(find(out, "step-preflight.js"));
const G = require(find(out, "file-guard.js"));
const BCF = require(find(out, "bcf-markup.js"));
const { parseDxf } = require(find(out, "dxf-reader.js"));
const S = require(find(out, "safeLoad.js"));

/* ── 3. IFC: pre-flight, never web-ifc ─────────────────────────────────── */
const ifcCases = manifestA.cases.filter((c) => c.format === "ifc");
const MUST_REJECT = new Set(["unterminated-string", "broken-enum", "unbalanced-paren",
  "huge-integer", "deep-nesting", "semicolon-in-parens", "non-ascii-outside-string", "missing-tail"]);
t("ifc: pre-flight never throws and finishes the whole batch fast", () => {
  const t0 = Date.now();
  for (const c of ifcCases) {
    const r = preflightStep(new Uint8Array(load(dirA, c)));
    assert.ok(typeof r.ok === "boolean" && (r.ok || typeof r.reason === "string"), c.id);
  }
  assert.ok(Date.now() - t0 < 10000, `batch took ${Date.now() - t0} ms`);
});
for (const kind of MUST_REJECT) {
  t(`ifc: pre-flight rejects the ${kind} case`, () => {
    const c = ifcCases.find((x) => x.kind === kind);
    assert.ok(c, `no ${kind} case generated`);
    const r = preflightStep(new Uint8Array(load(dirA, c)));
    assert.strictEqual(r.ok, false, `${c.id}: accepted, must be rejected`);
    assert.ok(r.reason, `${c.id}: no reason`);
  });
}
t("ifc: bitflip/truncate cases are handled without throwing (accept or reject)", () => {
  for (const kind of ["bitflip", "truncate"]) {
    const c = ifcCases.find((x) => x.kind === kind);
    assert.ok(c, `no ${kind} case generated`);
    const r = preflightStep(new Uint8Array(load(dirA, c)));
    assert.ok(typeof r.ok === "boolean", c.id);
  }
});
/* X-4: malformed headers and broken references — the two issue categories
 * the generator did not cover. A missing FILE_SCHEMA keeps the file
 * structurally intact, so the pre-flight accepts it; the header validator
 * is the layer that must refuse it, with a reason naming FILE_SCHEMA. */
t("ifc: malformed-header is rejected by the header validator, not the pre-flight", () => {
  const c = ifcCases.find((x) => x.kind === "malformed-header");
  assert.ok(c, "no malformed-header case generated");
  const bytes = new Uint8Array(load(dirA, c));
  assert.strictEqual(preflightStep(bytes).ok, true, "structure is intact — the pre-flight must not reject a header-content defect");
  const hdr = parseStepHeader(bytes);
  assert.strictEqual(hdr.ok, false, "header parse must reject");
  assert.match(hdr.error ?? "", /FILE_SCHEMA/, "reason must name the missing FILE_SCHEMA");
  assert.throws(() => S.assertValidStepFileHeader(hdr.value, "m.ifc"), /STEP header failed validation/);
});
t("ifc: dangling-reference and extreme-count terminate fast without throwing", () => {
  for (const kind of ["dangling-reference", "extreme-count"]) {
    const c = ifcCases.find((x) => x.kind === kind);
    assert.ok(c, `no ${kind} case generated`);
    const t0 = Date.now();
    const r = preflightStep(new Uint8Array(load(dirA, c)));
    assert.ok(Date.now() - t0 < 2000, `${kind}: took ${Date.now() - t0} ms`);
    assert.ok(typeof r.ok === "boolean", c.id);
  }
});
t("ifc: the 1M-record cap rejects extreme counts fast (direct probe, not a generator case)", () => {
  // 1,000,001 minimal records (~10.9 MB) exceed the generator's 64 KiB cap
  // by design, so the cap is probed directly: the pre-flight must refuse
  // with the count reason, not hang or allocate proportionally.
  let text = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''), '2;1');\nFILE_NAME('m.ifc','2026-01-01T00:00:00',('a'),('o'),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";
  for (let i = 1; i <= 1_000_001; i++) text += `#${i}=$;\n`;
  text += "ENDSEC;\nEND-ISO-10303-21;\n";
  const t0 = Date.now();
  const r = preflightStep(new TextEncoder().encode(text));
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason ?? "", /exceeds 1000000 entity records/);
});

/* ── 4. BCF: ZIP audit + markup parser behind a strict XML shim ───────── */
/* Strict XML tree: same DOM subset parseBcfMarkup uses (querySelector,
 * children, tagName, getAttribute, textContent), but mismatched or
 * unclosed tags throw instead of being silently repaired. */
function parseXmlStrict(xml) {
  const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  let i = 0; const n = xml.length;
  const doc = { tagName: "#document", attrs: {}, childNodes: [], parent: null };
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  const addText = (s) => { if (s) top().childNodes.push({ tagName: "#text", text: decode(s), attrs: {}, childNodes: [], parent: top() }); };
  const nameRe = /[A-Za-z_:][\w.:-]*/y;
  while (i < n) {
    if (xml[i] === "<") {
      if (xml.startsWith("<!--", i)) {
        const e = xml.indexOf("-->", i + 4);
        if (e < 0) throw new Error("unclosed XML comment");
        i = e + 3; continue;
      }
      if (xml.startsWith("<?", i)) {
        const e = xml.indexOf("?>", i + 2);
        if (e < 0) throw new Error("unclosed processing instruction");
        i = e + 2; continue;
      }
      if (xml.startsWith("<!", i)) throw new Error("DOCTYPE/declaration not allowed in strict BCF markup");
      if (xml.startsWith("</", i)) {
        nameRe.lastIndex = i + 2;
        const m = nameRe.exec(xml);
        if (!m) throw new Error("malformed closing tag");
        const gt = xml.indexOf(">", nameRe.lastIndex);
        if (gt < 0) throw new Error("unclosed closing tag");
        if (top().tagName !== m[0]) throw new Error(`closing </${m[0]}> does not match open <${top().tagName}>`);
        stack.pop(); i = gt + 1; continue;
      }
      nameRe.lastIndex = i + 1;
      const m = nameRe.exec(xml);
      if (!m) throw new Error("malformed opening tag");
      const tag = m[0];
      const attrs = {};
      let j = nameRe.lastIndex, selfClose = false;
      for (;;) {
        while (j < n && /\s/.test(xml[j])) j++;
        if (xml.startsWith("/>", j)) { selfClose = true; j += 2; break; }
        if (xml[j] === ">") { j++; break; }
        if (j >= n) throw new Error(`unclosed tag <${tag}>`);
        nameRe.lastIndex = j;
        const am = nameRe.exec(xml);
        if (!am) throw new Error(`malformed attribute in <${tag}>`);
        j = nameRe.lastIndex;
        while (j < n && /\s/.test(xml[j])) j++;
        if (xml[j] !== "=") throw new Error(`attribute ${am[0]} without value`);
        j++;
        while (j < n && /\s/.test(xml[j])) j++;
        const q = xml[j];
        if (q !== '"' && q !== "'") throw new Error(`attribute ${am[0]} without quotes`);
        const e = xml.indexOf(q, j + 1);
        if (e < 0) throw new Error(`unterminated attribute ${am[0]}`);
        attrs[am[0]] = decode(xml.slice(j + 1, e));
        j = e + 1;
      }
      const el = { tagName: tag, attrs, childNodes: [], parent: top() };
      top().childNodes.push(el);
      if (!selfClose) stack.push(el);
      i = j; continue;
    }
    const lt = xml.indexOf("<", i);
    addText(xml.slice(i, lt < 0 ? n : lt));
    i = lt < 0 ? n : lt;
  }
  if (stack.length !== 1) throw new Error(`unclosed element <${top().tagName}> at end of input`);
  const finish = (el) => {
    el.children = el.childNodes.filter((c) => c.tagName !== "#text");
    el.textContent = el.childNodes.map((c) => (c.tagName === "#text" ? c.text : finish(c).textContent)).join("");
    el.getAttribute = (name) => (name in el.attrs ? el.attrs[name] : null);
    el.querySelector = (tag) => {
      for (const c of el.children) {
        if (c.tagName === tag) return c;
        const d = c.querySelector(tag);
        if (d) return d;
      }
      return null;
    };
    el.querySelectorAll = (tag) => {
      const outArr = [];
      for (const c of el.children) {
        if (c.tagName === tag) outArr.push(c);
        outArr.push(...c.querySelectorAll(tag));
      }
      return outArr;
    };
    return el;
  };
  return finish(doc);
}
BCF.setBcfDomParserFactory(() => ({ parseFromString: (xml) => parseXmlStrict(xml) }));

const bcfCases = manifestA.cases.filter((c) => c.format === "bcf");
const bcfByKind = (kind) => {
  const c = bcfCases.find((x) => x.kind === kind);
  assert.ok(c, `no BCF case ${kind}`);
  return { c, bytes: load(dirA, c) };
};
async function bcfMarkupText(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("bcf/topic-1/markup.bcf");
  return entry ? entry.async("string") : null;
}

t("bcf: valid control case passes the guards and parses to its topic", async () => {
  const { bytes } = bcfByKind("valid-bcf");
  assert.ok(G.guardSignature("bcf", bytes.subarray(0, 32)).ok, "signature");
  assert.ok(G.guardZipDirectory(bytes).ok, "zip audit");
  const topic = BCF.parseBcfMarkup(await bcfMarkupText(bytes));
  assert.strictEqual(topic.guid, "0XScRe4drE$QuCcyMkXutA");
  assert.strictEqual(topic.title, "Wall meets duct");
  // X-4 regression: the import's schema gate rejected this very topic —
  // its Guid is an IFC GlobalId, not an RFC 4122 UUID — so a valid BCF
  // file imported zero topics. The gate now accepts both guid shapes.
  assert.deepStrictEqual(S.validateBcfParsedTopic(topic), { ok: true });
  // And the writer keeps the IFC GlobalId instead of minting a fresh UUID.
  assert.ok(BCF.buildBcfMarkup(topic).includes('Guid="0XScRe4drE$QuCcyMkXutA"'), "writer must keep the IFC GlobalId");
});

t("bcf: bad-guid parses but the import's schema gate rejects the topic", async () => {
  const { bytes } = bcfByKind("bad-guid");
  assert.ok(G.guardZipDirectory(bytes).ok, "zip itself is well-formed");
  const topic = BCF.parseBcfMarkup(await bcfMarkupText(bytes));
  assert.strictEqual(topic.guid, "not-a-guid");
  const check = S.validateBcfParsedTopic(topic);
  assert.strictEqual(check.ok, false, "a non-guid must not pass the gate");
  assert.match((check.issues ?? []).join(";"), /RFC 4122 UUID or an IFC GlobalId/);
});
t("bcf: dangling-viewpoint has no viewpoint entry and the import guards the miss", async () => {
  const { bytes } = bcfByKind("dangling-viewpoint");
  assert.ok(G.guardZipDirectory(bytes).ok, "zip audit");
  const topic = BCF.parseBcfMarkup(await bcfMarkupText(bytes));
  assert.strictEqual(topic.guid, "0XScRe4drE$QuCcyMkXutA");
  const zip = await JSZip.loadAsync(bytes);
  assert.strictEqual(zip.file("bcf/topic-1/viewpoint.bcfv"), null, "the referenced viewpoint is absent");
  // The import reads the entry only behind `if (vpFile)` and falls back to
  // the default camera — a dangling reference must never crash the import.
  const importer = fs.readFileSync(path.join(root, "src/modules/issues/bcf.ts"), "utf8");
  assert.ok(importer.includes("if (vpFile)"), "import must guard the missing viewpoint file");
});
t("bcf: malformed version.bcf is advisory — guards pass and the topic imports", async () => {
  const { bytes } = bcfByKind("malformed-version");
  assert.ok(G.guardZipDirectory(bytes).ok, "zip audit");
  const topic = BCF.parseBcfMarkup(await bcfMarkupText(bytes));
  assert.strictEqual(topic.guid, "0XScRe4drE$QuCcyMkXutA");
  assert.deepStrictEqual(S.validateBcfParsedTopic(topic), { ok: true });
});

t("bcf: not-a-zip fails the signature guard", () => {
  const { bytes } = bcfByKind("not-a-zip");
  assert.ok(!G.guardSignature("bcf", bytes.subarray(0, 32)).ok);
});
for (const [kind, pattern] of [["truncated-zip", null], ["traversal-entry", "unsafe path"], ["zip-bomb-ratio", "ratio"]]) {
  t(`bcf: zip audit rejects the ${kind} case`, () => {
    const { bytes } = bcfByKind(kind);
    const r = G.guardZipDirectory(bytes);
    assert.ok(!r.ok, `${kind}: accepted, must be rejected (${JSON.stringify(r)})`);
    if (pattern) assert.match(r.reason, new RegExp(pattern), kind);
  });
}
t("bcf: malformed XML with an entity declaration fails the XML guard", async () => {
  const { bytes } = bcfByKind("malformed-xml-entity");
  const xml = await bcfMarkupText(bytes);
  assert.ok(xml, "no markup.bcf entry");
  assert.ok(!G.guardXmlText(xml).ok, "ENTITY declaration must be rejected");
});
for (const kind of ["malformed-xml-unclosed", "malformed-xml-no-topic"]) {
  t(`bcf: markup parser throws on the ${kind} case (never a silent topic)`, async () => {
    const { bytes } = bcfByKind(kind);
    assert.ok(G.guardZipDirectory(bytes).ok, "zip itself is well-formed");
    const xml = await bcfMarkupText(bytes);
    assert.throws(() => BCF.parseBcfMarkup(xml), kind);
  });
}
t("bcf: archive without markup.bcf passes the guards but yields no topic (detectable, not a crash)", async () => {
  for (const kind of ["missing-markup", "empty-zip"]) {
    const { bytes } = bcfByKind(kind);
    assert.ok(G.guardZipDirectory(bytes).ok, `${kind}: zip audit`);
    const zip = await JSZip.loadAsync(bytes);
    assert.strictEqual(zip.file("bcf/topic-1/markup.bcf"), null, kind);
  }
});

/* ── 5. DXF: reader terminates with a bounded result on every case ─────── */
const dxfCases = manifestA.cases.filter((c) => c.format === "dxf");
t("dxf: every generated case terminates within 2 s with a bounded result", () => {
  for (const c of dxfCases) {
    const text = load(dirA, c).toString("utf8");
    const t0 = Date.now();
    let doc = null, threw = null;
    try { doc = parseDxf(text); } catch (e) { threw = e; }
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `${c.id}: took ${ms} ms`);
    if (threw) continue; // throwing is a controlled outcome
    assert.ok(doc && Array.isArray(doc.entities), `${c.id}: no document`);
    assert.ok(doc.entities.length <= 10000, `${c.id}: ${doc.entities.length} entities`);
  }
});
t("dxf: valid control case parses to its LINE entity", () => {
  const c = dxfCases.find((x) => x.kind === "valid-dxf");
  const doc = parseDxf(load(dirA, c).toString("utf8"));
  assert.strictEqual(doc.entities.length, 1);
  assert.strictEqual(doc.entities[0].type, "LINE");
});
t("dxf: self-referencing and cyclic INSERTs terminate without exploding", () => {
  for (const kind of ["self-insert", "cycle-insert"]) {
    const c = dxfCases.find((x) => x.kind === kind);
    const t0 = Date.now();
    const doc = parseDxf(load(dirA, c).toString("utf8"));
    assert.ok(Date.now() - t0 < 2000, kind);
    assert.ok(doc.entities.length <= 100, `${kind}: ${doc.entities.length} entities`);
  }
});
/* X-4: malformed headers and broken references for DXF. $ACADVER is
 * advisory to the reader (it never gates on the version), so a garbage
 * value must not lose the drawing; an INSERT of an undefined block is
 * skipped and counted, never expanded or crashed. */
t("dxf: malformed-header keeps the drawing (garbage $ACADVER is advisory)", () => {
  const c = dxfCases.find((x) => x.kind === "malformed-header");
  assert.ok(c, "no malformed-header case generated");
  const doc = parseDxf(load(dirA, c).toString("utf8"));
  assert.strictEqual(doc.entities.length, 1);
  assert.strictEqual(doc.entities[0].type, "LINE");
});
t("dxf: dangling-insert is skipped and counted, never expanded", () => {
  const c = dxfCases.find((x) => x.kind === "dangling-insert");
  assert.ok(c, "no dangling-insert case generated");
  const doc = parseDxf(load(dirA, c).toString("utf8"));
  assert.strictEqual(doc.entities.length, 0);
  assert.strictEqual(doc.skipped && doc.skipped["INSERT (missing block)"], 1);
});
t("dxf: binary-garbage terminates with an empty document or a typed Error", () => {
  const c = dxfCases.find((x) => x.kind === "binary-garbage");
  assert.ok(c, "no binary-garbage case generated");
  const t0 = Date.now();
  let doc = null, threw = null;
  try { doc = parseDxf(load(dirA, c).toString("latin1")); } catch (e) { threw = e; }
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  if (threw) assert.ok(threw instanceof Error, "a throw must be a typed Error");
  else assert.ok(doc && Array.isArray(doc.entities) && doc.entities.length <= 100, "bounded result");
});

/* ── 6. Import flows: a malformed file must never partially mutate the
 * active project (issue #99 criterion 3). The parsers above run in
 * isolation; these pins prove the three app entry points validate BEFORE
 * they touch project state — same style as the safe-load ordering pins. */
t("import-flow: DXF parses fully before it is applied; merges refuse incomplete files up front", () => {
  const link = fs.readFileSync(path.join(root, "src/modules/cad-link/index.ts"), "utf8");
  const viewer = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  // readCadFile returns the parsed doc (or throws) — nothing is applied inside it.
  const parseAt = link.indexOf("parseDxf(await readDxfText(file, opts)");
  assert.ok(parseAt > 0, "readCadFile must parse before returning");
  assert.ok(link.indexOf("return { doc, summary, format: \"dxf\" }") > parseAt, "the doc is returned after the parse");
  // Merge paths require a structurally complete file; the refusal happens
  // before any text is read ("Nothing was imported").
  assert.ok(link.includes('throw new Error(`${c.reason}. Nothing was imported.`)'), "incomplete merge input must be refused with 'Nothing was imported'");
  assert.ok((viewer.match(/readCadFile\(f, \{ requireComplete: true/g) ?? []).length >= 2, "merge callers must pass requireComplete");
});
t("import-flow: BCF commits issues only after the whole per-topic loop", () => {
  const bcf = fs.readFileSync(path.join(root, "src/modules/issues/bcf.ts"), "utf8");
  const guardAt = bcf.indexOf("guardZipDirectory(bcfBytes)");
  const loopAt = bcf.indexOf("for (const path of markupPaths)");
  const commitAt = bcf.indexOf("if (imported.length) setIssues([...imported, ...getIssues()]);");
  assert.ok(guardAt > 0 && loopAt > guardAt, "zip audit must run before the per-topic loop");
  assert.ok(commitAt > loopAt, "setIssues must run after the per-topic loop, never inside it");
  // Per-topic failures throw inside the loop (topic skipped, others import);
  // the schema gate runs before any topic touches state.
  assert.ok(bcf.indexOf("validateBcfParsedTopic(parsed)") > loopAt, "schema gate must run inside the loop before state is touched");
  assert.ok(bcf.indexOf("validateBcfParsedTopic(parsed)") < bcf.indexOf("imported.push({"), "schema gate must run before the topic is collected");
});
t("import-flow: IFC loads fragments only after conversion succeeds", () => {
  const importer = fs.readFileSync(path.join(root, "src/features/importer.ts"), "utf8");
  const emptyAt = importer.indexOf('throw new Error(\n          "Converter returned empty data.');
  const loadAt = importer.indexOf("await ctx.fragments.core.load(fragBytes, { modelId })");
  const registerAt = importer.indexOf("registerModel(modelId);");
  assert.ok(emptyAt > 0 && loadAt > emptyAt, "an empty conversion result must throw before fragments load");
  assert.ok(registerAt > loadAt, "the model registers only after fragments load");
});

Promise.all(pending).then(() => {
  console.log(`\nMalformed-input generator tests: ${pass} passed, ${fail} failed.`);
  if (fail) { console.error("failures:\n" + failures.map((f) => " - " + f).join("\n")); process.exit(1); }
});
