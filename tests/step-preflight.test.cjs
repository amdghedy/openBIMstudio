/* Structural STEP pre-flight: accepts every corpus fixture, rejects structurally corrupt files, stays linear-time. */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "spf-"));
fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction");
execSync(`npx tsc src/modules/ifc-semantics/step-preflight.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const { preflightStep } = require(find(out, "step-preflight.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };
const enc = (s) => new Uint8Array(Buffer.from(s, "latin1"));
const dir = path.join(__dirname, "fixtures/ifc-corpus");
const good = fs.readdirSync(dir).filter((f) => f.endsWith(".ifc"));
for (const f of good) t(`valid fixture accepted: ${f}`, () => { const r = preflightStep(new Uint8Array(fs.readFileSync(path.join(dir, f)))); assert.ok(r.ok, JSON.stringify(r)); });
const MIN = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('a',$,'It''s',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
t("minimal file accepted", () => assert.ok(preflightStep(enc(MIN)).ok));
t("escaped quotes, comments and CRLF accepted", () => assert.ok(preflightStep(enc(MIN.replace("#1=", "/* c */ #1 = ").replace(/\n/g, "\r\n"))).ok));
t("raw UTF-8 inside a string accepted", () => assert.ok(preflightStep(new Uint8Array(Buffer.from(MIN.replace("It''s", "Café ''x''"), "utf8"))).ok));
const bad = {
  "empty": "", "not step": "hello", "truncated before tail": MIN.replace("END-ISO-10303-21;\n", ""),
  "truncated mid record": MIN.slice(0, MIN.indexOf("'It")),
  "unterminated string": MIN.replace("'It''s'", "'It''s"), "unterminated comment": MIN.replace("DATA;", "DATA; /* x"),
  "unbalanced close": MIN.replace("$,$,$);", "$,$,$));"), "unbalanced open": MIN.replace("$,$,$);\nENDSEC", "$,$,$;\nENDSEC"),
  "record without id": MIN.replace("#1=", "1="), "record without equals": MIN.replace("#1=IFC", "#1 IFC"),
  "control byte": MIN.replace("IFCPROJECT", "IFC\u0001PROJECT"), "high byte outside string": MIN.replace("IFCPROJECT", "IFCéPROJECT"),
  "content after tail": MIN + "#2=X();", "no DATA": MIN.replace("DATA;\n#1=IFCPROJECT('a',$,'It''s',$,$,$,$,$,$);\n", ""),
  "deep nesting": "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=X(" + "(".repeat(300) + ")".repeat(300) + ");\nENDSEC;\nEND-ISO-10303-21;\n",
};
for (const [name, text] of Object.entries(bad)) t(`rejected: ${name}`, () => { const r = preflightStep(enc(text)); assert.strictEqual(r.ok, false); assert.ok(r.reason); });
const mdir = path.join(dir, "malformed");
for (const f of fs.readdirSync(mdir).filter((x) => x.endsWith(".ifc"))) {
  t(`malformed regression fixture rejected before the parser: ${f}`, () => { const r = preflightStep(new Uint8Array(fs.readFileSync(path.join(mdir, f)))); assert.strictEqual(r.ok, false); assert.ok(r.reason); });
}
t("deterministic mutations: never throws; linear time on a 20 MB file", () => {
  let s = 12345; const rnd = (m) => (s = (1103515245 * s + 12345) & 0x7fffffff) % m;
  const seed = fs.readFileSync(path.join(dir, good[0]));
  for (let i = 0; i < 300; i++) { const b = Buffer.from(seed); for (let k = 0; k < 12; k++) b[rnd(b.length)] ^= 1 << rnd(8); preflightStep(new Uint8Array(b)); }
  const rec = "#1=IFCWALL('0',$,$,$,$,$,$,$);\n"; const body = rec.repeat(Math.ceil(20e6 / rec.length));
  const big = enc("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n" + body + "ENDSEC;\nEND-ISO-10303-21;\n");
  const t0 = Date.now(); const r = preflightStep(big); const ms = Date.now() - t0;
  assert.ok(r.ok); assert.ok(ms < 3000, `took ${ms} ms`);
});
t("rejects pathological integer tokens (>18 digits)", () => {
  const text = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCCARTESIANPOINT((1234567890123456789,0.,0.));\nENDSEC;\nEND-ISO-10303-21;\n";
  const r = preflightStep(enc(text));
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.match(String(r.reason), /Integer token longer/i);
});
t("accepted: real numbers with >18 fractional digits (Revit coordinates)", () => {
  // buildingSMART Duplex files, Revit 2011: coordinates like
  // -0.0009000000000002357 (19 fractional digits) and
  // 0.0005690557380592822 (22 fractional digits) used to trip the integer
  // cap and reject a real-world file at import.
  for (const coords of [
    "(-0.0009000000000002357,0.9798000000000015)",
    "(0.0005690557380592822,0.6787250124093189,0.02102290746273472)",
  ]) {
    const text = `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCCARTESIANPOINT(${coords});\nENDSEC;\nEND-ISO-10303-21;\n`;
    const r = preflightStep(enc(text));
    assert.ok(r.ok, `${coords}: ${JSON.stringify(r)}`);
  }
});
t("rejected: >18-digit integer part of a real is still an extreme integer", () => {
  const text = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCCARTESIANPOINT((1234567890123456789.5,0.,0.));\nENDSEC;\nEND-ISO-10303-21;\n";
  const r = preflightStep(enc(text));
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.match(String(r.reason), /Integer token longer/i);
});
// Issue #231: a '.' outside strings/comments is a real number or a
// well-formed '.NAME.' enumeration. A leading-dot-less enum name is read by
// web-ifc as a LABEL and the following '.' as an ENUM start that swallows
// ';' terminators up to the next '.' — OpenModel never terminates.
const ENUM_REC = (arg) => `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCSIUNIT(*,${arg},$,.METRE.);\nENDSEC;\nEND-ISO-10303-21;\n`;
for (const [name, arg] of [
  ["well-formed enumeration", ".LENGTHUNIT."],
  ["single-letter enumeration", ".T."],
  ["real with exponent, no fraction digits", "1.E-05"],
]) t(`accepted: ${name}`, () => assert.ok(preflightStep(enc(ENUM_REC(arg))).ok, arg));
for (const [name, arg] of [
  ["leading dot replaced by slash", "/MODEL_VIEW."],
  ["leading dot replaced by comma", ",MODEL_VIEW."],
  ["leading dot replaced by star", "*MODEL_VIEW."],
  ["leading dot replaced by letter", "nMODEL_VIEW."],
  ["leading dot replaced by ampersand", "&MODEL_VIEW."],
  ["trailing dot replaced by comma", ".MODEL_VIEW,"],
  ["label followed by dot, no opening dot", "MODEL_VIEW."],
  ["lone E, neither exponent nor enum", ".E,"],
]) t(`rejected: malformed enumeration (${name})`, () => {
  const r = preflightStep(enc(ENUM_REC(arg)));
  assert.strictEqual(r.ok, false, `${arg}: ${JSON.stringify(r)}`);
  assert.match(String(r.reason), /enumeration/i);
});
t("accepted: leading-dot real and trailing-dot real", () => {
  const text = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCCARTESIANPOINT((.5,1.,1.5));\nENDSEC;\nEND-ISO-10303-21;\n";
  assert.ok(preflightStep(enc(text)).ok);
});

console.log(`step-preflight: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
