const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
execSync(`npx tsc src/modules/cad-viewer/session-state.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const S = require(find(out, "session-state.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };
const BG = ["drafting", "white", "black"], SN = ["end", "mid", "cen"];
t("valid settings round-trip", () => {
  const ui = { bg: "white", cmode: "bw", snapOn: false, orthoOn: true, polarAngle: 45, lwtOn: false, showGrid: false, snapModes: ["end", "mid"], typeFilter: ["LINE"], currentLayer: "A-WALL", lockedLayers: ["A-ANNO"] };
  assert.deepStrictEqual(S.sanitizeSessionUi(JSON.parse(JSON.stringify(ui)), BG, SN), ui);
});
t("junk, wrong types and unknown values are dropped, never thrown", () => {
  const r = S.sanitizeSessionUi({ bg: "neon", cmode: "weird", snapOn: "yes", polarAngle: -5, snapModes: ["end", "warp"], typeFilter: [1, "LINE", ""], currentLayer: 7, lockedLayers: "x" }, BG, SN);
  assert.deepStrictEqual(r, { snapModes: ["end"], typeFilter: ["LINE"] });
});
t("non-objects give an empty result", () => { for (const v of [null, undefined, 5, "x", []]) assert.deepStrictEqual(S.sanitizeSessionUi(v, BG, SN), {}); });
t("lists are capped so a corrupted store cannot balloon", () => {
  const r = S.sanitizeSessionUi({ lockedLayers: Array.from({ length: 9000 }, (_, i) => "L" + i) }, BG, SN); assert.strictEqual(r.lockedLayers.length, 5000);
});
t("signature changes with the settings and not otherwise", () => {
  assert.strictEqual(S.sessionUiSignature({ snapOn: true }), S.sessionUiSignature({ snapOn: true })); assert.notStrictEqual(S.sessionUiSignature({ snapOn: true }), S.sessionUiSignature({ snapOn: false }));
});
t("hidden objects round-trip by position and are dropped if the drawing changed", () => {
  const ents = [{}, {}, {}, {}]; const h = new Set([ents[1], ents[3]]);
  const saved = JSON.parse(JSON.stringify(S.hiddenEntityIndexes(ents, h)));
  assert.deepStrictEqual(saved, { n: 4, idx: [1, 3] });
  assert.deepStrictEqual(S.sanitizeHiddenEntities(saved, 4), [1, 3]);
  assert.deepStrictEqual(S.sanitizeHiddenEntities(saved, 5), []);
  assert.strictEqual(S.hiddenEntityIndexes(ents, new Set()), undefined);
});
t("hidden-object junk is ignored", () => {
  assert.deepStrictEqual(S.sanitizeHiddenEntities({ n: 3, idx: [0, 0, -1, 9, 1.5, "2", 2] }, 3), [0, 2]);
  for (const v of [null, 5, "x", { n: 3 }, { n: 3, idx: "no" }]) assert.deepStrictEqual(S.sanitizeHiddenEntities(v, 3), []);
});
console.log(`session-state: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
