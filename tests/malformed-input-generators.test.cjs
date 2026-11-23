/* Bounded malformed-input generators for IFC, BCF and DXF (issue #99).
 *
 * Behaviour: run scripts/malformed-generators.mjs (seed 42) twice and
 * require byte-identical output (determinism); require every case to stay
 * inside the documented caps; then feed every case to the real guard or
 * parser and require a controlled outcome — a rejection, or a bounded
 * result — never a hang, a throw out of the guard, or an unbounded
 * allocation. IFC goes to the STEP pre-flight (never to web-ifc: the
 * malformed kinds are exactly the ones that hang OpenModel). BCF goes to
 * the file-guard ZIP audit + the BCF markup parser behind a strict XML
 * shim (same DOM subset as tests/bcf21-roundtrip.test.cjs, but strict:
 * mismatched or unclosed tags throw instead of being repaired). DXF goes
 * to the platform DXF reader with a per-case wall-clock bound.
 *
 * Run: npm run test:malformed-generators
 */
const { execFileSync, execSync } = require("node:child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { createHash } = require("node:crypto");
const JSZip = require("jszip");

const root = path.resolve(__dirname, "..");
const GEN = path.join(root, "scripts", "malformed-generators.mjs");
const SEED = 42, COUNT = 10;

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

t("generator: caps respected (<=64 KiB per case, 10 cases per format)", () => {
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
    "src/modules/issues/bcf-markup.ts src/modules/drawings/dxf-reader.ts " +
    "--rootDir src --outDir " + out + " --module commonjs --target es2020 --lib es2020,dom --skipLibCheck",
  { cwd: root, stdio: "inherit" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const { preflightStep } = require(find(out, "step-preflight.js"));
const G = require(find(out, "file-guard.js"));
const BCF = require(find(out, "bcf-markup.js"));
const { parseDxf } = require(find(out, "dxf-reader.js"));

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

Promise.all(pending).then(() => {
  console.log(`\nMalformed-input generator tests: ${pass} passed, ${fail} failed.`);
  if (fail) { console.error("failures:\n" + failures.map((f) => " - " + f).join("\n")); process.exit(1); }
});
