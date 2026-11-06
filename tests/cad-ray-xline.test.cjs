/* RAY / XLINE construction lines — end-to-end tests.
 *
 * Native CAD draws RAY (half-infinite) and XLINE (infinite) construction
 * lines edge-to-edge; these tests pin the full pipeline:
 *   1. DXF reader parses RAY / XLINE entities (start + direction + layer)
 *   2. DXF writer round-trips them (write -> parse keeps type and geometry)
 *   3. entityBBox is a degenerate anchor box (infinite lines never define
 *      the drawing extents — native ZOOM Extents behaviour)
 *   4. infiniteLineSegment clips an infinite line to the view rect:
 *      XLINE both ways, RAY half-line, RAY pointing away -> null,
 *      parallel outside the view -> null
 *   5. distToEntity: perpendicular distance, clamped behind a RAY's start
 *   6. Super Copy translateEntity moves only the anchor
 *   7. modify-math: ROTATE swings the direction vector, MIRROR reflects it
 */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "rayxline-"));
execSync(`npx tsc src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-writer.ts src/modules/cad-viewer/viewer-math.ts src/modules/cad-viewer/clipboard.ts src/modules/cad-viewer/modify-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const { parseDxf } = require(find(out, "dxf-reader.js"));
const { writeDxf } = require(find(out, "dxf-writer.js"));
const { entityBBox, infiniteLineSegment, distToEntity } = require(find(out, "viewer-math.js"));
const { translateEntity } = require(find(out, "clipboard.js"));
const { rotateEnt, mirrorEnt } = require(find(out, "modify-math.js"));

let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a}!=${b}`);
const D = (...a) => a.flat().map(String).filter(x => x !== "").join("\n");
const sec = (name, body) => D("0", "SECTION", "2", name, body, "0", "ENDSEC");
const file = (o = {}) => D(o.header ? sec("HEADER", o.header) : "", o.tables ? sec("TABLES", o.tables) : "", o.blocks ? sec("BLOCKS", o.blocks) : "", sec("ENTITIES", o.ents || ""), o.objects ? sec("OBJECTS", o.objects) : "", "0", "EOF");
// View centred on (0,0), 100x60 world units on a 1000x600 px canvas
const V = { cx: 0, cy: 0, scale: 10, w: 1000, h: 600 };

