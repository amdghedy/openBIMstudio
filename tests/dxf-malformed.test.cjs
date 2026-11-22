/* Bounded, seeded malformed-DXF generators: parseDxf must stay fast, return a document or a typed Error, and never emit non-finite geometry.
 * Replay with DXF_SEED=<n>. Counterexamples are printed; promote any failure into tests/fixtures/dxf-malformed/. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "dxf-mal-"));
fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction");
execSync(`npx tsc src/modules/drawings/dxf-reader.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe", cwd: path.join(__dirname, "..") });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const { parseDxf } = require(find(out, "dxf-reader.js"));
const SEED = Number(process.env.DXF_SEED ?? 4242); let st = SEED >>> 0;
const rnd = () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return ((st >>> 8) & 0xffffff) / 0x1000000; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1)); const pick = (x) => x[int(0, x.length - 1)];
const D = (...a) => a.flat().map(String).join("\n");
const sec = (n, b) => D("0", "SECTION", "2", n, b, "0", "ENDSEC");
const SEEDFILE = D(sec("HEADER", D("9", "$ACADVER", "1", "AC1015", "9", "$INSUNITS", "70", "4")),
  sec("TABLES", D("0", "TABLE", "2", "LAYER", "0", "LAYER", "2", "WALLS", "70", "0", "62", "7", "6", "CONTINUOUS", "0", "ENDTAB")),
  sec("BLOCKS", D("0", "BLOCK", "2", "B1", "70", "0", "10", "0", "20", "0", "0", "LINE", "8", "0", "10", "0", "20", "0", "11", "1", "21", "1", "0", "ENDBLK")),
  sec("ENTITIES", D("0", "LINE", "8", "WALLS", "10", "0", "20", "0", "11", "5", "21", "0",
    "0", "CIRCLE", "8", "WALLS", "10", "2", "20", "2", "40", "1.5",
    "0", "ARC", "8", "WALLS", "10", "0", "20", "0", "40", "3", "50", "0", "51", "90",
    "0", "LWPOLYLINE", "8", "WALLS", "90", "3", "70", "1", "10", "0", "20", "0", "10", "4", "20", "0", "10", "4", "20", "3",
    "0", "TEXT", "8", "WALLS", "10", "1", "20", "1", "40", "0.2", "1", "Hello",
    "0", "INSERT", "8", "WALLS", "2", "B1", "10", "3", "20", "3")), "0", "EOF");
const lines = SEEDFILE.split("\n");
function mutate() {
  let L = lines.slice();
  const k = int(0, 9);
  if (k === 0) return L.slice(0, int(1, L.length - 1)).join("\n");                                     // truncate
  if (k === 1) { for (let i = 0; i < int(1, 8); i++) L.splice(int(0, L.length - 1), 1); }                // delete lines
  if (k === 2) { for (let i = 0; i < int(1, 8); i++) L[int(0, L.length - 1)] = pick(["NaN", "Infinity", "-1e999", "1e999", "abc", "", " ", "0x10", "--5", "9".repeat(400)]); }
  if (k === 3) { for (let i = 0; i < int(1, 6); i++) L.splice(int(0, L.length - 1), 0, pick(["0", "10", "999", "-1", "70", "90", "2147483647"])); } // desync code/value pairs
  if (k === 4) { const i = L.indexOf("LWPOLYLINE"); if (i > 0) L[i + 4] = pick(["2147483647", "-5", "1000000000", "3.7"]); } // absurd vertex count
  if (k === 5) { const i = L.indexOf("40"); if (i > 0) L[i + 1] = pick(["0", "-3", "1e308", "NaN"]); }
  if (k === 6) { const b = L.indexOf("INSERT"); if (b > 0) L.splice(b, 0, ...["0", "INSERT", "8", "0", "2", "B1", "41", "1e308", "42", "1e-308", "50", "1e30", "10", "1e300", "20", "1e300"]); }
  if (k === 7) { L = L.join("\n").replace(/\n/g, pick(["\r\n", "\r", "\n\n"])).split("\n"); }
  if (k === 8) { const s = L.join("\n"); return s.slice(0, int(1, s.length - 1)) + Buffer.from(Array.from({ length: int(1, 40) }, () => int(0, 255))).toString("latin1") + s.slice(int(1, s.length - 1)); }
  if (k === 9) { L = L.concat(Array.from({ length: int(1000, 4000) }, (_, i) => (i % 2 ? "LINE" : "0"))); }
  return L.join("\n");
}
// Self-referencing / mutually recursive blocks must terminate
const RECURSIVE = D(sec("BLOCKS", D("0", "BLOCK", "2", "A", "70", "0", "10", "0", "20", "0", "0", "INSERT", "8", "0", "2", "B", "10", "0", "20", "0", "0", "ENDBLK", "0", "BLOCK", "2", "B", "70", "0", "10", "0", "20", "0", "0", "INSERT", "8", "0", "2", "A", "10", "0", "20", "0", "0", "ENDBLK")),
  sec("ENTITIES", D("0", "INSERT", "8", "0", "2", "A", "10", "0", "20", "0")), "0", "EOF");
const finiteDeep = (v, path = "") => { if (typeof v === "number") return Number.isFinite(v) ? null : path; if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = finiteDeep(v[i], path + "[" + i + "]"); if (r) return r; } } else if (v && typeof v === "object") for (const k of Object.keys(v)) { const r = finiteDeep(v[k], path + "." + k); if (r) return r; } return null; };
let n = 0, rejected = 0, accepted = 0; const bad = [];
const check = (name, text) => {
  const t0 = Date.now(); let doc, err;
  try { doc = parseDxf(text); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  if (ms > 3000) bad.push(`${name}: took ${ms} ms`);
  if (err) { rejected++; if (!(err instanceof Error) || !err.message) bad.push(`${name}: non-Error throw`); }
  else { accepted++; const nf = finiteDeep(doc.entities ?? doc, "entities"); if (nf) bad.push(`${name}: non-finite value at ${nf}`); }
  n++;
};
check("seed file", SEEDFILE); assert.deepStrictEqual(bad, [], "pristine seed must parse cleanly");
check("recursive blocks", RECURSIVE);
for (let i = 0; i < 400; i++) { const m = mutate(); check(`mutation #${i} (seed ${SEED})`, m); if (bad.length) { fs.mkdirSync(path.join(os.tmpdir(), "dxf-counterexamples"), { recursive: true }); fs.writeFileSync(path.join(os.tmpdir(), "dxf-counterexamples", `seed${SEED}-${i}.dxf`), m); } }
for (const [name, text] of [["empty", ""], ["only EOF", "0\nEOF"], ["binary DXF sentinel", "AutoCAD Binary DXF\r\n\x1a\x00\x00"], ["100k entities", sec("ENTITIES", D(Array.from({ length: 100000 }, () => D("0", "LINE", "8", "0", "10", "0", "20", "0", "11", "1", "21", "1")))) + "\n0\nEOF"]]) check(name, text);
if (bad.length) { console.error("MALFORMED-DXF FAILURES (seed " + SEED + "):\n" + bad.slice(0, 15).join("\n")); process.exit(1); }
console.log(`=== malformed DXF: ${n} inputs (${accepted} parsed, ${rejected} rejected with Error), seed ${SEED}, all bounded + finite ===`);
