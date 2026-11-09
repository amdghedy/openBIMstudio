// DWG expansion pack — source drift-guard test.
//
// Guards the second wave of native-engine CAD tools (commit "cad engine
// expansion"): LENGTHEN / DIVIDE / MEASURE / DDEDIT / LAYISO / LAYOFF /
// LAYUNISO / LAYLCK / LAYUNLCK / MLEADER / QSELECT / PEDIT / CAL, plus the
// DWG grip-editing layer (blue hotspots on the selection).
//
// Marker-based on the real sources, plus logic checks of the CAL evaluator
// and the DIVIDE / LENGTHEN / grip math compiled straight from the modules.
const fs = require("fs"), path = require("path"), assert = require("assert");
const { execSync } = require("child_process");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "src", ...p), "utf8");
const viewer = read("features", "cad-viewer.ts");
const cal = read("modules", "cad-viewer", "cad-cal.ts");
const mm = read("modules", "cad-viewer", "modify-math.ts");
const vm = read("modules", "cad-viewer", "viewer-math.ts");

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

// Compile the three TS modules once (rootDir=src keeps the output tree importable).
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), ".cad-tools-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
execSync(
  `npx tsc "${path.join(__dirname, "..", "src", "modules", "cad-viewer", "cad-cal.ts")}" "${path.join(__dirname, "..", "src", "modules", "cad-viewer", "modify-math.ts")}" "${path.join(__dirname, "..", "src", "modules", "cad-viewer", "viewer-math.ts")}" --outDir "${TMP}" --rootDir "${path.join(__dirname, "..", "src")}" --target es2020 --module commonjs --skipLibCheck`,
  { cwd: path.join(__dirname, ".."), stdio: "pipe" },
);
function loadModule(rel) {
  return require(path.join(TMP, ...rel).replace(/\.ts$/, ".js"));
}

// ── 1. Command table: every expansion command with its DWG aliases ──
t("command table rows + aliases", () => {
  const rows = [
    ['{ name: "LENGTHEN", aliases: ["LEN"]', "LENGTHEN"],
    ['{ name: "DIVIDE", aliases: ["DIV"]', "DIVIDE"],
    ['{ name: "MEASURE", aliases: ["ME"]', "MEASURE"],
    ['{ name: "DDEDIT", aliases: ["ED", "TEXTEDIT"]', "DDEDIT"],
    ['{ name: "LAYISO"', "LAYISO"],
    ['{ name: "LAYUNISO"', "LAYUNISO"],
    ['{ name: "LAYOFF"', "LAYOFF"],
    ['{ name: "LAYLCK"', "LAYLCK"],
    ['{ name: "LAYUNLCK", aliases: ["LAYUNLOCK"]', "LAYUNLCK"],
    ['{ name: "MLEADER", aliases: ["MLD", "LE", "LEADER"]', "MLEADER"],
    ['{ name: "QSELECT", aliases: ["QSI"]', "QSELECT"],
    ['{ name: "PEDIT", aliases: ["PE"]', "PEDIT"],
    ['{ name: "CAL", aliases: ["QUICKCALC", "QC"]', "CAL"],
  ];
  for (const [marker] of rows) assert.ok(viewer.includes(marker), `cad-viewer.ts drift: missing command row "${marker}"`);
  assert.ok(viewer.includes('aliases: ["ML", "LAYMCH"]'), "MATCHLAYER should carry the LAYMCH alias");
});

// ── 2. Tools wired through the pick state machine ──
t("pick machinery covers the new tools", () => {
  for (const kind of ["lengthen", "divide", "measure", "ddedit", "layiso", "layoff", "laylck", "layunlck", "mleader"]) {
    assert.ok(viewer.includes(`t === "${kind}"`), `isPickTool drift: "${kind}" not accepted`);
  }
  for (const disp of ['setTool("lengthen")', 'setTool("divide")', 'setTool("measure")', 'setTool("ddedit")', '? "layiso"', '? "layoff"', '? "laylck"', ': "layunlck"', 'setTool("mleader")']) {
    assert.ok(viewer.includes(disp), `dispatch drift: missing ${disp}`);
  }
  for (const stage of ['pick.stage === "newend"', 'pick.stage === "landing"', 'pick.nearEnd', "pick.lenMode"]) {
    assert.ok(viewer.includes(stage), `PickOp drift: missing ${stage}`);
  }
});