t("DXF reader parses RAY and XLINE construction lines", () => {
  const ents = D("0", "RAY", "8", "CONS", "10", "5", "20", "5", "30", "0", "11", "1", "21", "0", "31", "0",
    "0", "XLINE", "8", "CONS", "10", "0", "20", "0", "30", "0", "11", "0", "21", "1", "31", "0");
  const d = parseDxf(file({ ents }));
  assert.strictEqual(d.entities.length, 2, `expected 2 entities, got ${d.entities.length} (skipped: ${JSON.stringify(d.skipped)})`);
  const r = d.entities[0], x = d.entities[1];
  assert.strictEqual(r.type, "RAY"); assert.strictEqual(r.layer, "CONS");
  near(r.start.x, 5); near(r.start.y, 5); near(r.direction.x, 1); near(r.direction.y, 0);
  assert.strictEqual(x.type, "XLINE"); near(x.direction.y, 1);
});
t("DXF reader refuses a zero-direction RAY (counted in skipped)", () => {
  const ents = D("0", "RAY", "8", "A", "10", "1", "20", "2", "30", "0", "11", "0", "21", "0", "31", "0");
  const d = parseDxf(file({ ents }));
  assert.strictEqual(d.entities.length, 0);
  assert.strictEqual(d.skipped.RAY, 1);
});
t("DXF writer round-trips RAY and XLINE", () => {
  const doc = {
    layers: [{ name: "0", color: 7 }, { name: "CONS", color: 8 }],
    entities: [
      { type: "RAY", layer: "CONS", start: { x: 5, y: 5, z: 0 }, direction: { x: 2, y: 0, z: 0 } },
      { type: "XLINE", layer: "0", start: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: -3, z: 0 } },
    ],
  };
  const d = parseDxf(writeDxf(doc));
  assert.strictEqual(d.entities.length, 2, `round-trip lost entities (skipped: ${JSON.stringify(d.skipped)})`);
  const r = d.entities[0], x = d.entities[1];
  assert.strictEqual(r.type, "RAY"); assert.strictEqual(r.layer, "CONS");
  near(r.start.x, 5); near(r.direction.x, 2);
  assert.strictEqual(x.type, "XLINE"); near(x.direction.y, -3);
  // A RAY keeps one-sided semantics through the round trip (XLINE stays two-sided)
  assert.notStrictEqual(r.type, x.type);
});
t("entityBBox is a degenerate anchor box for infinite lines", () => {
  const b = entityBBox({ type: "XLINE", layer: "0", start: { x: 7, y: -3 }, direction: { x: 1, y: 1 } });
  near(b.minX, 7); near(b.maxX, 7); near(b.minY, -3); near(b.maxY, -3);
});
t("infiniteLineSegment clips an XLINE across the view", () => {
  const seg = infiniteLineSegment({ type: "XLINE", start: { x: 0, y: 0 }, direction: { x: 1, y: 0 } }, V);
  assert.ok(seg, "expected a visible segment");
  // The view spans x in [-50 - 5% pad, +50 + 5% pad] -> the clip runs edge to edge
  assert.ok(seg[0].x < -50 && seg[1].x > 50, `segment ${JSON.stringify(seg)} does not span the view`);
  near(seg[0].y, 0); near(seg[1].y, 0);
});
t("RAY clips to a half-line and stops behind its start", () => {
  const seg = infiniteLineSegment({ type: "RAY", start: { x: 0, y: 10 }, direction: { x: -1, y: 0 } }, V);
  assert.ok(seg, "expected a visible segment");
  near(seg[0].x, 0); // the t = 0 end is the anchor itself
  near(seg[0].y, 10);
  assert.ok(seg[1].x < -50 && seg[1].x < seg[0].x, `half-line does not extend left: ${JSON.stringify(seg)}`);
  near(seg[1].y, 10);
  // A RAY pointing away from the view draws nothing
  const away = infiniteLineSegment({ type: "RAY", start: { x: 60, y: 0 }, direction: { x: 1, y: 0 } }, V);
  assert.strictEqual(away, null, "RAY pointing away must not draw");
});
t("parallel line outside the view draws nothing", () => {
  const seg = infiniteLineSegment({ type: "XLINE", start: { x: 0, y: 500 }, direction: { x: 1, y: 0 } }, V);
  assert.strictEqual(seg, null, "XLINE far outside the view must not draw");
});
t("distToEntity is the perpendicular distance, clamped behind a RAY", () => {
  const x = { type: "XLINE", layer: "0", start: { x: 0, y: 0 }, direction: { x: 1, y: 0 } };
  near(distToEntity(x, 40, 7), 7);
  near(distToEntity(x, -40, -2), 2);
  const r = { type: "RAY", layer: "0", start: { x: 0, y: 0 }, direction: { x: 1, y: 0 } };
  near(distToEntity(r, 40, 7), 7);
  near(distToEntity(r, -40, 0), 40, 1e-4); // behind the start: distance to the anchor
});
t("Super Copy moves only the anchor of construction lines", () => {
  const e = { type: "XLINE", layer: "0", start: { x: 1, y: 2 }, direction: { x: 3, y: 4 } };
  const t1 = translateEntity(e, 10, 20);
  near(t1.start.x, 11); near(t1.start.y, 22);
  near(t1.direction.x, 3); near(t1.direction.y, 4); // direction is relative — unchanged
  assert.notStrictEqual(t1, e, "must be a fresh object");
});
t("ROTATE swings the direction vector with the anchor", () => {
  const e = { type: "RAY", layer: "0", start: { x: 10, y: 0 }, direction: { x: 1, y: 0 } };
  const r = rotateEnt(e, 0, 0, 90);
  near(r.start.x, 0); near(r.start.y, 10);
  near(r.direction.x, 0, 1e-9); near(r.direction.y, 1, 1e-9);
});
t("MIRROR reflects the direction through the mirrored anchor", () => {
  const e = { type: "XLINE", layer: "0", start: { x: 2, y: 0 }, direction: { x: 1, y: 0 } };
  const m = mirrorEnt(e, { x: 0, y: 0 }, { x: 0, y: 1 }); // mirror across the Y axis
  near(m.start.x, -2);
  near(m.direction.x, -1, 1e-9); near(m.direction.y, 0, 1e-9);
});

fs.rmSync(out, { recursive: true, force: true });
console.log(`\ncad-ray-xline: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
