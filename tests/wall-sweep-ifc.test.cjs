// Wall sweeps (baseboard / cornice / wainscot) are exported as IfcCovering elements.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-sweep-ifc-"));
execFileSync("npx", ["tsc", "--rootDir", "src", "--outDir", out, "--module", "commonjs", "--target", "ES2022", "--skipLibCheck", "--noCheck", "src/modules/bim-gaps/authored-ifc.ts"], { stdio: "inherit" });
const { exportAuthoredToIfc } = require(path.join(out, "modules/bim-gaps/authored-ifc.js"));
const levels = [{ id: "L0", name: "L0", elevation: 0 }];
const sweeps = [
  { wallId: "w1", profileId: "baseboard-100", height: 0, face: "both" },
  { wallId: "w1", profileId: "cornice-standard", height: 2.88, face: "both" },
  { wallId: "w1", profileId: "wainscot-1200", height: 0, face: "interior" },
  { wallId: "w1", profileId: "reveal-10", height: 1, face: "exterior" },
];
const wall = { id: "w1", type: "wall", name: "Wall A", levelId: "L0", params: { start: [0, 0], end: [6, 0], height: 3, thickness: 0.2, elevation: 0, sweeps } };
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const cov = (text) => text.split("\n").filter((l) => /=IFCCOVERING\(/.test(l));
t("IFC4: baseboard, cornice and wainscot become IfcCovering with proper types", () => {
  const r = exportAuthoredToIfc([wall], { schema: "IFC4", levels });
  const c = cov(r.text);
  assert.strictEqual(c.length, 3);
  assert.ok(c.some((l) => l.includes(".SKIRTINGBOARD.")) && c.some((l) => l.includes(".MOLDING.")) && c.some((l) => l.includes(".CLADDING.")));
  assert.ok(/IFCTRIANGULATEDFACESET/.test(r.text));
  assert.ok(!/NaN|Infinity|undefined/.test(r.text));
});
t("IFC2X3: sweeps are exported with a valid predefined type", () => {
  const c = cov(exportAuthoredToIfc([wall], { schema: "IFC2X3", levels }).text);
  assert.strictEqual(c.length, 3);
  for (const l of c) assert.ok(/\.(NOTDEFINED|CLADDING)\.\);$/.test(l), l);
});
t("reveals are exported as an IfcOpeningElement that voids the wall", () => {
  const r = exportAuthoredToIfc([wall], { schema: "IFC4", levels });
  assert.ok(!r.stats.skipped.some((s) => /reveal/i.test(s.reason)), "not skipped");
  const open = r.text.split("\n").filter((l) => /=IFCOPENINGELEMENT\(/.test(l) && l.includes("Reveal"));
  assert.strictEqual(open.length, 1);
  assert.ok(open[0].includes(".RECESS."));
  assert.ok(/=IFCRELVOIDSELEMENT\(/.test(r.text));
  assert.ok(!/NaN|Infinity|undefined/.test(r.text));
});
t("sweep geometry is storey-relative and sits on the wall", () => {
  const r = exportAuthoredToIfc([{ ...wall, params: { ...wall.params, sweeps: [sweeps[0]] } }], { schema: "IFC4", levels });
  const line = r.text.split("\n").find((l) => /=IFCCARTESIANPOINTLIST3D\(/.test(l));
  const pts = [...line.matchAll(/\(([-\d.eE]+),([-\d.eE]+),([-\d.eE]+)\)/g)].map((m) => m.slice(1).map(Number));
  assert.ok(Math.min(...pts.map((p) => p[2])) > -1e-6 && Math.max(...pts.map((p) => p[2])) < 0.11, "baseboard height ~0.1 m");
  assert.ok(Math.max(...pts.map((p) => p[0])) > 5.9, "runs along the 6 m wall");
});
t("a wall without sweeps exports no coverings", () => {
  assert.strictEqual(cov(exportAuthoredToIfc([{ ...wall, params: { ...wall.params, sweeps: undefined } }], { schema: "IFC4", levels }).text).length, 0);
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
