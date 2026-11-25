// Annotation completion (AutoCAD parity A10) — node test.
//
// Four sub-items, each proved fail-without-fix against the base:
//   1. Ordinate dimension — no DIMORDINATE existed. The dimension system
//      gains an "ordinate" mode (datum = the feature's WCS coordinate from
//      the origin), the writer emits a real DIMENSION dimType 6 with group
//      13 = leader end, and the reader regenerates it natively.
//   2. Arc variants — ARC was 3-point only. The pure builders cover
//      start-center-end, start-end-angle/radius and center-start-angle/
//      length; the 3-point builder also fixes a real bug (a clockwise
//      3-point arc rendered as the complementary counter-clockwise arc).
//   3. True MTEXT — TEXT with a wrap width is now written as a real MTEXT
//      record (AcDbMText, group 41 = column width, \P paragraphs) and
//      reads back as wrapping text; plain TEXT is unchanged.
//   4. Leader as an entity — proved by source markers (the viewer is
//      DOM-heavy and cannot be compiled headlessly): the leader case
//      builds arrowhead + LINE + TEXT through addEntities instead of
//      pushing a transient markup.
//
// No mocks: the builders, system, writer and reader under test are the
// shipped ones.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-annotation-a10-"));
fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, a + "!=" + b);
const nearPt = (a, b, e = 1e-6) => { near(a.x, b.x, e); near(a.y, b.y, e); };
try {
  execSync(
    "npx tsc src/modules/cad-viewer/cad-annotation.ts src/modules/cad-viewer/dimension-system.ts src/modules/cad-viewer/dimension-tools.ts " +
      "src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-geometry.ts --outDir " + out +
      " --module commonjs --target es2020 --skipLibCheck --esModuleInterop",
    { cwd: root, stdio: "pipe" },
  );
  const locate = (dir, name) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = locate(p, name); if (found) return found; }
      else if (entry.name === name) return p;
    }
    return null;
  };
  const ann = require(locate(out, "cad-annotation.js"));
  const sys = require(locate(out, "dimension-system.js"));
  const { writeDxf } = require(locate(out, "dxf-writer.js"));
  const { parseDxf } = require(locate(out, "dxf-reader.js"));
  const geom = require(locate(out, "dxf-geometry.js"));

  // Point on the arc at a given fraction of its CCW sweep (0..1).
  const arcPt = (def, f) => {
    const sweep = ((def.endAngle - def.startAngle) % 360 + 360) % 360 || 360;
    const a = ((def.startAngle + sweep * f) * Math.PI) / 180;
    return { x: def.center.x + def.radius * Math.cos(a), y: def.center.y + def.radius * Math.sin(a) };
  };

  // ── Arc variants (pure builders) ──
  t("arc 3-point: centre/radius/angles for the CCW arc", () => {
    const def = ann.arcFrom3Points({ x: 10, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 0 });
    assert.ok(def);
    nearPt(def.center, { x: 5, y: 0 });
    near(def.radius, 5);
    near(def.startAngle, 0);
    near(def.endAngle, 180);
    nearPt(arcPt(def, 0.5), { x: 5, y: 5 }); // the arc passes through the middle point
  });
  t("arc 3-point: clockwise middle point renders the arc through it (not the complement)", () => {
    // p2 sits on the clockwise side of the p1→p3 chord: the old inline code
    // drew the complementary CCW arc (through (5,-5)) instead of through p2.
    const def = ann.arcFrom3Points({ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 });
    assert.ok(def);
    near(def.startAngle, 0);
    near(def.endAngle, 180);
    nearPt(arcPt(def, 0.5), { x: 5, y: 5 });
    const def2 = ann.arcFrom3Points({ x: 10, y: 0 }, { x: 5, y: -5 }, { x: 0, y: 0 });
    assert.ok(def2);
    nearPt(arcPt(def2, 0.5), { x: 5, y: -5 });
  });
  t("arc 3-point: collinear points have no circle", () => {
    assert.strictEqual(ann.arcFrom3Points({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }), null);
  });
  t("arc start-center-end: radius from centre→start, end fixes the angle", () => {
    const def = ann.arcFromStartCenterEnd({ x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 });
    assert.ok(def);
    near(def.radius, 10);
    near(def.startAngle, 0);
    near(def.endAngle, 90);
    assert.strictEqual(ann.arcFromStartCenterEnd({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }), null);
  });
  t("arc start-end-angle: positive draws CCW, negative CW (same arc, swapped angles)", () => {
    const ccw = ann.arcFromStartEndAngle({ x: 0, y: 0 }, { x: 10, y: 0 }, 90);
    assert.ok(ccw);
    nearPt(ccw.center, { x: 5, y: 5 });
    near(ccw.radius, 10 / (2 * Math.sin(Math.PI / 4)));
    nearPt(arcPt(ccw, 0.5), { x: 5, y: 5 - ccw.radius });
    const cw = ann.arcFromStartEndAngle({ x: 0, y: 0 }, { x: 10, y: 0 }, -90);
    assert.ok(cw);
    nearPt(cw.center, { x: 5, y: -5 });
    nearPt(arcPt(cw, 0.5), { x: 5, y: -5 + cw.radius });
    assert.strictEqual(ann.arcFromStartEndAngle({ x: 0, y: 0 }, { x: 10, y: 0 }, 0), null);
    assert.strictEqual(ann.arcFromStartEndAngle({ x: 0, y: 0 }, { x: 10, y: 0 }, 360), null);
  });
  t("arc start-end-radius: positive minor CCW, negative CW, too small is null", () => {
    const pos = ann.arcFromStartEndRadius({ x: 0, y: 0 }, { x: 10, y: 0 }, 5);
    assert.ok(pos);
    nearPt(pos.center, { x: 5, y: 0 });
    nearPt(arcPt(pos, 0.5), { x: 5, y: -5 });
    const neg = ann.arcFromStartEndRadius({ x: 0, y: 0 }, { x: 10, y: 0 }, -5);
    assert.ok(neg);
    nearPt(arcPt(neg, 0.5), { x: 5, y: 5 });
    assert.strictEqual(ann.arcFromStartEndRadius({ x: 0, y: 0 }, { x: 10, y: 0 }, 4), null);
    assert.strictEqual(ann.arcFromStartEndRadius({ x: 0, y: 0 }, { x: 10, y: 0 }, -4), null);
  });
  t("arc center-start-angle: signed sweep from the start point", () => {
    const ccw = ann.arcFromCenterStartAngle({ x: 0, y: 0 }, { x: 10, y: 0 }, 90);
    assert.ok(ccw);
    near(ccw.radius, 10);
    near(ccw.startAngle, 0);
    near(ccw.endAngle, 90);
    nearPt(arcPt(ccw, 1), { x: 0, y: 10 });
    const cw = ann.arcFromCenterStartAngle({ x: 0, y: 0 }, { x: 10, y: 0 }, -90);
    assert.ok(cw);
    // Clockwise: stored swapped, so the geometric end sits at the start of
    // the stored CCW sweep and the geometric start at its end.
    nearPt(arcPt(cw, 0), { x: 0, y: -10 });
    nearPt(arcPt(cw, 0.5), { x: 5 * Math.sqrt(2), y: -5 * Math.sqrt(2) });
    nearPt(arcPt(cw, 1), { x: 10, y: 0 });
    assert.strictEqual(ann.arcFromCenterStartAngle({ x: 0, y: 0 }, { x: 10, y: 0 }, 0), null);
  });
  t("arc center-start-length: chord length fixes the minor sweep", () => {
    const def = ann.arcFromCenterStartLength({ x: 0, y: 0 }, { x: 10, y: 0 }, 10);
    assert.ok(def);
    near(def.radius, 10);
    near(def.endAngle, 60);
    nearPt(arcPt(def, 1), { x: 5, y: 5 * Math.sqrt(3) });
    assert.strictEqual(ann.arcFromCenterStartLength({ x: 0, y: 0 }, { x: 10, y: 0 }, 21), null);
    assert.strictEqual(ann.arcFromCenterStartLength({ x: 0, y: 0 }, { x: 10, y: 0 }, 0), null);
  });
  t("ordinate axis: dominant leader offset decides X vs Y", () => {
    assert.strictEqual(ann.ordinateAxis({ x: 100, y: 200 }, { x: 500, y: 210 }), "x");
    assert.strictEqual(ann.ordinateAxis({ x: 100, y: 200 }, { x: 110, y: 600 }), "y");
    assert.strictEqual(ann.ordinateAxis({ x: 100, y: 200 }, { x: 300, y: 400 }), "x"); // tie goes X
  });
  t("leader arrowhead: filled triangle, tip on the arrow point, base trailing back", () => {
    const arrow = ann.buildLeaderArrowhead({ x: 0, y: 0 }, { x: 10, y: 0 }, 5);
    assert.ok(arrow);
    assert.strictEqual(arrow.type, "LWPOLYLINE");
    assert.strictEqual(arrow.closed, true);
    assert.strictEqual(arrow.hatch.solid, true);
    assert.deepStrictEqual(arrow.hatch.loops[0], arrow.points);
    nearPt(arrow.points[0], { x: 0, y: 0 });
    // Base trails back toward `from` (10,0): x = +5, spread ±1.6 across.
    nearPt(arrow.points[1], { x: 5, y: -1.6 });
    nearPt(arrow.points[2], { x: 5, y: 1.6 });
    assert.strictEqual(ann.buildLeaderArrowhead({ x: 0, y: 0 }, { x: 0, y: 0 }, 5), null);
  });

  // ── Ordinate dimension (system + builders) ──
  const style = sys.defaultDimStyles()[0]; // ISO-25, text 2.5 / arrow 2.5 / 2 decimals
  t("ordinate measure: the feature's WCS coordinate, sign kept", () => {
    assert.strictEqual(sys.measureRecord({ mode: "ordinate", p1: { x: 500, y: 300 }, p2: { x: 520, y: 340 }, placement: { x: 520, y: 340 }, axis: "x" }), 500);
    assert.strictEqual(sys.measureRecord({ mode: "ordinate", p1: { x: 500, y: 300 }, p2: { x: 520, y: 340 }, placement: { x: 520, y: 340 }, axis: "y" }), 300);
    assert.strictEqual(sys.measureRecord({ mode: "ordinate", p1: { x: -50, y: 300 }, p2: { x: -30, y: 340 }, placement: { x: -30, y: 340 }, axis: "x" }), -50);
  });
  t("ordinate build (X): horizontal dim line at the leader end, vertical extension, level text", () => {
    const rec = { id: "dim-ord", styleName: "ISO-25", mode: "ordinate", layer: "DIMS", p1: { x: 500, y: 0 }, p2: { x: 520, y: 40 }, placement: { x: 520, y: 40 }, axis: "x" };
    const built = sys.buildDimEntities(rec, style, "500.00");
    assert.strictEqual(built.length, 5);
    const dimLine = built.find((e) => e.type === "LINE" && e.meta?.role === "dimline");
    assert.ok(dimLine);
    nearPt(dimLine.start, { x: 500, y: 40 });
    nearPt(dimLine.end, { x: 521.875, y: 40 });
    const ext = built.find((e) => e.type === "LINE" && e.meta?.role === "ext");
    assert.ok(ext);
    nearPt(ext.start, { x: 500, y: 0.625 });
    nearPt(ext.end, { x: 500, y: 41.875 });
    const text = built.find((e) => e.type === "TEXT");
    assert.ok(text);
    assert.strictEqual(text.value, "500.00");
    assert.strictEqual(text.rotation, 0);
    nearPt(text.position, { x: 522.5, y: 40 });
  });
  t("ordinate build (Y): vertical dim line, horizontal extension, rotated text", () => {
    const rec = { id: "dim-ord-y", styleName: "ISO-25", mode: "ordinate", layer: "DIMS", p1: { x: 100, y: 200 }, p2: { x: 110, y: 600 }, placement: { x: 110, y: 600 }, axis: "y" };
    const built = sys.buildDimEntities(rec, style, "200.00");
    const dimLine = built.find((e) => e.type === "LINE" && e.meta?.role === "dimline");
    assert.ok(dimLine);
    nearPt(dimLine.start, { x: 110, y: 200 });
    nearPt(dimLine.end, { x: 110, y: 601.875 });
    const text = built.find((e) => e.type === "TEXT");
    assert.ok(text);
    assert.strictEqual(text.value, "200.00");
    assert.strictEqual(text.rotation, 90);
  });
  t("ordinate associativity: leader end rides with the feature point", () => {
    const rec = { id: "dim-ord", styleName: "ISO-25", mode: "ordinate", layer: "DIMS", p1: { x: 100, y: 200 }, p2: { x: 120, y: 260 }, placement: { x: 120, y: 260 }, axis: "x" };
    const before = [{ type: "LINE", layer: "0", start: { x: 100, y: 200 }, end: { x: 300, y: 200 } }];
    const after = [{ type: "LINE", layer: "0", start: { x: 110, y: 220 }, end: { x: 310, y: 220 } }];
    const changed = sys.trackDimensionDefpoints([rec], before, after);
    assert.strictEqual(changed.length, 1);
    nearPt(changed[0].p1, { x: 110, y: 220 });
    nearPt(changed[0].p2, { x: 130, y: 280 });
    nearPt(changed[0].placement, { x: 130, y: 280 });
    assert.strictEqual(sys.measureRecord(changed[0]), 110);
  });

  // ── DXF text helpers (same as dimension-writer.test.cjs) ──
  const pairsOf = (text) => {
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    assert.strictEqual(lines.length % 2, 0, "odd line count in DXF text");
    const pairs = [];
    for (let i = 0; i < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);
    return pairs;
  };
  const recordsOf = (text) => {
    const recs = [];
    let cur = null;
    for (const [code, value] of pairsOf(text)) {
      if (code === "0") { cur = { type: value.trim(), pairs: [] }; recs.push(cur); }
      else if (cur) cur.pairs.push([code, value]);
    }
    return recs;
  };
  const recVal = (rec, code, n = 0) => {
    const hits = rec.pairs.filter(([c]) => c === String(code)).map(([, v]) => v);
    return hits[n];
  };
  const recNum = (rec, code, n = 0) => {
    const v = recVal(rec, code, n);
    return v === undefined ? undefined : parseFloat(v);
  };
  const pt = (rec, xCode) => {
    const yCode = String(Number(xCode) + 10), zCode = String(Number(xCode) + 20);
    return recVal(rec, xCode) === undefined ? undefined : { x: recNum(rec, xCode), y: recNum(rec, yCode), z: recNum(rec, zCode) };
  };
  const dimsOf = (text) => recordsOf(text).filter((r) => r.type === "DIMENSION");
  const textsOf = (doc) => doc.entities.filter((e) => e.type === "TEXT").map((e) => e.value);

  // ── Build a drawing: ordinate dimension + MTEXT + plain controls ──
  const recOrd = { id: "dim-ord", styleName: "ISO-25", mode: "ordinate", layer: "DIMS", p1: { x: 500, y: 0 }, p2: { x: 520, y: 40 }, placement: { x: 520, y: 40 }, axis: "x" };
  const gOrd = sys.buildDimEntities(recOrd, style, "500.00");
  const textOf = (g) => g.find((e) => e.type === "TEXT");
  const dimOrdEnt = {
    type: "DIMENSION", layer: "DIMS", dimId: "dim-ord", dimType: 6, styleName: "ISO-25",
    defPoint: { ...recOrd.p1 }, leaderEnd: { ...recOrd.p2 },
    text: textOf(gOrd).value, textPoint: { ...textOf(gOrd).position },
  };
  const plainLine = { type: "LINE", layer: "0", start: { x: 0, y: -50 }, end: { x: 50, y: -50 } };
  const plainText = { type: "TEXT", layer: "0", position: { x: 0, y: -60 }, height: 2.5, value: "NOTE" };
  const mtextEnt = { type: "TEXT", layer: "0", position: { x: 0, y: -80 }, height: 2.5, value: "FIRST\nSECOND", wrapWidth: 20, valign: "top", align: "left" };
  const doc = {
    units: "mm",
    layers: [{ name: "0", color: 7 }, { name: "DIMS", color: 3 }],
    entities: [plainLine, plainText, mtextEnt, ...gOrd, dimOrdEnt],
    dimStyleTable: { "ISO-25": { textHeight: 2.5, arrowSize: 2.5, decimals: 2 } },
  };
  const dxf = writeDxf(doc);

  t("writer emits the ordinate as a real DIMENSION dimType 6 (group 70 = 6|32)", () => {
    assert.strictEqual(dimsOf(dxf).length, 1);
    const [ord] = dimsOf(dxf);
    assert.strictEqual(recNum(ord, 70), 38);
    assert.strictEqual(recNum(ord, 70) & 7, 6);
    assert.strictEqual(recVal(ord, 1), "500.00");
    assert.strictEqual(recVal(ord, 3), "ISO-25");
    assert.ok(/^\*D\d+$/.test(recVal(ord, 2)), "block " + recVal(ord, 2));
  });
  t("writer ordinate definition points: feature at 10, leader end at 13, no rotation", () => {
    const [ord] = dimsOf(dxf);
    assert.deepStrictEqual(pt(ord, 10), { x: 500, y: 0, z: 0 });
    assert.deepStrictEqual(pt(ord, 13), { x: 520, y: 40, z: 0 });
    assert.strictEqual(recVal(ord, 50), undefined, "ordinate carries no group 50");
    assert.strictEqual(recVal(ord, 14), undefined, "ordinate has no second extension origin");
    assert.strictEqual(recVal(ord, 15), undefined, "ordinate has no curve point");
  });
  t("writer ordinate geometry lives in the anonymous *D block", () => {
    const recs = recordsOf(dxf);
    const blockTexts = [];
    let curBlock = null;
    for (const r of recs) {
      if (r.type === "BLOCK") curBlock = recVal(r, 2);
      else if (r.type === "ENDBLK") curBlock = null;
      else if (r.type === "TEXT" && curBlock && curBlock.startsWith("*D")) blockTexts.push(recVal(r, 1));
    }
    assert.deepStrictEqual(blockTexts, ["500.00"]);
  });
  t("writer emits wrapped text as a real MTEXT record; plain TEXT stays TEXT", () => {
    const mtexts = recordsOf(dxf).filter((r) => r.type === "MTEXT");
    assert.strictEqual(mtexts.length, 1);
    const [mt] = mtexts;
    assert.strictEqual(recNum(mt, 40), 2.5);
    assert.strictEqual(recNum(mt, 41), 20);
    assert.strictEqual(recVal(mt, 1), "FIRST\\PSECOND");
    assert.strictEqual(recNum(mt, 71), 1); // top-left attachment
    assert.ok(mt.pairs.some(([c, v]) => c === "100" && v === "AcDbMText"), "AcDbMText subclass");
    const texts = recordsOf(dxf).filter((r) => r.type === "TEXT" && !r.pairs.some(([c]) => c === "41"));
    assert.ok(texts.some((r) => recVal(r, 1) === "NOTE"), "plain TEXT still written as TEXT");
  });

  // ── Round trip through the real reader ──
  const back = parseDxf(dxf);
  t("round trip: ordinate measurement appears exactly once, nothing skipped", () => {
    assert.ok(!back.skipped?.DIMENSION, "DIMENSION skipped: " + JSON.stringify(back.skipped));
    assert.strictEqual(textsOf(back).filter((x) => x === "500.00").length, 1);
  });
  t("round trip: MTEXT reads back as wrapping text, plain TEXT intact", () => {
    const wrapped = back.entities.find((e) => e.type === "TEXT" && e.value === "FIRST\nSECOND");
    assert.ok(wrapped, "MTEXT value with \\n not found");
    assert.strictEqual(wrapped.wrapWidth, 20);
    assert.strictEqual(wrapped.valign, "top");
    assert.strictEqual(wrapped.align, "left");
    assert.ok(back.entities.some((e) => e.type === "TEXT" && e.value === "NOTE" && !e.wrapWidth), "plain TEXT lost or gained a width");
  });
  t("round trip: entity count is plain + dimension geometry, nothing duplicated", () => {
    const expected = 3 + gOrd.length; // plain line + plain text + mtext + ordinate geometry
    assert.strictEqual(back.entities.length, expected, "got " + back.entities.length + ", want " + expected);
  });

  // ── Native fallback: strip the *D blocks; the defpoints alone must re-measure ──
  const stripBlocks = (text) => {
    const lines = text.split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);
    const keep = [];
    let inBlocks = false;
    for (let i = 0; i < pairs.length; i++) {
      const [c, v] = pairs[i];
      if (c === "0" && v === "SECTION") inBlocks = pairs[i + 1] && pairs[i + 1][1] === "BLOCKS";
      if (inBlocks) {
        if (c === "0" && v === "ENDSEC") inBlocks = false;
        continue;
      }
      keep.push(pairs[i]);
    }
    return keep.map(([c, v]) => c + "\n" + v).join("\n") + "\n";
  };
  t("native fallback: stripped of blocks, the ordinate defpoints re-measure 500.00", () => {
    const stripped = stripBlocks(dxf);
    assert.strictEqual(dimsOf(stripped).length, 1, "DIMENSION record must survive the strip");
    const fb = parseDxf(stripped);
    assert.ok(!fb.skipped?.DIMENSION, "fallback skipped a DIMENSION: " + JSON.stringify(fb.skipped));
    assert.strictEqual(textsOf(fb).filter((x) => x === "500.00").length, 1, "ordinate not regenerated from defpoints");
    const wrapped = fb.entities.find((e) => e.type === "TEXT" && e.value === "FIRST\nSECOND");
    assert.ok(wrapped && wrapped.wrapWidth === 20, "MTEXT lost in the fallback read");
  });

  // ── Old behaviour guards ──
  t("invalid ordinate (no leader end) is skipped, geometry stays plain", () => {
    const bad = writeDxf({
      units: "mm", layers: doc.layers,
      entities: [
        ...gOrd,
        { type: "DIMENSION", layer: "DIMS", dimId: "dim-ord", dimType: 6, defPoint: { x: 500, y: 0 } },
      ],
    });
    assert.strictEqual(dimsOf(bad).length, 0, "unmeasurable ordinate written");
    assert.ok(textsOf(parseDxf(bad)).includes("500.00"), "geometry lost with the invalid DIMENSION");
  });
  t("geometry transform moves an ordinate's leader end with the dimension", () => {
    const moved = geom.transformEntity(dimOrdEnt, { sx: 1, sy: 1, sz: 1, rot: 0, base: { x: 0, y: 0 }, ins: { x: 10, y: 20 } });
    assert.strictEqual(moved.length, 1);
    assert.deepStrictEqual(moved[0].defPoint, { x: 510, y: 20, z: 0 });
    assert.deepStrictEqual(moved[0].leaderEnd, { x: 530, y: 60, z: 0 });
    assert.strictEqual(moved[0].dimType, 6);
  });

  // ── Source markers: the viewer wiring (DOM-heavy, cannot compile headlessly) ──
  const viewer = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  const styleUi = fs.readFileSync(path.join(root, "src/features/cad-style-ui.ts"), "utf8");
  t("viewer: DIMORDINATE command + dimord tool wired", () => {
    assert.ok(viewer.includes('cmd === "DIMORDINATE" || cmd === "DIMORD" || cmd === "DOR"'), "no DIMORDINATE dispatch");
    assert.ok(viewer.includes('setTool("dimord")'), "no setTool dimord");
    assert.ok(viewer.includes('case "dimord":'), "no dimord draw case");
    assert.ok(viewer.includes('mode: "ordinate", axis,'), "dimord case does not pass the axis");
    assert.ok(viewer.includes('tb("dimord", "dim-ordinate", "Ordinate")'), "no Ordinate ribbon button");
    assert.ok(viewer.includes('["Ordinate Dimension","dimord"]'), "no Ordinate context-menu entry");
  });
  t("viewer: ordinate saved as a real DIMENSION (dimType 6, leaderEnd)", () => {
    assert.ok(viewer.includes('rec.mode === "ordinate"'), "save path does not mention ordinate");
    assert.ok(viewer.includes('rec.mode === "ordinate" ? 6 : 4'), "save path does not map ordinate to dimType 6");
    assert.ok(viewer.includes('leaderEnd: { ...rec.p2 }'), "save path does not write leaderEnd");
  });
  t("viewer: MTEXT is its own tool/command, not an alias of TEXT", () => {
    assert.ok(viewer.includes('cmd === "MT" || cmd === "MTEXT"'), "no MTEXT dispatch");
    assert.ok(viewer.includes('setTool("mtext")'), "no setTool mtext");
    assert.ok(viewer.includes('case "mtext":'), "no mtext draw case");
    assert.ok(viewer.includes('void placeMText(styleApi, corner, width);'), "mtext case does not place with the column width");
    assert.ok(viewer.includes('["Multiline Text","mtext"]'), "no Multiline Text context-menu entry");
    assert.ok(styleUi.includes("export async function placeMText"), "placeMText missing from cad-style-ui");
    assert.ok(styleUi.includes("wrapWidth: w, valign: \"top\""), "placeMText does not set wrapWidth/top anchor");
  });
  t("viewer: ARC variants wired (mode state, keywords, numeric handlers)", () => {
    assert.ok(viewer.includes('let arcMode: "3p" | "cse" | "sce" | "sea" | "csa" = "3p"'), "no arcMode state");
    assert.ok(viewer.includes("handleArcOption(trimmed)"), "no arc keyword intercept");
    assert.ok(viewer.includes("onArcAngleTyped"), "no angle handler");
    assert.ok(viewer.includes("onArcRadiusTyped"), "no radius handler");
    assert.ok(viewer.includes("onArcLengthTyped"), "no length handler");
    assert.ok(viewer.includes("Ann.arcFrom3Points(pts[0], pts[1], pts[2])"), "3-point arc does not use the shared builder");
    assert.ok(viewer.includes("Ann.arcFromStartCenterEnd"), "no start-center-end wiring");
    assert.ok(viewer.includes('if (t !== "arc") arcMode = "3p"'), "arcMode not reset on tool change");
  });
  t("viewer: Leader creates persistent entities (arrowhead + line + text), not a markup", () => {
    assert.ok(viewer.includes("Ann.buildLeaderArrowhead(tip, landing, arrowSize)"), "leader does not build an arrowhead");
    assert.ok(viewer.includes('if (arrow) parts.unshift({ ...arrow, layer: currentLayer, ...newObjectProps() });'), "leader arrowhead not committed");
    assert.ok(viewer.includes("addEntities(parts);"), "leader does not commit entities");
    assert.ok(viewer.includes('logCmd(`Leader added: "${t}".`);'), "leader log not updated");
  });
  t("viewer: addDraftEntity/paste no longer double-add in model space (found by the A10 spec)", () => {
    // In model space ents IS modelEnts (same array), so the old unguarded
    // `if (layoutI < 0) modelEnts.push(e)` pushed every drafted entity
    // twice — CENSUS counted the ARC and the MTEXT twice and the save
    // wrote them twice. Both push sites now carry the modelEnts !== ents
    // guard that addEntities already had.
    const hits = viewer.match(/if \(layoutI < 0 && modelEnts !== ents\) modelEnts\.push\(e\);/g) ?? [];
    assert.strictEqual(hits.length, 2, "expected the guard at both push sites, got " + hits.length);
    assert.ok(!viewer.includes("if (layoutI < 0) modelEnts.push(e);"), "unguarded push remains");
  });
} catch (e) {
  fail++;
  console.log("  FAIL setup: " + (e && e.stack || e));
} finally {
  try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`=== cad annotation a10: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}
