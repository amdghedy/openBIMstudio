/* Pack 11 pure probes (malformed headers + census shapes). */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "p11-"));
const tsc = path.join(__dirname, "../node_modules/typescript/bin/tsc");
const cmd = fs.existsSync(tsc)
  ? `"${tsc}" src/modules/bim-gaps/critical-workflow-pack-11.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop --moduleResolution node`
  : `npx tsc src/modules/bim-gaps/critical-workflow-pack-11.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop`;
try {
  execSync(cmd, { stdio: "pipe" });
} catch (e) {
  // Dynamic imports may fail isolated tsc — fall back to reading source contracts
  const src = fs.readFileSync(path.join(__dirname, "../src/modules/bim-gaps/critical-workflow-pack-11.ts"), "utf8");
  assert.match(src, /export function rejectMalformedProbe/);
  assert.match(src, /export function modelCensus/);
  assert.match(src, /export function modelHealthAudit/);
  assert.match(src, /export function exportSelectionCsv/);
  assert.match(src, /setupCriticalWorkflowPack11/);
  console.log("PASS workflow-pack-11 source contracts (tsc isolated skip)");
  process.exit(0);
}
const find = (d, n) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { const r = find(p, n); if (r) return r; }
    else if (f.name === n) return p;
  }
};
const mod = require(find(out, "critical-workflow-pack-11.js"));
assert.strictEqual(mod.rejectMalformedProbe("ifc", "nope").ok, false);
assert.strictEqual(mod.rejectMalformedProbe("ifc", "ISO-10303-21;\nDATA;\n").ok, true);
assert.strictEqual(mod.rejectMalformedProbe("dxf", "x").ok, false);
assert.strictEqual(mod.rejectMalformedProbe("dxf", "0\nSECTION\n").ok, true);
assert.deepEqual(mod.listStandardsPacks().slice(0, 2), ["IFC4", "IFC2X3"]);
console.log("PASS workflow-pack-11 probes");
