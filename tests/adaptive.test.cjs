/**
 * tests/adaptive.test.cjs
 *
 * Unit tests for the adaptive components engine
 * (src/modules/adaptive). Sweep volumes are verified against
 * profileArea × sweepLength closed forms via the divergence-theorem
 * mesh volume.
 *
 * Run: `node tests/adaptive.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
    fail++;
  }
}

function near(a, b, tol = 1e-4) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}), got ${a}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-adaptive-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/adaptive/index.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const ad = require(path.join(tmpOut, "modules/adaptive/index.js"));

const P = (x, y, z) => ({ x, y, z });
const rect = (w, h) => [
  { u: -w / 2, v: -h / 2 }, { u: w / 2, v: -h / 2 }, { u: w / 2, v: h / 2 }, { u: -w / 2, v: h / 2 },
];

// ── 1. divideLine ───────────────────────────────────────────────────────────
t("divideLine: 5 bays over 10 m gives 6 points at 2.5 m", () => {
  const pts = ad.divideLine(P(0, 0, 0), P(10, 0, 0), 5);
  near(pts.length, 6, 0);
  near(pts[2].x, 4, 1e-9);
  near(pts[4].x, 8, 1e-9);
  near(pts[5].x, 10, 1e-9);
  near(ad.pathLength(pts), 10, 1e-9);
});

// ── 2. divideArc equal chords ───────────────────────────────────────────────
t("divideArc: equal arc-length spacing", () => {
  const pts = ad.divideArc(P(0, 0, 0), 5, 0, Math.PI / 2, 4);
  near(pts.length, 5, 0);
  // Chords between consecutive points must be equal.
  const chords = [];
  for (let i = 1; i < pts.length; i++) {
    chords.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  for (let i = 1; i < chords.length; i++) near(chords[i], chords[0], 1e-9);
});

// ── 3. profileArea (shoelace) ───────────────────────────────────────────────
t("profileArea: rectangle and CW orientation sign", () => {
  near(ad.profileArea(rect(0.2, 0.4)), 0.08, 1e-12);
  near(ad.profileArea([{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }]), 0.5, 1e-12);
  const cw = rect(0.2, 0.4).reverse();
  near(ad.profileArea(cw), -0.08, 1e-12);
});

// ── 4. Two-point instance: prism along +x ───────────────────────────────────
t("2-point instance: closed prism, exact volume, correct bounds", () => {
  ad.registerFamily({ id: "fin", name: "Façade fin", pointCount: 2, profile: rect(0.05, 0.3) });
  const mesh = ad.instantiate("fin", [P(0, 0, 0), P(4, 0, 0)]);
  // 2 rings × 4 profile points
  near(mesh.vertices.length, 8, 0);
  // 2 cap triangles ×2 + 4 side quads ×2
  near(mesh.faces.length, 12, 0);
  const vol = ad.meshVolume(mesh);
  near(vol, 0.05 * 0.3 * 4, 1e-9);
  assert(vol > 0, "winding should be outward-positive");
  // Bounds: u spans ±0.025 in y (N ⊥ x, ref z → N = z×x = y?), v spans ±0.15 in z.
  const ys = mesh.vertices.map((v) => v.y);
  const zs = mesh.vertices.map((v) => v.z);
  near(Math.min(...ys), -0.025, 1e-9);
  near(Math.max(...ys), 0.025, 1e-9);
  near(Math.min(...zs), -0.15, 1e-9);
  near(Math.max(...zs), 0.15, 1e-9);
});

// ── 5. Three-point instance: volume = area × total length ───────────────────
t("3-point instance: volume equals area × polyline length", () => {
  ad.registerFamily({ id: "rafter", name: "Rafter", pointCount: 3, profile: rect(0.1, 0.2) });
  const mesh = ad.instantiate("rafter", [P(0, 0, 0), P(3, 0, 0), P(3, 0, 2)]);
  const expected = 0.1 * 0.2 * (3 + 2);
  near(ad.meshVolume(mesh), expected, 1e-9);
  near(mesh.vertices.length, 16, 0);
});

// ── 6. Vertical segment fallback frame ──────────────────────────────────────
t("vertical segment: no NaN, exact volume", () => {
  const mesh = ad.instantiate("rafter", [P(0, 0, 0), P(0, 0, 4), P(3, 0, 4)]);
  const vol = ad.meshVolume(mesh);
  near(vol, 0.1 * 0.2 * (4 + 3), 1e-9);
  for (const v of mesh.vertices) {
    assert(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z), "NaN in vertices");
  }
});

// ── 7. Mesh validity: indices in range ──────────────────────────────────────
t("mesh indices are in range", () => {
  const mesh = ad.instantiate("rafter", [P(0, 0, 0), P(2, 1, 0), P(4, 0, 1)]);
  for (const [a, b, c] of mesh.faces) {
    assert(a >= 0 && a < mesh.vertices.length, `index ${a} OOB`);
    assert(b >= 0 && b < mesh.vertices.length, `index ${b} OOB`);
    assert(c >= 0 && c < mesh.vertices.length, `index ${c} OOB`);
  }
});

// ── 8. repeatAlongPath sliding window ───────────────────────────────────────
t("repeatAlongPath: sliding window produces path−points+1 instances", () => {
  const path = ad.divideLine(P(0, 0, 0), P(12, 0, 0), 6); // 7 points
  const inst = ad.repeatAlongPath("rafter", path);
  near(inst.length, 7 - 3 + 1, 0);
  near(inst[0].points[0].x, 0, 1e-9);
  near(inst[1].points[0].x, 2, 1e-9);
  const inst2 = ad.repeatAlongPath("fin", path); // 2-point family
  near(inst2.length, 6, 0);
});

// ── 9. Validation errors ────────────────────────────────────────────────────
t("validation: point count, profile, unknown family", () => {
  let threw = false;
  try { ad.registerFamily({ id: "bad", name: "bad", pointCount: 5, profile: rect(1, 1) }); } catch { threw = true; }
  assert(threw, "pointCount 5 should throw");
  threw = false;
  try { ad.instantiate("nope", [P(0, 0, 0), P(1, 0, 0)]); } catch { threw = true; }
  assert(threw, "unknown family should throw");
  threw = false;
  try { ad.instantiate("fin", [P(0, 0, 0)]); } catch { threw = true; }
  assert(threw, "wrong point count should throw");
});

// ── 10. Curved path: chord vs arc sanity ────────────────────────────────────
t("arc-path repeat: chordal volume under exact arc volume", () => {
  // 4-point family along an arc; chord polyline is shorter than the arc,
  // so swept chord volume must be slightly below area × arc length.
  ad.registerFamily({ id: "arc", name: "Arc", pointCount: 4, profile: rect(0.1, 0.1) });
  const pts = ad.divideArc(P(0, 0, 0), 10, 0, Math.PI / 2, 3); // 4 points
  const mesh = ad.instantiate("arc", pts);
  const chordVol = Math.abs(ad.meshVolume(mesh));
  const arcLen = 10 * Math.PI / 2;
  const chordLen = ad.pathLength(pts);
  assert(chordVol <= 0.01 * arcLen + 1e-9, "chord volume must not exceed area×arc");
  near(chordVol, 0.01 * chordLen, 1e-6);
  assert(chordLen < arcLen, "chord shorter than arc");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
