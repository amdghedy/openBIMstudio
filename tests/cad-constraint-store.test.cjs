/* Phase 4c: constraints persist inside the DXF (XRECORDs), verified by fingerprint on read. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cst-"));
try { fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* zod runtime dep */ }
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
execSync(`npx tsc src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-writer.ts src/modules/cad-viewer/constraint-store.ts src/modules/cad-viewer/constraint-bridge.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop${flag}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const { parseDxf } = require(find(out, "dxf-reader.js"));
const { writeDxf } = require(find(out, "dxf-writer.js"));
const S = require(find(out, "constraint-store.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };

const line = (x1, y1, x2, y2) => ({ type: "LINE", layer: "0", start: { x: x1, y: y1, z: 0 }, end: { x: x2, y: y2, z: 0 } });
const circ = (x, y, r) => ({ type: "CIRCLE", layer: "0", center: { x, y, z: 0 }, radius: r });
const mk = (entities, constraints) => ({ layers: [{ name: "0", color: 7 }], entities, units: "mm", sourceFormat: "cad-engine", ...(constraints ? { constraints } : {}) });
const ids = new Map();
const uid = (e) => ids.get(e);

t("export names objects by position + fingerprint and drops relations on erased objects", () => {
  const a = line(0, 0, 10, 1), b = line(0, 5, 8, 5), gone = circ(1, 1, 2);
  ids.set(a, "u1"); ids.set(b, "u2"); ids.set(gone, "u3");
  const r = S.exportConstraints([{ kind: "horizontal", ids: ["u1"] }, { kind: "parallel", ids: ["u1", "u2"] }, { kind: "radius", ids: ["u3"], value: 2 }, { kind: "length", ids: ["u9"], value: 3 }], [a, b], uid);
  assert.equal(r.stored.length, 2);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.stored[1].refs, [0, 1]);
  assert.equal(r.stored[1].fp.length, 2);
});
t("DXF round trip preserves constraints (kind, refs, fingerprints, value)", () => {
  const ents = [line(0, 0, 10, 0), line(0, 5, 10, 5), circ(20, 20, 3)];
  ents.forEach((e, i) => ids.set(e, "w" + i));
  const { stored } = S.exportConstraints([{ kind: "parallel", ids: ["w0", "w1"] }, { kind: "radius", ids: ["w2"], value: 3 }, { kind: "length", ids: ["w0"], value: 10 }], ents, uid);
  const text = writeDxf(mk(ents, stored));
  assert.ok(text.includes("XRECORD") && text.includes("OBS_CONSTRAINT"));
  const back = parseDxf(text);
  assert.deepEqual(back.constraints, stored);
  const v = S.verifyConstraints(back.constraints, back.entities);
  assert.equal(v.dropped, 0);
  assert.deepEqual(v.ok.map((c) => c.kind), ["parallel", "radius", "length"]);
  assert.equal(v.ok[2].value, 10);
});
t("a drawing without constraints writes no constraint objects", () => {
  const text = writeDxf(mk([line(0, 0, 1, 1)]));
  assert.ok(!text.includes("OBS_CONSTRAINT") && !text.includes("OPENBIMSTUDIO_CONSTRAINTS"));
  assert.equal(parseDxf(text).constraints, undefined);
});
t("verify drops a relation whose object moved or changed type — never attaches it to the wrong object", () => {
  const ents = [line(0, 0, 10, 0), line(0, 5, 10, 5)];
  ents.forEach((e, i) => ids.set(e, "m" + i));
  const { stored } = S.exportConstraints([{ kind: "parallel", ids: ["m0", "m1"] }, { kind: "horizontal", ids: ["m0"] }], ents, uid);
  assert.equal(S.verifyConstraints(stored, [ents[1], ents[0]]).ok.length, 0, "swapped order");
  assert.equal(S.verifyConstraints(stored, [line(0, 0, 10, 0.5), ents[1]]).ok.length, 0, "edited first line invalidates both relations on it");
  assert.equal(S.verifyConstraints(stored, [circ(0, 0, 1), ents[1]]).dropped, 2);
  assert.equal(S.verifyConstraints(stored, [ents[0]]).dropped, 1, "out-of-range ref drops only the relation that names it");
});
t("hostile stored records are rejected, not trusted", () => {
  const ents = [line(0, 0, 1, 1)];
  const fp = S.fingerprint(ents[0]);
  for (const bad of [
    { kind: "bogus", refs: [0], fp: [fp] },
    { kind: "horizontal", refs: [0, 0], fp: [fp, fp] },
    { kind: "parallel", refs: [0, 0], fp: [fp, fp] },
    { kind: "horizontal", refs: [-1], fp: [fp] },
    { kind: "horizontal", refs: [0.5], fp: [fp] },
    { kind: "horizontal", refs: [0], fp: [] },
  ]) assert.equal(S.verifyConstraints([bad], ents).ok.length, 0, JSON.stringify(bad));
});
t("reader ignores malformed constraint XRECORDs", () => {
  const ents = [line(0, 0, 10, 0)];
  const text = writeDxf(mk(ents, [{ kind: "horizontal", refs: [0], fp: [S.fingerprint(ents[0])] }]));
  const mangled = text.replace("OBS_CONSTRAINT", "SOMETHING_ELSE");
  assert.equal(parseDxf(mangled).constraints, undefined);
  assert.equal(parseDxf(text.replace(/\n90\n0\n/, "\n90\nabc\n")).constraints, undefined);
});
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
