// DIMSTYLE + associative dimension system — styles, defpoint tracking, rebuilds.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-dim-system-"));
try {
  execSync(
    "npx tsc src/modules/cad-viewer/dimension-system.ts src/modules/cad-viewer/dimension-tools.ts src/modules/drawings/dxf-writer.ts --outDir " +
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
  const writer = require(locate(out, "dxf-writer.js"));
  assert.ok(sys && writer, "compiled dimension-system and dxf-writer should exist");

  // ── Default styles ──
  const styles = sys.defaultDimStyles();
  assert.ok(styles.length >= 2 && styles[0].name === "ISO-25", "stock ISO-25 style exists");
  assert.strictEqual(styles[0].precision, 2);
  assert.strictEqual(styles[0].linearScale, 1);

  // ── formatMeasurement: precision, suffix, DIMLFAC factor ──
  assert.strictEqual(sys.formatMeasurement(1234.5678, { name: "t", textHeight: 2.5, arrowSize: 2.5, precision: 2, suffix: "", linearScale: 1 }), "1234.57");
  assert.strictEqual(sys.formatMeasurement(1234.5, { name: "t", textHeight: 2.5, arrowSize: 2.5, precision: 0, suffix: " mm", linearScale: 1 }), "1235 mm");
  assert.strictEqual(sys.formatMeasurement(10, { name: "t", textHeight: 2.5, arrowSize: 2.5, precision: 1, suffix: "", linearScale: 0.01 }), "0.1", "DIMLFAC factor scales the measurement");

  // ── measureRecord mirrors DIMLINEAR/DIMALIGNED maths ──
  assert.strictEqual(sys.measureRecord({ mode: "linear", p1: { x: 0, y: 0 }, p2: { x: 3, y: 4 } }), 4, "linear = max(dx,dy)");
  assert.strictEqual(sys.measureRecord({ mode: "aligned", p1: { x: 0, y: 0 }, p2: { x: 3, y: 4 } }), 5, "aligned = hypot");

  // ── buildDimEntities: tagged roles + style-driven geometry ──
  const style = styles[0];
  const rec = {
    id: "dim-test-1", styleName: "ISO-25", mode: "aligned", layer: "DIMS",
    p1: { x: 0, y: 0 }, p2: { x: 3000, y: 0 }, placement: { x: 1500, y: 500 },
  };
  const ents = sys.buildDimEntities(rec, style, "3000.00");
  assert.ok(ents.length >= 6, "dimension renders ext lines, dim line, ticks and text");
  assert.ok(ents.every((e) => e.meta && e.meta.dimId === "dim-test-1"), "every entity carries the dimension id");
  const roles = new Set(ents.map((e) => e.meta.role));
  assert.ok(roles.has("ext") && roles.has("dimline") && roles.has("arrow") && roles.has("text"), "roles: ext/dimline/arrow/text all present");
  const text = ents.find((e) => e.type === "TEXT");
  assert.strictEqual(text.value, "3000.00");
  assert.strictEqual(text.height, 2.5, "text height comes from the style");
  // Style with bigger text + colour override
  const big = { ...style, textHeight: 8, colorAci: 1 };
  const bigEnts = sys.buildDimEntities(rec, big, "3000.00");
  assert.strictEqual(bigEnts.find((e) => e.type === "TEXT").height, 8, "restyled text height applies");
  assert.ok(bigEnts.every((e) => e.color === 1), "style colour override reaches every entity");
  // Arrow size 0 falls back to derived-from-text-height (builder default)
  const autoArrow = sys.buildDimEntities(rec, { ...style, arrowSize: 0 }, "3000.00");
  assert.ok(autoArrow.length >= 6, "arrowSize 0 still renders ticks via the builder default");

  // ── entitiesOfDim ──
  assert.strictEqual(sys.entitiesOfDim(ents, "dim-test-1").length, ents.length);
  assert.strictEqual(sys.entitiesOfDim(ents, "dim-other").length, 0);

  // ── Associativity: MOVE both endpoints ──
  const wall = (sx, sy, ex, ey) => ({ type: "LINE", layer: "WALLS", start: { x: sx, y: sy }, end: { x: ex, y: ey } });
  const before = [wall(0, 0, 3000, 0)];
  const after = [wall(500, 0, 3500, 0)]; // whole wall moved +500
  const changed = sys.trackDimensionDefpoints([rec], before, after, 1e-6);
  assert.strictEqual(changed.length, 1, "dimension whose defpoints rode the move updates");
  assert.strictEqual(changed[0].p1.x, 500, "p1 follows the moved endpoint");
  assert.strictEqual(changed[0].p2.x, 3500, "p2 follows the moved endpoint");
  assert.strictEqual(changed[0].placement.x, 2000, "rigid move carries the dimension line along");
  assert.strictEqual(sys.measureRecord(changed[0]), 3000, "measurement unchanged under rigid move");
  // Unrelated geometry → no change
  assert.deepStrictEqual(sys.trackDimensionDefpoints([rec], [wall(100, 100, 200, 200)], [wall(300, 100, 400, 200)], 1e-6), [], "dims unrelated to the moved geometry stay put");

  // ── Associativity: STRETCH one endpoint (3000 → 4500) ──
  const stretched = sys.trackDimensionDefpoints([rec], [wall(0, 0, 3000, 0)], [wall(0, 0, 4500, 0)], 1e-6);
  assert.strictEqual(stretched.length, 1);
  assert.strictEqual(stretched[0].p1.x, 0, "fixed endpoint stays");
  assert.strictEqual(stretched[0].p2.x, 4500, "stretched endpoint follows");
  assert.strictEqual(sys.measureRecord(stretched[0]), 4500, "re-measured after stretch");
  assert.strictEqual(stretched[0].placement.x, 1500, "one-sided stretch keeps the dim line offset");

  // ── Associativity: ROTATE/SCALE per-point deltas (endpoint mapping) ──
  const scaled = sys.trackDimensionDefpoints([rec], [wall(0, 0, 3000, 0)], [wall(0, 0, 6000, 0)], 1e-6);
  assert.strictEqual(sys.measureRecord(scaled[0]), 6000, "scale doubles the measured distance");

  // ── restyleBatch: N→M rebuild pairs ──
  const styleMap = new Map(styles.map((s) => [s.name, s]));
  const batch = sys.restyleBatch([rec], styleMap, ents, () => "3000.000");
  assert.ok(batch.before.length >= ents.length, "restyle collects every tagged entity");
  assert.strictEqual(batch.before.length, batch.after.length || batch.after.length, "batch is a flat N→M pair");
  const newText = batch.after.find((e) => e.type === "TEXT");
  assert.strictEqual(newText.value, "3000.000");
  assert.ok(!batch.before.some((e) => e.meta.dimId !== "dim-test-1"), "restyle only touches its own dimension");

  // ── Convert semantics (DIMUPDATE): record switched to another style rebuilds with that style ──
  const rec2 = { ...rec, styleName: "ISO-25 Large" };
  const conv = sys.buildDimEntities(rec2, styleMap.get("ISO-25 Large"), "3000.00");
  assert.strictEqual(conv.find((e) => e.type === "TEXT").height, 5, "converted record rebuilds with the target style geometry");

  // ── endpointsOf coverage ──
  assert.strictEqual(sys.endpointsOf({ type: "LINE", layer: "0", start: { x: 1, y: 2 }, end: { x: 3, y: 4 } }).length, 2);
  assert.strictEqual(sys.endpointsOf({ type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }).length, 3);
  assert.strictEqual(sys.endpointsOf({ type: "CIRCLE", layer: "0", center: { x: 5, y: 5 }, radius: 1 }).length, 1);
  assert.strictEqual(sys.endpointsOf({ type: "TEXT", layer: "0", position: { x: 9, y: 9 }, height: 2, value: "a" }).length, 1);
  assert.strictEqual(sys.endpointsOf({ type: "SOLID", layer: "0" }).length, 0, "untransformed kinds expose no endpoints");

  // ── meta never leaks into DXF output ──
  const doc = { units: "mm", layers: [{ name: "0", color: 7 }, { name: "DIMS", color: 3 }], entities: ents, linetypes: {} };
  const dxf = typeof writer.writeDxf === "function" ? writer.writeDxf(doc) : writer.writeDxf(doc, "r12");
  assert.ok(typeof dxf === "string" && dxf.includes("3000.00"), "dimension text exports to DXF");
  assert.ok(!dxf.includes("dimId") && !dxf.includes("dim-test-1"), "in-memory meta is never serialized to DXF");

  console.log("DIMSTYLE + associative dimension system tests passed.");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
