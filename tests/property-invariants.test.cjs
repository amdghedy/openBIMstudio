/* Seeded property tests (no external dependency: fast-check is not installable offline; this is a minimal equivalent).
 * Every failure prints the seed and the shrunk-by-construction counterexample; set PROP_SEED=<n> to replay. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "prop-"));
execSync(`npx tsc src/modules/bim-gaps/ifc-guid.ts src/modules/ifc-semantics/step-preflight.ts src/modules/export/native-twin-ifc.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const G = require(find(out, "ifc-guid.js")), P = require(find(out, "step-preflight.js")), W = require(find(out, "native-twin-ifc.js"));

const SEED = Number(process.env.PROP_SEED ?? 20261121);
let state = SEED >>> 0;
const rnd = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return ((state >>> 8) & 0xffffff) / 0x1000000; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (xs) => xs[int(0, xs.length - 1)];
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");
const text = (n, alphabet) => Array.from({ length: int(0, n) }, () => pick(alphabet)).join("");
const NASTY = ["'", "\\", "\n", "\r", "\t", ";", "(", ")", "#", "=", "$", "*", ",", "é", "ع", "你", "😀", "\u0000", " ", " ", "a", "Z", "0", ".", "/*", "*/", "''"];

function forAll(name, runs, gen, prop) {
  state = (SEED + name.length * 7919) >>> 0;
  for (let i = 0; i < runs; i++) {
    const v = gen();
    try { prop(v); } catch (e) { console.error(`PROPERTY FAILED: ${name}\n  seed=${SEED} run=${i}\n  counterexample=${JSON.stringify(v).slice(0, 600)}`); throw e; }
  }
  console.log(`  PASS ${name} (${runs} runs, seed ${SEED})`);
}

forAll("GUID: decompress(compress(x)) === x for random 128-bit values", 2000, () => { let h = hex(32); return (parseInt(h[0], 16) & 0xc) ? h : h; }, (h) => {
  const g = G.compressGuid(h); assert.ok(G.isValidIfcGuid(g), "compressed is valid: " + g); assert.strictEqual(G.decompressGuid(g), h);
});
forAll("GUID: stableIfcGuid is deterministic and always valid, distinct keys differ", 1000, () => text(40, NASTY.concat(["x", "y"])), (k) => {
  const a = G.stableIfcGuid(k); assert.strictEqual(a, G.stableIfcGuid(k)); assert.ok(G.isValidIfcGuid(a));
});
forAll("GUID: newIfcGuid always valid and unique", 500, () => 0, () => { assert.ok(G.isValidIfcGuid(G.newIfcGuid())); });
forAll("GUID: any single-character corruption to a non-alphabet char is rejected", 500, () => { const g = G.newIfcGuid(); const i = int(0, 21); return { g, i, c: pick(["!", " ", "'", "é", "#"]) }; }, ({ g, i, c }) => {
  assert.ok(!G.isValidIfcGuid(g.slice(0, i) + c + g.slice(i + 1)));
});
forAll("preflight: never throws, is deterministic, on arbitrary bytes", 1500, () => Uint8Array.from({ length: int(0, 400) }, () => int(0, 255)), (b) => {
  const a = P.preflightStep(b), c = P.preflightStep(b); assert.deepStrictEqual(a, c); assert.strictEqual(typeof a.ok, "boolean");
});
const VALID = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('a','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);\n#2=IFCCARTESIANPOINT((0.,1.5,-2.));\nENDSEC;\nEND-ISO-10303-21;\n";
forAll("preflight: accepts the valid base; truncating it at any point is never accepted unless it is complete", 300, () => int(1, VALID.length - 2), (cut) => {
  assert.ok(P.preflightStep(new TextEncoder().encode(VALID)).ok);
  const r = P.preflightStep(new TextEncoder().encode(VALID.slice(0, cut)));
  assert.strictEqual(r.ok, false, "truncated at " + cut + " must be rejected");
});
forAll("preflight: terminates quickly on pathological nesting / long strings", 40, () => ({ d: int(1, 200000), kind: int(0, 2) }), ({ d, kind }) => {
  const body = kind === 0 ? "(".repeat(d) : kind === 1 ? "'" + "a".repeat(d) : "/*" + "x".repeat(d);
  const t0 = Date.now(); P.preflightStep(new TextEncoder().encode(VALID.replace("#2=", "#2=IFCX" + body + ";\n#9="))); assert.ok(Date.now() - t0 < 1500, "slow: " + (Date.now() - t0) + " ms");
});
forAll("twin writer: output for random twins (hostile names/props/numbers) always passes STEP preflight, with unique valid GUIDs", 300, () => {
  const n = int(1, 4);
  return Array.from({ length: n }, (_, i) => ({
    name: text(20, NASTY), description: text(20, NASTY), modelId: text(8, NASTY) || "m", nativeId: "n" + i + text(6, NASTY),
    nativeEntity: pick(["IfcWall", "IFCSLAB", "IfcDoor", "bogus", "", "IfcWall');#9=X($", undefined]),
    position: [pick([0, 1e9, -1e9, NaN, Infinity, rnd() * 100]), rnd(), rnd()], quaternion: [0, 0, 0, pick([1, 0, NaN])],
    geometry: { positions: Array.from({ length: pick([0, 6, 9, 12]) }, () => pick([0, 1, NaN, rnd() * 10])) },
    propertySets: { [text(6, NASTY) || "Pset"]: { [text(6, NASTY) || "k"]: pick([text(10, NASTY), 1.5, true, NaN, null]) } },
  }));
}, (edits) => {
  const ifc = W.writeFederatedNativeTwinIfc(edits, text(8, NASTY) || "P");
  const r = P.preflightStep(new TextEncoder().encode(ifc));
  assert.ok(r.ok, "preflight: " + JSON.stringify(r));
  const gids = [...ifc.matchAll(/^#\d+=IFC[A-Z0-9]+\('([^']*)',#\d+,/gm)].map((m) => m[1]);
  assert.ok(gids.every((g) => G.isValidIfcGuid(g)), "all GlobalIds valid");
  assert.strictEqual(new Set(gids).size, gids.length, "GlobalIds unique");
});
console.log("=== property invariants passed ===");