// ── 3. pendingText: DDEDIT / MLEADER command-line text capture ──
t("pendingText capture wired", () => {
  assert.ok(viewer.includes("let pendingText"), "pendingText state missing");
  const consumption = viewer.match(/if \(pendingText\) \{[\s\S]{0,200}?f\(trimmed\)/);
  assert.ok(consumption, "executeDrawingCommand must consume pendingText before treating input as a command");
  assert.ok(viewer.includes('f("")'), "empty Enter must cancel pendingText (keep existing text)");
});

// ── 4. CAL: expression evaluator + on-the-fly numeric entry ──
t("CAL evaluator module + fast path", () => {
  assert.ok(viewer.includes('from "../modules/cad-viewer/cad-cal"'), "cad-cal import missing");
  assert.ok(viewer.includes('cmd === "CAL" || cmd === "QUICKCALC" || cmd === "QC"'), "CAL dispatch missing");
  assert.ok(viewer.includes("isCalcExpr(trimmed)"), "bare-expression fast path missing");
  assert.ok(viewer.includes("if (tool === \"lengthen\" && pick)"), "applyDirectDistance must feed LENGTHEN presets");
});

// ── 5. Grip editing: hotspots, drag, undo commit ──
t("grip editing layer", () => {
  assert.ok(vm.includes("export function entityGrips"), "entityGrips missing from viewer-math");
  assert.ok(vm.includes("export function applyGripDrag"), "applyGripDrag missing from viewer-math");
  assert.ok(viewer.includes("M.entityGrips(e)"), "viewer must consult entityGrips");
  assert.ok(viewer.includes("M.applyGripDrag(e, gripDrag.gi, to)"), "viewer must apply grip drags");
  assert.ok(viewer.includes("let gripDrag: GripDrag"), "grip drag state missing");
  assert.ok(viewer.includes('type: "modify", before: [gripDrag.orig], after: [after]'), "grip release must push a modify undo action");
  assert.ok(viewer.includes("ents[gripDrag.i] = gripDrag.orig;"), "Esc must revert an in-flight grip drag");
  assert.ok(viewer.includes('drawGrip(g.x, g.y, hot ? "#22c55e" : "#3b82f6")'), "grip painting (blue / hover green) missing");
  assert.ok(viewer.includes("!mod && !pick && !gripDrag"), "grips must hide during modify / pick ops");
});

// ── 6. Ribbon: buttons reachable from the DWG ribbon ──
t("ribbon buttons for the new tools", () => {
  for (const btn of ['tb("lengthen", "stretch", "Lengthen")', 'tb("mleader", "tag-all", "MLeader")', 'tb("divide", "point", "Divide")', 'tb("measure", "measure", "Measure")', 'data-a="ddedit"', 'data-a="layiso"', 'data-a="layuniso"', 'data-a="layoff"']) {
    assert.ok(viewer.includes(btn), `ribbon drift: missing "${btn}"`);
  }
  for (const actName of ["layiso: () => executeDrawingCommand", "layuniso: () => executeDrawingCommand", "ddedit: () => executeDrawingCommand"]) {
    assert.ok(viewer.includes(actName), `act map drift: missing "${actName}"`);
  }
  for (const tip of ['["lengthen", "Lengthen", "LEN"]', '["divide", "Divide", "DIV"]', '["measure", "Measure", "ME"]', '["mleader", "MLeader", "MLD"]']) {
    assert.ok(viewer.includes(tip), `tooltip table drift: missing ${tip}`);
  }
});

// ── 7. Logic: CAL evaluator (degrees trig, functions, no injection surface) ──
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

t("CAL evaluator logic", () => {
  const C = loadModule(["modules", "cad-viewer", "cad-cal.ts"]);
  assert.ok(approx(C.evalExpr("2*PI*25"), 50 * Math.PI));
  assert.ok(approx(C.evalExpr("sin(30)^2+cos(30)^2"), 1));
  assert.ok(approx(C.evalExpr("(3+4)*abs(-2)"), 14));
  assert.ok(approx(C.evalExpr("sqrt(2)*round(3.6)"), Math.SQRT2 * 4));
  assert.ok(approx(C.evalExpr("min(10,max(4,7))"), 7));
  assert.ok(approx(C.evalExpr("-3^2"), -9)); // unary binds tighter than ^ like classic CAL
  assert.strictEqual(C.evalExpr("process.exit(1)"), null);
  assert.strictEqual(C.evalExpr("constructor"), null);
  assert.strictEqual(C.evalExpr("this"), null);
  assert.strictEqual(C.evalExpr("alert(1)"), null);
  assert.strictEqual(C.evalExpr("1+2)"), null);
  assert.strictEqual(C.evalExpr(""), null);
  assert.ok(C.isCalcExpr("2*PI*25"));
  assert.ok(!C.isCalcExpr("WALL 3")); // never swallow drawing words with spaces
  assert.ok(!C.isCalcExpr("LINE"));
});

// ── 8. Logic: DIVIDE / MEASURE / LENGTHEN math ──
t("DIVIDE / MEASURE / LENGTHEN math", () => {
  const X2 = loadModule(["modules", "cad-viewer", "modify-math.ts"]);
  const line = { type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 100, y: 0 } };
  const div = X2.divPoints(line, 5);
  assert.strictEqual(div.length, 4);
  assert.ok(approx(div[0].x, 20) && approx(div[3].x, 80));
  const meas = X2.measPoints(line, 30);
  assert.strictEqual(meas.length, 3);
  assert.ok(approx(meas[2].x, 90));
  assert.strictEqual(X2.divPoints(line, 1).length, 0);
  const stretched = X2.lengthenTotal(line, "end", 150);
  assert.ok(approx(X2.entitySpanLength(stretched), 150));
  assert.ok(approx(stretched.start.x, 0) && approx(stretched.end.x, 150));
  const shortened = X2.lengthenTotal(line, "start", 40);
  assert.ok(approx(shortened.start.x, 60) && approx(shortened.end.x, 100));
  const dyn = X2.lengthenTo(line, "end", { x: 220, y: 55 }); // off-axis cursor projects onto the line
  assert.ok(approx(dyn.end.y, 0) && approx(dyn.end.x, 220));
  // POLYLINE span math
  const poly = { type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }] };
  assert.ok(approx(X2.entitySpanLength(poly), 100));
  const pd = X2.divPoints(poly, 4);
  assert.ok(approx(pd[1].x, 50) && approx(pd[1].y, 0)); // exactly at the corner
  assert.ok(approx(pd[2].x, 50) && approx(pd[2].y, 25)); // half-way up the vertical leg
});

