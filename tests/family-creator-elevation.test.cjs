/**
 * tests/family-creator-elevation.test.cjs
 *
 * Prototype: two-view elevation drawing -> parts, each number marked extracted / entered / assumed.
 * Synthetic drawing (a cabinet with two doors, a louvre grille, a skid and a pipe, plus red
 * dimension lines that must be ignored). Real manufacturer drawings are checked outside this test.
 *
 * Run: `node tests/family-creator-elevation.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ok - ${name}`); } catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); } }
const near = (a, b, tol, msg = "") => { if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}) ${msg}`); };
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".family-creator-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => { try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ } });
execSync("npx tsc src/modules/families/creator/elevation.ts src/modules/families/creator/outline.ts --outDir " + JSON.stringify(tmpOut) + " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck", { cwd: root, stdio: "inherit", shell: true });
const find = (n) => { const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = walk(p); if (r) return r; } else if (f.name === n) return p; } return null; }; return walk(tmpOut); };
const E = require(find("elevation.js"));

// 1 px = 2 mm. Cabinet 2000 long x 1000 wide x 1200 high on a skid (1800 x 900 x 200) with a pipe (100 wide, 300 above).
const S = 2, W = 1800, H = 520, ox = 40, gy = 480; // ground line at row gy
const img = new Uint8ClampedArray(W * H * 4).fill(255);
const px = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255; };
const rect = (x0, y0, x1, y1, c = [20, 20, 20], th = 2) => { for (let x = x0; x <= x1; x++) for (let k = 0; k < th; k++) { px(x, y0 + k, ...c); px(x, y1 - k, ...c); } for (let y = y0; y <= y1; y++) for (let k = 0; k < th; k++) { px(x0 + k, y, ...c); px(x1 - k, y, ...c); } };
const hatch = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y += 3) for (let x = x0; x <= x1; x++) { px(x, y, 20, 20, 20); px(x, y + 1, 20, 20, 20); } };
// side view: body 1000 px wide (2000 mm) from x=ox, height 600 mm = 300 px above skid
const bx0 = ox, bx1 = ox + 999, by1 = gy - 100 - 1, by0 = by1 - 300;
rect(bx0, by0, bx1, by1);
rect(bx0 + 100, by0 + 40, bx0 + 400, by1 - 20);       // door 1
rect(bx0 + 450, by0 + 40, bx0 + 900, by1 - 20);       // door 2
rect(bx0 + 130, by0 + 70, bx0 + 200, by0 + 110);      // window inside door 1
rect(bx0 + 100, by1 + 1, bx1 - 100, gy - 20);         // skid
rect(bx0 + 150, gy - 19, bx0 + 170, gy);              // feet
rect(bx1 - 170, gy - 19, bx1 - 150, gy);
rect(bx0 + 800, by0 - 75, bx0 + 825, by0);            // pipe, 50 mm wide... widened below
hatch(bx0 + 480, gy - 60, bx0 + 560, gy - 52); // small dense patch like printed text on the skid
// end view: body 500 px wide (1000 mm), same ground
const ex0 = 1200, ex1 = ex0 + 499 - 0;
rect(ex0, by0, ex1, by1);
rect(ex0 + 30, by0 + 30, ex1 - 30, by0 + 90); hatch(ex0 + 31, by0 + 31, ex1 - 31, by0 + 89); // grille
rect(ex0 + 20, by1 + 1, ex1 - 20, gy - 20);
// red dimension line across the whole sheet: must not join the views
for (let x = 20; x < 1780; x++) px(x, 510, 230, 0, 0);
for (let y = 5; y < 510; y++) px(1190 + 0, y, 230, 0, 0);
const picture = { data: img, width: W, height: H };

t("splits the sheet into side and end view despite red dimension lines", () => {
  const ink = E.inkFromImage(picture), v = E.splitViews(ink);
  assert.strictEqual(v.length, 2);
});
const r = E.reconstructElevations(picture, { lengthMm: 2000, widthMm: 1000, pipeDiameterMm: 60 });
if (process.env.DUMP) console.log(JSON.stringify(r.parts.map((p) => [p.name, p.kind, Math.round(p.x0), Math.round(p.x1), Math.round(p.z0), Math.round(p.z1)])));
const kinds = (k) => r.parts.filter((p) => p.kind === k);
t("scale comes from the one entered length and the end view agrees", () => { near(r.scaleMmPerPx, 2, 0.05); near(r.checks.widthMm, 1000, 30); });
t("finds both doors and the window as panels", () => { assert.ok(kinds("panel").length >= 3, `panels ${kinds("panel").length}`); });
t("finds the louvre grille in the end view", () => { const g = kinds("grille"); assert.strictEqual(g.length, 1); near(g[0].y1 - g[0].y0, 880, 40); });
t("pipe becomes a pipe part with the entered diameter", () => { const p = kinds("pipe"); assert.strictEqual(p.length, 1); near(p[0].x1 - p[0].x0, 60, 0.5); assert.strictEqual(p[0].depth, "assumed"); });
t("body blocks: skid is narrower than the cabinet and width comes from the end view", () => {
  const b = kinds("body").sort((a, c) => a.z0 - c.z0);
  assert.ok(b.length >= 2); const top = b[b.length - 1]; near(top.x1 - top.x0, 2000, 30); near(top.y1 - top.y0, 1000, 30);
  assert.ok(b[0].x1 - b[0].x0 < top.x1 - top.x0);
});
t("every panel and grille says its thickness and far side are assumed", () => {
  for (const p of [...kinds("panel"), ...kinds("grille")]) { assert.strictEqual(p.thickness, "assumed"); assert.strictEqual(p.depth, "assumed"); assert.strictEqual(p.size, "extracted"); }
});
t("a small dense patch of text-like marks is not taken as a grille", () => {
  const g = kinds("grille"); assert.strictEqual(g.length, 1);
});
t("skins sit inside the overall size: the parts never grow past the body and the pipe", () => {
  const all = E.partsBounds(r.parts), body = E.partsBounds(r.parts.filter((p) => p.kind === "body"));
  near(all.x0, body.x0, 0.01); near(all.x1, body.x1, 0.01); near(all.y0, body.y0, 0.01); near(all.y1, body.y1, 0.01);
});
t("the grille end and the panel face are choices, recorded as assumed placements", () => {
  const a = E.reconstructElevations(picture, { lengthMm: 2000, endFace: "end" }), g = a.parts.find((p) => p.kind === "grille" && p.name.startsWith("End"));
  near(g.x1, 2000, 2); assert.strictEqual(g.placement.face, "far end"); assert.strictEqual(g.placement.provenance, "assumed");
  const b = E.reconstructElevations(picture, { lengthMm: 2000, sideFace: "both" });
  const n = (k) => b.parts.filter((p) => p.name.startsWith("Side panel") && p.placement.face === k).length;
  assert.ok(n("+width") > 0 && n("+width") === n("-width"));
  assert.ok(b.unknowns.some((u) => /opposite|far|not shown/i.test(u)));
});
t("dimensions are labelled entered or checked, never read from the picture", () => {
  const d = Object.fromEntries(r.dimensions.map((x) => [x.name, x.state]));
  assert.deepStrictEqual([d.length, d.width, d.height, d["pipe diameter"]], ["entered", "checked", "checked", "entered"]);
});
t("resolved parts for IFC are metres and keep the pipe as a cylinder", () => {
  const rp = E.toResolvedParts(r.parts); assert.ok(rp.some((x) => x.shape === "cylinder" && Math.abs(x.r - 0.03) < 0.001));
});
t("a stated width that disagrees warns", () => {
  const w = E.reconstructElevations(picture, { lengthMm: 2000, widthMm: 1300 });
  assert.ok(w.warnings.some((m) => /differs from the stated/.test(m)));
});
t("matching entered dimensions raise no mismatch, wrong ones do", () => {
  assert.strictEqual(r.quality.level, "no-mismatch-found");
  const bad = E.reconstructElevations(picture, { lengthMm: 2000, widthMm: 1300 });
  assert.strictEqual(bad.quality.level, "mismatch");
  assert.ok(bad.quality.notes.some((m) => /Width/.test(m)));
});
t("end view drawn at another scale: noted by default, scaled by its own entered height only when asked", () => {
  const h = r.checks.heightEndMm * 1.25;
  const plain = E.reconstructElevations(picture, { lengthMm: 2000, heightMm: h });
  assert.ok(plain.quality.notes.some((m) => /different scale/.test(m)));
  assert.strictEqual(plain.calibration.endScaledByHeight, false);
  near(plain.calibration.endVsSidePct, 25, 1);
  const cal = E.reconstructElevations(picture, { lengthMm: 2000, heightMm: h, calibrateEnd: true });
  assert.strictEqual(cal.calibration.endScaledByHeight, true);
  near(cal.checks.heightEndMm, h, 1);
  near(cal.calibration.endMmPerPx / cal.calibration.sideMmPerPx, 1.25, 0.01);
  assert.ok(!cal.quality.notes.some((m) => /different scale/.test(m)));
});
t("small shapes inside doors are candidates: flagged, unconfirmed, flush inside the body", () => {
  const d = r.parts.filter((q) => q.kind === "detail");
  assert.ok(d.length >= 1, "expected the window drawn inside door 1 as a candidate");
  for (const q of d) { assert.strictEqual(q.candidate, true); assert.ok(/^Possible /.test(q.name)); assert.ok(/guessed from the outline shape/.test(q.note)); }
  const body = E.partsBounds(r.parts.filter((q) => q.kind === "body"));
  for (const q of d) { assert.ok(q.x0 >= body.x0 - 1 && q.x1 <= body.x1 + 1 && q.y0 >= body.y0 - 1 && q.y1 <= body.y1 + 1); }
  assert.ok(r.warnings.some((m) => /guesses from shape/.test(m)));
});
t("views drawn by the person replace the automatic split and give the same parts when drawn around the same views", () => {
  const sw = r.sheet.w, sh = r.sheet.h, pad = 3;
  const si = r.views.reduce((a, v, i) => (v.x1 - v.x0 > r.views[a].x1 - r.views[a].x0 ? i : a), 0), ei = r.views.reduce((a, v, i) => (i !== si && (a < 0 || v.x1 - v.x0 > r.views[a].x1 - r.views[a].x0) ? i : a), -1);
  const fr = (v) => ({ x0: Math.max(0, v.x0 - pad) / sw, x1: Math.min(sw, v.x1 + 1 + pad) / sw, y0: Math.max(0, v.y0 - pad) / sh, y1: Math.min(sh, v.y1 + 1 + pad) / sh });
  const d = E.reconstructElevations(picture, { lengthMm: 2000, sideBox: fr(r.views[si]), endBox: fr(r.views[ei]) });
  assert.ok(d.warnings.some((m) => /boxes drawn by the person/.test(m)));
  near(d.checks.widthMm, r.checks.widthMm, r.checks.widthMm * 0.03);
  near(d.checks.heightEndMm, r.checks.heightEndMm, r.checks.heightEndMm * 0.03);
  assert.strictEqual(d.parts.filter((q) => q.kind === "grille").length, r.parts.filter((q) => q.kind === "grille").length);
  // One box alone is not used: the automatic split stays.
  const one = E.reconstructElevations(picture, { lengthMm: 2000, sideBox: fr(r.views[si]) });
  assert.ok(!one.warnings.some((m) => /boxes drawn by the person/.test(m)));
});
t("a one-view picture is refused", () => {
  const blank = { data: new Uint8ClampedArray(100 * 100 * 4).fill(255), width: 100, height: 100 };
  assert.throws(() => E.reconstructElevations(blank, { lengthMm: 1000 }));
});
console.log(`\n${pass} ok, ${fail} FAIL`); process.exit(fail ? 1 : 0);
