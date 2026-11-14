// Drafting completions milestone — radial/diameter/angular/arclen/center
// dimensions, ellipse rotation, native RAY/XLINE cutting edges, FILTER and
// DIMCONTINUE/DIMBASELINE chaining. Pure modules compiled headlessly.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-completions-"));
try {
  execSync(
    "npx tsc src/modules/cad-viewer/dimension-system.ts src/modules/cad-viewer/dimension-tools.ts src/modules/cad-viewer/modify-math.ts src/modules/drawings/dxf-types.ts --outDir " +
      out + " --module commonjs --target es2020 --skipLibCheck",
    { cwd: root, stdio: "inherit" },
  );
  const locate = (dir, name) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = locate(p, name); if (found) return found; }
      else if (entry.name === name) return p;
    }
    return null;
  };
  const sys = require(locate(out, "dimension-system.js"));
  const tools = require(locate(out, "dimension-tools.js"));
  const X = require(locate(out, "modify-math.js"));
  assert.ok(sys && tools && X, "compiled drafting modules should exist");

  const style = { name: "ISO-25", textHeight: 2.5, arrowSize: 2.5, precision: 2, suffix: "", linearScale: 1 };
  const D = 180 / Math.PI;

  // ── dimPrefix / formatAngleMeasurement ──
  assert.strictEqual(sys.dimPrefix("radial"), "R");
  assert.strictEqual(sys.dimPrefix("diameter"), "\u2300");
  assert.strictEqual(sys.dimPrefix("linear"), "");
  assert.strictEqual(sys.dimPrefix("angular"), "");
  assert.strictEqual(sys.formatAngleMeasurement(90, style), "90.00\u00B0");
  assert.strictEqual(sys.formatAngleMeasurement(90.004, { ...style, precision: 0 }), "90\u00B0");
  assert.strictEqual(sys.formatAngleMeasurement(-90, style), "270.00\u00B0", "angular measurement normalises to 0-360");

  // ── measureRecord per mode ──
  assert.strictEqual(sys.measureRecord({ mode: "radial", p1: { x: 0, y: 0 }, p2: { x: 3, y: 4 }, placement: { x: 3, y: 4 } }), 5, "radial = |edge - centre|");
  assert.strictEqual(sys.measureRecord({ mode: "diameter", p1: { x: 0, y: 0 }, p2: { x: 3, y: 4 }, placement: { x: 3, y: 4 } }), 10, "diameter = 2|edge - centre|");
  assert.strictEqual(
    sys.measureRecord({ mode: "angular", p1: { x: 0, y: 0 }, p2: { x: 5, y: 0 }, placement: { x: 0, y: 5 } }),
    90, "angular = CCW sweep ray1→ray2",
  );
  assert.strictEqual(
    sys.measureRecord({ mode: "angular", p1: { x: 0, y: 0 }, p2: { x: 0, y: 5 }, placement: { x: 5, y: 0 } }),
    270, "angular sweep wraps CCW past 180",
  );
  const arcR = 10, arcSweep = Math.PI / 2;
  assert.strictEqual(
    sys.measureRecord({ mode: "arclen", p1: { x: 0, y: 0 }, p2: { x: arcR, y: 0 }, placement: { x: 0, y: arcR } }),
    arcR * arcSweep, "arclen = radius × CCW sweep",
  );
  assert.strictEqual(sys.measureRecord({ mode: "center", p1: { x: 1, y: 2 }, p2: { x: 1, y: 2 }, placement: { x: 1, y: 2 } }), 0, "center mark measures nothing");

  // ── buildRadialDimension ──
  const rad = tools.buildRadialDimension({ center: { x: 0, y: 0 }, edge: { x: 10, y: 0 }, layer: "0", text: "R10.00", textHeight: 2.5, dimId: "d1" });
  assert.strictEqual(rad.length, 4, "radial dim = dimline + 2 ticks + text");
  assert.ok(rad.every((e) => e.meta?.dimId === "d1"), "every radial entity carries the dimId");
  const radLine = rad.find((e) => e.type === "LINE" && e.meta?.role === "dimline");
  assert.ok(radLine, "radial dimline exists");
  assert.strictEqual(radLine.start.x, 0); assert.strictEqual(radLine.end.x, 10, "radial dimline runs centre → edge");
  const radText = rad.find((e) => e.type === "TEXT");
  assert.ok(radText && radText.value === "R10.00", "radial text carries the label");
  assert.ok(tools.buildRadialDimension({ center: { x: 0, y: 0 }, edge: { x: 0, y: 0 }, layer: "0", text: "R0", textHeight: 2.5 }).length === 0, "degenerate radial returns nothing");

  // ── buildDiameterDimension ──
  const dia = tools.buildDiameterDimension({ center: { x: 0, y: 0 }, edge: { x: 10, y: 0 }, layer: "0", text: "\u230020.00", textHeight: 2.5, dimId: "d2" });
  const diaLine = dia.find((e) => e.type === "LINE" && e.meta?.role === "dimline");
  assert.ok(dia.length === 6, "diameter dim = dimline + 2+2 ticks + text");
  assert.ok(diaLine.end.x === -10 && diaLine.start.x === 10, "diameter dimline spans both opposite edges through the centre");
  const diaMid = { x: (diaLine.start.x + diaLine.end.x) / 2, y: (diaLine.start.y + diaLine.end.y) / 2 };
  assert.strictEqual(diaMid.x, 0, "diameter line midpoint is the centre");

  // ── buildAngularDimension ──
  const ang = tools.buildAngularDimension({ vertex: { x: 0, y: 0 }, a: { x: 10, y: 0 }, b: { x: 0, y: 10 }, layer: "0", text: "90.00\u00B0", textHeight: 2.5, dimId: "d3", segments: 12 });
  const angLines = ang.filter((e) => e.type === "LINE" && e.meta?.role === "dimline");
  assert.strictEqual(angLines.length, 12, "angular arc drawn as the requested chord count");
  for (const seg of angLines) {
    const r1 = Math.hypot(seg.start.x, seg.start.y), r2 = Math.hypot(seg.end.x, seg.end.y);
    assert.ok(Math.abs(r1 - 10) < 1e-6 && Math.abs(r2 - 10) < 1e-6, "every angular chord lies on the sweep radius (min ray length)");
  }
  const firstAng = Math.atan2(angLines[0].start.y, angLines[0].start.x);
  const lastAng = Math.atan2(angLines[11].end.y, angLines[11].end.x);
  assert.ok(Math.abs(firstAng - 0) < 1e-9, "angular arc starts on ray a (0°)");
  assert.ok(Math.abs(lastAng - Math.PI / 2) < 1e-9, "angular arc ends on ray b (90° CCW)");
  const angText = ang.find((e) => e.type === "TEXT");
  assert.ok(angText && Math.hypot(angText.position.x, angText.position.y) > 10, "angular text sits outside the arc");
  assert.ok(tools.buildAngularDimension({ vertex: { x: 0, y: 0 }, a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, layer: "0", text: "0", textHeight: 2.5 }).length === 0, "degenerate angular (zero-length ray) returns nothing");

  // ── buildArcLengthDimension ──
  const alen = tools.buildArcLengthDimension({ center: { x: 0, y: 0 }, start: { x: 10, y: 0 }, end: { x: 0, y: 10 }, layer: "0", text: "15.71", textHeight: 2.5, dimId: "d4", segments: 8 });
  const alenLines = alen.filter((e) => e.type === "LINE" && e.meta?.role === "dimline");
  assert.strictEqual(alenLines.length, 8, "arc-length dim uses the requested chord count");
  for (const seg of alenLines) {
    assert.ok(Math.abs(Math.hypot(seg.start.x, seg.start.y) - 10) < 1e-6, "arc-length chords lie on the arc radius");
  }

  // ── buildCenterMark ──
  const cm = tools.buildCenterMark({ center: { x: 5, y: 7 }, layer: "0", size: 2.5, dimId: "d5" });
  assert.strictEqual(cm.length, 2, "centre mark = two crosshair strokes");
  assert.ok(cm.every((e) => e.meta?.dimId === "d5" && e.meta?.role === "dimline"));
  assert.strictEqual(cm[0].start.x, 2.5); assert.strictEqual(cm[0].end.x, 7.5, "horizontal stroke spans ±size");
  assert.strictEqual(cm[1].start.y, 4.5); assert.strictEqual(cm[1].end.y, 9.5, "vertical stroke spans ±size");

  // ── buildDimEntities dispatch (style + colour ride through every mode) ──
  const recRad = { id: "r1", styleName: "ISO-25", mode: "radial", layer: "0", p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, placement: { x: 10, y: 0 } };
  const builtRad = sys.buildDimEntities(recRad, { ...style, colorAci: 3 }, "R10.00");
  assert.ok(builtRad.length === 4 && builtRad.every((e) => e.color === 3), "radial dispatch applies the style colour");
  const recCtr = { id: "c1", styleName: "ISO-25", mode: "center", layer: "0", p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, placement: { x: 0, y: 0 } };
  assert.strictEqual(sys.buildDimEntities(recCtr, style, "").length, 2, "center dispatch emits the crosshair");
  const recAng = { id: "a1", styleName: "ISO-25", mode: "angular", layer: "0", p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, placement: { x: 0, y: 10 } };
  assert.ok(sys.buildDimEntities(recAng, style, "90.00\u00B0").some((e) => e.type === "TEXT"), "angular dispatch emits the measurement text");
  const recLin = { id: "l1", styleName: "ISO-25", mode: "aligned", layer: "0", p1: { x: 0, y: 0 }, p2: { x: 30, y: 0 }, placement: { x: 15, y: 8 } };
  const builtLin = sys.buildDimEntities(recLin, style, "30.00");
  assert.ok(builtLin.some((e) => e.meta?.role === "ext"), "linear dispatch unchanged — extension lines still emitted");

  // ── Associativity: radial dims ride rigidly with a translated circle ──
  const circleBefore = { type: "CIRCLE", layer: "0", center: { x: 0, y: 0 }, radius: 10 };
  const circleAfter = { type: "CIRCLE", layer: "0", center: { x: 4, y: 3 }, radius: 10 };
  const changedRad = sys.trackDimensionDefpoints([recRad], [circleBefore], [circleAfter], 1e-6);
  assert.strictEqual(changedRad.length, 1, "radial dim follows the moved circle");
  assert.deepStrictEqual(changedRad[0].p1, { x: 4, y: 3 }, "radial centre defpoint follows the circle centre");
  assert.deepStrictEqual(changedRad[0].p2, { x: 14, y: 3 }, "radial edge defpoint rides rigidly with the centre");
  assert.deepStrictEqual(changedRad[0].placement, { x: 14, y: 3 }, "radial placement rides rigidly");
  assert.strictEqual(sys.measureRecord(changedRad[0]), 10, "radius measurement unchanged after rigid translation");

  // Linear records keep their existing semantics (unaffected by the new modes).
  const lineBefore = { type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 30, y: 0 } };
  const lineAfter = { type: "LINE", layer: "0", start: { x: 0, y: 5 }, end: { x: 30, y: 5 } };
  const changedLin = sys.trackDimensionDefpoints([recLin], [lineBefore], [lineAfter], 1e-6);
  assert.strictEqual(changedLin.length, 1);
  assert.deepStrictEqual(changedLin[0].placement, { x: 15, y: 13 }, "linear placement still rides when both endpoints move");

  // Angular records track all three defpoints — but each one only rides when
  // it coincides with a moved entity endpoint (the defpoint model).
  const angBefore = { type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } };
  const angAfter = { type: "LINE", layer: "0", start: { x: 2, y: 2 }, end: { x: 12, y: 2 } };
  const changedAng = sys.trackDimensionDefpoints([recAng], [angBefore], [angAfter], 1e-6);
  assert.strictEqual(changedAng.length, 1, "angular dim follows its moved geometry");
  assert.deepStrictEqual(changedAng[0].p1, { x: 2, y: 2 }, "angular vertex follows the moved start");
  assert.deepStrictEqual(changedAng[0].p2, { x: 12, y: 2 }, "angular first-ray defpoint follows the moved end");
  assert.deepStrictEqual(changedAng[0].placement, { x: 0, y: 10 }, "second-ray defpoint stays when it matches no moved endpoint");
  const recAng2 = { ...recAng, id: "a2", placement: { x: 10, y: 0 } };
  const changedAng2 = sys.trackDimensionDefpoints([recAng2], [angBefore], [angAfter], 1e-6);
  assert.deepStrictEqual(changedAng2[0].placement, { x: 12, y: 2 }, "second-ray defpoint rides when it coincides with a moved endpoint");

  // ── DIMCONTINUE chaining ──
  const cont = sys.continuedDimRecord(recLin, "d-c1", { x: 60, y: 0 }, "ISO-25", "0");
  assert.deepStrictEqual(cont.p1, { x: 30, y: 0 }, "continued dim starts at the previous second endpoint");
  assert.deepStrictEqual(cont.p2, { x: 60, y: 0 });
  assert.deepStrictEqual(cont.placement, { x: 45, y: 8 }, "continued dim keeps the same dim-line offset along the chain");
  assert.strictEqual(cont.mode, "aligned", "continued dim inherits the mode");
  const contBuilt = sys.buildDimEntities(cont, style, "30.00");
  assert.ok(contBuilt.length > 0, "continued record builds entities");

  // ── DIMBASELINE chaining ──
  const base1 = sys.baselineDimRecord(recLin, recLin, "d-b1", { x: 20, y: 0 }, "ISO-25", "0", 5.5);
  assert.deepStrictEqual(base1.p1, { x: 0, y: 0 }, "baseline measures from the root origin");
  assert.deepStrictEqual(base1.p2, { x: 20, y: 0 });
  assert.deepStrictEqual(base1.placement, { x: 15, y: 13.5 }, "first baseline staggers outward on the placement side");
  const base2 = sys.baselineDimRecord(recLin, base1, "d-b2", { x: 50, y: 0 }, "ISO-25", "0", 5.5);
  assert.deepStrictEqual(base2.placement, { x: 15, y: 19 }, "successive baselines keep stacking outward");
  assert.strictEqual(sys.measureRecord(base1), 20, "baseline measures origin → new point");

  // ── ellipseLoop rotation ──
  const flat = X.ellipseLoop(0, 0, 10, 5, 48);
  assert.ok(Math.abs(flat[0].x - 10) < 1e-9 && Math.abs(flat[0].y) < 1e-9, "default rotation unchanged (axis-aligned)");
  const rotated = X.ellipseLoop(0, 0, 10, 5, 48, 90);
  assert.ok(Math.abs(rotated[0].x) < 1e-9 && Math.abs(rotated[0].y - 10) < 1e-9, "rotation 90° maps the major axis onto +Y");
  const rotated45 = X.ellipseLoop(0, 0, 10, 10, 48, 45);
  assert.ok(Math.abs(rotated45[0].x - 10 * Math.SQRT1_2) < 1e-9, "circular loop rotates parametrically");
  // The rotated loop must still be a true ellipse of the same semi-axes.
  for (const p of X.ellipseLoop(0, 0, 10, 5, 200, 30)) {
    const rot = (-30 * Math.PI) / 180;
    const ex = p.x * Math.cos(rot) - p.y * Math.sin(rot);
    const ey = p.x * Math.sin(rot) + p.y * Math.cos(rot);
    const v = (ex / 10) ** 2 + (ey / 5) ** 2;
    assert.ok(Math.abs(v - 1) < 1e-6, "rotated ellipse keeps its semi-axes");
  }

  // ── Native RAY/XLINE participate in intersection/trim math ──
  const ray = { type: "RAY", layer: "0", start: { x: 5, y: -10 }, direction: { x: 0, y: 1 } };
  const segs = X.entitySegments(ray);
  assert.strictEqual(segs.length, 1, "RAY yields one representative segment");
  assert.ok(Math.hypot(segs[0][1].x - segs[0][0].x, segs[0][1].y - segs[0][0].y) > 1e4, "representative ray segment is effectively infinite");
  const line = { type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } };
  const xs = X.entIntersections(line, ray);
  assert.strictEqual(xs.length, 1, "ray × line intersection found");
  assert.ok(Math.abs(xs[0].x - 5) < 1e-6 && Math.abs(xs[0].y) < 1e-6, "intersection at (5,0)");
  const xline = { type: "XLINE", layer: "0", start: { x: 5, y: 0 }, direction: { x: 0, y: 1 } };
  assert.strictEqual(X.entIntersections(line, xline).length, 1, "xline × line intersection found");
  // A native ray works as a TRIM cutting edge.
  const trimmed = X.trimEntity(line, { x: 8, y: 0 }, [ray]);
  assert.ok(Array.isArray(trimmed) && trimmed.length === 1, "ray trims the line to one piece");
  assert.ok(Math.abs(trimmed[0].end.x - 5) < 1e-6, "trimmed piece ends at the ray");

  // ── Source-level wiring: FILTER command + committed dimension flows ──
  const viewerSrc = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  assert.ok(/name: "FILTER"/.test(viewerSrc), "FILTER command is registered in CAD_COMMANDS");
  assert.ok(/cmd === "FILTER"/.test(viewerSrc), "FILTER has a dispatcher branch");
  assert.ok(/function openTypeFilterDialog/.test(viewerSrc), "FILTER dialog exists");
  assert.ok(!/kind: "dimrad"/.test(viewerSrc.split("case \"radius\"")[1]?.split("case ")[0] ?? ""), "DIMRADIUS no longer creates a transient markup");
  assert.ok(/mode: "radial" \}\)/.test(viewerSrc), "DIMRADIUS commits an associative radial record");
  assert.ok(/mode: "diameter" \}\)/.test(viewerSrc), "DIMDIAMETER commits an associative diameter record");
  assert.ok(/mode: "angular" \}\)/.test(viewerSrc), "DIMANGULAR commits an associative angular record");
  assert.ok(/mode: "arclen" \}/.test(viewerSrc), "DIMARC commits an associative arc-length record");
  assert.ok(/mode: "center" \}/.test(viewerSrc), "DIMCENTER commits a centre-mark record");
  assert.ok(/DIM\.continuedDimRecord\(/.test(viewerSrc), "DIMCONTINUE chains real records");
  assert.ok(/DIM\.baselineDimRecord\(/.test(viewerSrc), "DIMBASELINE chains real records");
  assert.ok(/X\.ellipseLoop\(c\.x, c\.y, rx, ry, 48, \(ang \* 180\) \/ Math\.PI\)/.test(viewerSrc), "ellipse tool honours the picked axis rotation");
  assert.ok(/typeFilter = new Set\(\);/.test(viewerSrc.split("cmd === \"FILTER\"")[1]?.split("cmd === ")[0] ?? ""), "FILTER CLEAR resets the dormant type filter");

  console.log("cad-drafting-completions: all assertions passed");
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
