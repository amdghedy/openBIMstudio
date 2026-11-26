// AutoCAD 2D parity A9 — dynamic-block parameters, authored in the editor
// (node test).
//
// Proved fail-without-fix against the base: `cad-dynblock-a9.ts` is new
// here, so the tsc compile below fails there (TS6053) and the suite never
// runs. The visibility test also fails on the old semantics: the existing
// DynBlockStore states are layer/tag filters only — they never hide block
// geometry per state.
//
// No mocks: the real evaluation, grip maths and store are the shipped ones.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-dynblock-a9-"));
try { fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* zod is a runtime dep of compiled safeLoad (PE-20) */ }
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
execSync(
  "npx tsc src/modules/cad-viewer/cad-dynblock-a9.ts src/modules/cad-viewer/modify-math.ts " +
    "--outDir " + out + " --module commonjs --target es2020 --skipLibCheck --esModuleInterop",
  { cwd: root, stdio: "pipe" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const D = require(find(out, "cad-dynblock-a9.js"));

const line = (x1, y1, x2, y2) => ({ type: "LINE", layer: "0", start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
const ents = [line(0, 0, 10, 0), line(0, 0, 0, 10), line(20, 20, 30, 20)];

(async () => {
  await t("linear: moves the selection by (value - baseValue) along the angle; baseValue is identity", async () => {
    const p = { kind: "linear", id: "W", name: "Width", selection: [0], basePoint: { x: 0, y: 0 }, angle: 0, value: 50, baseValue: 0 };
    const out = D.evaluateDynBlock(ents, [p], { W: 50 });
    assert.deepStrictEqual(out[0].start, { x: 50, y: 0 });
    assert.deepStrictEqual(out[0].end, { x: 60, y: 0 });
    assert.deepStrictEqual(out[1].start, { x: 0, y: 0 }, "unselected entity moved");
    const ident = D.evaluateDynBlock(ents, [p], { W: 0 });
    assert.deepStrictEqual(ident[0], ents[0]);
    const diag = D.evaluateDynBlock(ents, [{ ...p, angle: 90, value: 10, baseValue: 0 }], { W: 10 });
    assert.ok(Math.abs(diag[0].start.x) < 1e-9 && Math.abs(diag[0].start.y - 10) < 1e-9, JSON.stringify(diag[0].start));
  });

  await t("linear: an empty selection means the whole block", async () => {
    const p = { kind: "linear", id: "W", name: "Width", selection: [], basePoint: { x: 0, y: 0 }, angle: 0, value: 5, baseValue: 0 };
    const out = D.evaluateDynBlock(ents, [p], { W: 5 });
    assert.deepStrictEqual(out.map((e) => e.start.x), [5, 5, 25]);
  });

  await t("rotation: rotates the selection about the base point by (value - baseValue)", async () => {
    const p = { kind: "rotation", id: "R", name: "Angle", selection: [0], basePoint: { x: 0, y: 0 }, value: 90, baseValue: 0 };
    const out = D.evaluateDynBlock(ents, [p], { R: 90 });
    assert.ok(Math.abs(out[0].end.x - 0) < 1e-9 && Math.abs(out[0].end.y - 10) < 1e-9, JSON.stringify(out[0].end));
    assert.deepStrictEqual(out[1], ents[1], "unselected entity rotated");
  });

  await t("flip: mirrors the selection about the axis through the base point; false is identity", async () => {
    const p = { kind: "flip", id: "F", name: "Flip", selection: [0], basePoint: { x: 5, y: 0 }, axis: "x", value: true };
    const out = D.evaluateDynBlock(ents, [p], { F: true });
    assert.deepStrictEqual(out[0].start, { x: 10, y: 0 }, "x=0 mirrors to x=10 about x=5");
    assert.deepStrictEqual(out[0].end, { x: 0, y: 0 }, "x=10 mirrors to x=0 about x=5");
    const off = D.evaluateDynBlock(ents, [p], { F: false });
    assert.deepStrictEqual(off[0], ents[0]);
    const yFlip = D.evaluateDynBlock(ents, [{ ...p, axis: "y", basePoint: { x: 0, y: 5 } }], { F: true });
    assert.ok(Math.abs(yFlip[0].start.x) < 1e-9 && Math.abs(yFlip[0].start.y - 10) < 1e-9, JSON.stringify(yFlip[0].start));
    assert.ok(Math.abs(yFlip[0].end.x - 10) < 1e-9 && Math.abs(yFlip[0].end.y - 10) < 1e-9, JSON.stringify(yFlip[0].end));
    assert.deepStrictEqual(yFlip[1], ents[1], "unselected entity must not flip");
  });

  await t("visibility: the current state hides its entities by index — real geometry show/hide", async () => {
    const p = {
      kind: "visibility", id: "V", name: "View", selection: [],
      states: [
        { name: "Front", hidden: [2] },
        { name: "Side", hidden: [0, 1] },
        { name: "All", hidden: [] },
      ],
      value: "Front",
    };
    assert.strictEqual(D.evaluateDynBlock(ents, [p], { V: "Front" }).length, 2, "Front must hide entity 2");
    const side = D.evaluateDynBlock(ents, [p], { V: "Side" });
    assert.strictEqual(side.length, 1, "Side must hide entities 0 and 1");
    assert.deepStrictEqual(side[0].start, { x: 20, y: 20 });
    assert.strictEqual(D.evaluateDynBlock(ents, [p], { V: "All" }).length, 3);
    const bad = D.evaluateDynBlock(ents, [{ ...p, states: [{ name: "X", hidden: [99, -1] }] }], { V: "X" });
    assert.strictEqual(bad.length, 3, "out-of-range hidden indices must be ignored");
  });

  await t("lookup: choosing a value sets the driven parameters (one level only)", async () => {
    const width = { kind: "linear", id: "W", name: "Width", selection: [0], basePoint: { x: 0, y: 0 }, angle: 0, value: 0, baseValue: 0 };
    const lookup = {
      kind: "lookup", id: "Size", name: "Size", selection: [],
      table: [
        { value: "Small", sets: { W: 100 } },
        { value: "Large", sets: { W: 200 } },
      ],
      value: "Small",
    };
    const out = D.evaluateDynBlock(ents, [width, lookup], { W: 0, Size: "Large" });
    assert.deepStrictEqual(out[0].start, { x: 200, y: 0 }, "lookup did not drive the linear parameter");
    const direct = D.resolveLookupValues([width, lookup], { W: 7, Size: "Small" });
    assert.strictEqual(direct.W, 100);
    const unknown = D.resolveLookupValues([width, lookup], { W: 7, Size: "Nope" });
    assert.strictEqual(unknown.W, 7, "an unknown lookup value must leave the driven parameter alone");
  });

  await t("grips: linear grip sits at base + axis*value, rotation grip on its arm, drags round-trip", async () => {
    const lin = { kind: "linear", id: "W", name: "Width", selection: [], basePoint: { x: 10, y: 20 }, angle: 0, value: 30, baseValue: 0 };
    assert.deepStrictEqual(D.paramGripPoint(lin, { W: 30 }), { x: 40, y: 20 });
    assert.strictEqual(D.paramValueFromPoint(lin, { x: 55, y: 99 }), 45, "linear drag projects onto the axis");
    const rot = { kind: "rotation", id: "R", name: "Angle", selection: [], basePoint: { x: 0, y: 0 }, value: 90, baseValue: 0 };
    const gp = D.paramGripPoint(rot, { R: 90 });
    assert.ok(Math.abs(gp.x) < 1e-9 && Math.abs(gp.y - D.ROTATION_GRIP_RADIUS) < 1e-9, JSON.stringify(gp));
    assert.ok(Math.abs((D.paramValueFromPoint(rot, { x: 0, y: 20 }) ?? 0) - 90) < 1e-9);
    const flip = { kind: "flip", id: "F", name: "Flip", selection: [], basePoint: { x: 5, y: 5 }, axis: "x", value: false };
    assert.deepStrictEqual(D.paramGripPoint(flip, { F: false }), { x: 5 + D.FLIP_GRIP_OFFSET, y: 5 });
    assert.strictEqual(D.paramValueFromPoint(flip, { x: 0, y: 0 }), null, "flip has no drag value");
    const vis = { kind: "visibility", id: "V", name: "View", selection: [], states: [{ name: "A", hidden: [] }], value: "A" };
    assert.strictEqual(D.paramGripPoint(vis, { V: "A" }), null, "visibility has no spatial grip");
  });

  await t("grip transform: block <-> world round-trips through an INSERT with rotation and scale", async () => {
    const ins = { type: "INSERT", layer: "0", name: "B", position: { x: 100, y: 50 }, scale: { x: 2, y: 2 }, rotation: 90 };
    const base = { x: 10, y: 20 };
    const world = D.dynGripWorldPoint(ins, base, { x: 40, y: 20 });
    assert.deepStrictEqual([Math.round(world.x), Math.round(world.y)], [100, 110]);
    const back = D.dynWorldToBlockPoint(ins, base, world);
    assert.ok(Math.abs(back.x - 40) < 1e-9 && Math.abs(back.y - 20) < 1e-9, JSON.stringify(back));
  });

  await t("effective values: instance overrides win; unknown ids are ignored", async () => {
    const set = { blockName: "B", params: [{ kind: "linear", id: "W", name: "Width", selection: [], basePoint: { x: 0, y: 0 }, angle: 0, value: 10, baseValue: 0 }], values: { W: 10 } };
    assert.deepStrictEqual(D.effectiveDynValues(set, { W: 42, Nope: 1 }), { W: 42 });
    assert.deepStrictEqual(D.effectiveDynValues(set, undefined), { W: 10 });
  });

  await t("store: serialize/deserialize round-trips; corrupt records are null, never thrown", async () => {
    const set = {
      blockName: "Chair",
      params: [{ kind: "linear", id: "W", name: "Width", selection: [0], basePoint: { x: 0, y: 0 }, angle: 0, value: 10, baseValue: 0 }],
      values: { W: 10 },
    };
    const back = D.DynParamStore.deserialize(D.DynParamStore.serialize(set));
    assert.deepStrictEqual(back, set);
    assert.strictEqual(D.DynParamStore.deserialize(null), null);
    assert.strictEqual(D.DynParamStore.deserialize("not json"), null);
    const dup = D.DynParamStore.deserialize(JSON.stringify({ blockName: "X", params: [{ kind: "linear", id: "W", selection: [], basePoint: { x: 0, y: 0 }, angle: 0, value: 1, baseValue: 0 }, { kind: "linear", id: "W", selection: [], basePoint: { x: 0, y: 0 }, angle: 0, value: 2, baseValue: 0 }], values: {} }));
    assert.ok(dup && dup.params.length === 1 && dup.params[0].value === 1, "the duplicate id must be dropped, the first kept");
    const store = new D.DynParamStore();
    store.set(set);
    assert.strictEqual(store.get("CHAIR")?.blockName, "Chair", "lookup is case-insensitive");
    assert.strictEqual(D.validateDynParam({ kind: "flip", id: "F", name: "Flip", selection: [], basePoint: { x: 0, y: 0 }, axis: "z", value: false }, []), "The flip axis must be X or Y.");
  });

  await t("evaluation never mutates its inputs", async () => {
    const before = JSON.stringify(ents);
    const p = { kind: "linear", id: "W", name: "Width", selection: [], basePoint: { x: 0, y: 0 }, angle: 0, value: 5, baseValue: 0 };
    D.evaluateDynBlock(ents, [p], { W: 5 });
    assert.strictEqual(JSON.stringify(ents), before);
  });

  await t("grip points follow the other parameters; the inverse undoes them (round-trip)", async () => {
    const flip = { kind: "flip", id: "F", name: "Mirror", selection: [], basePoint: { x: 0, y: 0 }, axis: "x", value: true };
    const lin = { kind: "linear", id: "W", name: "Width", selection: [], basePoint: { x: 0, y: 0 }, angle: 0, value: 100, baseValue: 100 };
    const rot = { kind: "rotation", id: "R", name: "Angle", selection: [], basePoint: { x: 0, y: 0 }, value: 90, baseValue: 0 };
    const values = { F: true, W: 150, R: 90 };
    // The linear grip at value 150 sits at block (150, 0); the active flip
    // mirrors it to (-150, 0) and the 90-degree rotation moves it to (0, -150).
    const grip = D.paramGripPoint(lin, values);
    assert.ok(grip && Math.abs(grip.x - 150) < 1e-9 && Math.abs(grip.y) < 1e-9);
    const shown = D.dynPointThroughParams([flip, lin, rot], values, grip, "W");
    assert.ok(Math.abs(shown.x - 0) < 1e-9 && Math.abs(shown.y - (-150)) < 1e-9, `flip+rotation grip: got (${shown.x}, ${shown.y})`);
    // The drag reads the value back: inverse-transform the cursor point, then project.
    const back = D.dynPointInverseThroughParams([flip, lin, rot], values, shown, "W");
    assert.ok(Math.abs(back.x - 150) < 1e-9 && Math.abs(back.y) < 1e-9, `inverse grip: got (${back.x}, ${back.y})`);
    assert.strictEqual(D.paramValueFromPoint(lin, back), 150);
    // exceptId: the parameter's own action never applies to its own grip.
    const own = D.dynPointThroughParams([lin], { W: 150 }, { x: 150, y: 0 }, "W");
    assert.ok(Math.abs(own.x - 150) < 1e-9 && Math.abs(own.y) < 1e-9);
    // Identity when nothing else is active.
    const id = D.dynPointThroughParams([flip, lin], { F: false, W: 100 }, { x: 100, y: 0 }, "W");
    assert.ok(Math.abs(id.x - 100) < 1e-9 && Math.abs(id.y) < 1e-9);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