// ── 9. Logic: grip math ──
t("grip math", () => {
  const V = loadModule(["modules", "cad-viewer", "viewer-math.ts"]);
  const line = { type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 100, y: 0 } };
  const grips = V.entityGrips(line);
  assert.strictEqual(grips.length, 3); // start, midpoint(move), end
  const movedEnd = V.applyGripDrag(line, 2, { x: 100, y: 40 });
  assert.ok(approx(movedEnd.end.x, 100) && approx(movedEnd.end.y, 40));
  assert.ok(approx(movedEnd.start.x, 0)); // other end untouched
  const movedAll = V.applyGripDrag(line, 1, { x: 150, y: 0 }); // midpoint grip translates the line by +100
  assert.ok(approx(movedAll.start.x, 100) && approx(movedAll.end.x, 200));
  const circ = { type: "CIRCLE", layer: "0", center: { x: 0, y: 0 }, radius: 10 };
  assert.strictEqual(V.entityGrips(circ).length, 5); // center + 4 quadrants
  const big = V.applyGripDrag(circ, 1, { x: 0, y: 25 });
  assert.ok(approx(big.radius, 25));
  const poly = { type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
  const pg = V.entityGrips(poly);
  const vp = V.applyGripDrag(poly, 1, { x: 10, y: 10 });
  assert.ok(approx(vp.points[1].x, 10) && approx(vp.points[1].y, 10));
  void pg;
});

console.log(`\ncad-tools-expansion: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
