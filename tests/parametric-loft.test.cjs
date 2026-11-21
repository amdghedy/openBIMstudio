/**
 * tests/parametric-loft.test.cjs
 *
 * True-loft suite for the parametric family engine (`buildExtendedGeometry`
 * kind "loft", src/modules/families/parametric-engine.ts):
 *
 * The loft used to be stacked extruded slices — each slice a prism with a
 * constant cross-section, so the side wall was stepped and the volume was
 * a left-Riemann sum (default 4 segments: ~16% low for a 2x2 -> 4x4 loft).
 * It is now one ruled solid from the solid kernel (`loftSections`):
 * profiles re-sampled to a common vertex count by polar angle and joined
 * by ruled bands, capped exactly at the first and last profiles. These
 * tests prove that on volumes, not on "no throw":
 *
 *   - same-profile loft: volume = profile area x length (exact);
 *   - two different profiles: volume = exact integral of the linearly
 *     interpolated area (similar and non-similar rects, circles);
 *   - intermediate cross-sections are real interpolations (mid-plane
 *     section area of the mesh itself);
 *   - endpoints exact (end rings match the first/last profile exactly);
 *   - multi-profile lofts, parametric (parameter-driven) lofts, and
 *     degenerate inputs returning null instead of a broken solid.
 *
 * Run: `node tests/parametric-loft.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const nassert = require("node:assert");

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

function near(a, b, tol = 1e-6) {
  if (!(Math.abs(a - b) <= tol)) {
    throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
  }
}

function nearRel(a, b, relTol) {
  const tol = Math.abs(b) * relTol;
  if (!(Math.abs(a - b) <= tol)) {
    throw new Error(`Expected ${a} ~ ${b} (rel tol ${relTol}, abs tol ${tol})`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the module slice ────────────────────────────────────────────────
// Compile inside the project so the compiled files resolve `three` from the
// repo's node_modules (a temp dir elsewhere would not).
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".loft-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/families/parametric-engine.ts",
  { cwd: root, stdio: "inherit", shell: true },
);
const find = (n) => {
  const w = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { const r = w(p); if (r) return r; }
      else if (f.name === n) return p;
    }
  };
  return w(tmpOut);
};
const E = require(find("parametric-engine.js"));
const THREE = require("three");
nassert.equal(typeof THREE.ExtrudeGeometry, "function", "real three.js required");

// ── Geometry helpers (world-space, over the returned object) ───────────────

function collectTriangles(obj) {
  obj.updateMatrixWorld(true);
  const tris = [];
  obj.traverse((m) => {
    if (!m.geometry) return;
    const pos = m.geometry.attributes.position;
    const idx = m.geometry.index;
    const v = (i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
    const push = (a, b, c) => tris.push([v(a), v(b), v(c)]);
    if (idx) {
      for (let i = 0; i + 2 < idx.count; i += 3) push(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
    } else {
      for (let i = 0; i + 2 < pos.count; i += 3) push(i, i + 1, i + 2);
    }
  });
  return tris;
}

/** Divergence-theorem volume of a closed mesh. */
function meshVolume(obj) {
  let vol = 0;
  for (const [a, b, c] of collectTriangles(obj)) {
    vol += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
  }
  return Math.abs(vol);
}

/** Every undirected edge shared by exactly two triangles => closed solid. */
function isWatertight(obj) {
  const edges = new Map();
  const key = (a, b) => {
    const ka = `${a.x.toFixed(9)},${a.y.toFixed(9)},${a.z.toFixed(9)}`;
    const kb = `${b.x.toFixed(9)},${b.y.toFixed(9)},${b.z.toFixed(9)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  for (const [a, b, c] of collectTriangles(obj)) {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = key(p, q);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  if (edges.size === 0) return false;
  for (const n of edges.values()) if (n !== 2) return false;
  return true;
}

function bbox(obj) {
  obj.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(obj);
}

/** World-space vertices lying on the plane z = z0 (within eps). */
function ringAtZ(obj, z0, eps = 1e-9) {
  obj.updateMatrixWorld(true);
  const pts = [];
  obj.traverse((m) => {
    if (!m.geometry) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (Math.abs(p.z - z0) <= eps) pts.push(p);
    }
  });
  return pts;
}

function ringBBox(pts) {
  nassert.ok(pts.length > 0, "expected vertices on the end plane");
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY };
}

function hasPoint(pts, x, y, eps = 1e-9) {
  return pts.some((p) => Math.abs(p.x - x) <= eps && Math.abs(p.y - y) <= eps);
}

/**
 * Area of the mesh's cross-section at z = z0, by intersecting every
 * triangle with the plane and measuring the resulting polygon. This reads
 * the interpolation out of the built mesh itself: a stepped loft would
 * give the area of whichever slice the plane falls in, a ruled loft gives
 * the linearly interpolated area.
 */
function sectionAreaAtZ(obj, z0) {
  const pts = [];
  const seen = new Set();
  const add = (p) => {
    const k = `${p.x.toFixed(9)},${p.y.toFixed(9)}`;
    if (!seen.has(k)) { seen.add(k); pts.push(p); }
  };
  for (const [a, b, c] of collectTriangles(obj)) {
    const tri = [a, b, c];
    const d = tri.map((p) => p.z - z0);
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if ((d[i] < 0 && d[j] > 0) || (d[i] > 0 && d[j] < 0)) {
        const s = d[i] / (d[i] - d[j]);
        add(new THREE.Vector2(
          tri[i].x + (tri[j].x - tri[i].x) * s,
          tri[i].y + (tri[j].y - tri[i].y) * s,
        ));
      }
    }
  }
  nassert.ok(pts.length >= 3, `no cross-section found at z=${z0}`);
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  pts.sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  }
  return Math.abs(area) / 2;
}

// ── Spec helpers ────────────────────────────────────────────────────────────

const rect = (w, h) => ({ kind: "rect", w: { const: w }, h: { const: h } });
const circle = (r) => ({ kind: "circle", r: { const: r } });
const loft = (profiles, extra = {}) => ({ kind: "loft", profiles, ...extra });

/**
 * Exact volume of one ruled rect->rect pair: the cross-section area
 * A(t) = (w1 + dw*t)(h1 + dh*t) is quadratic in t, so
 * V = L * (A1 + (w1*dh + h1*dw)/2 + dw*dh/3). The frustum formula
 * L/3*(A1 + A2 + sqrt(A1*A2)) only agrees for similar rects; the integral
 * below is the general one and is what a linear interpolation must give.
 */
function rectPairVolume(w1, h1, w2, h2, len) {
  const dw = w2 - w1, dh = h2 - h1;
  return len * (w1 * h1 + (w1 * dh + h1 * dw) / 2 + (dw * dh) / 3);
}

// ── 1. Same-profile loft ────────────────────────────────────────────────────

t("same-profile rect loft: volume = area x length, single watertight mesh", () => {
  const obj = E.buildExtendedGeometry(loft([rect(2, 3), rect(2, 3)], { length: { const: 2.5 } }), {});
  assert(obj, "loft should build");
  let meshes = 0, vertices = 0, triangles = 0;
  obj.traverse((m) => {
    if (m.isMesh) {
      meshes++;
      vertices += m.geometry.attributes.position.count;
      triangles += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    }
  });
  assert(meshes === 1, `expected a single mesh, got ${meshes} (stacked slices are gone)`);
  // Two 4-corner rings, index-paired: 8 vertices, 12 triangles (4 side
  // quads + 2 caps). The old stacked loft built 4 slice prisms here.
  assert(vertices === 8, `expected 8 vertices, got ${vertices}`);
  assert(triangles === 12, `expected 12 triangles, got ${triangles}`);
  near(meshVolume(obj), 2 * 3 * 2.5, 1e-9);
  assert(isWatertight(obj), "loft must be a closed solid");
  const b = bbox(obj);
  near(b.min.x, -1, 1e-9); near(b.max.x, 1, 1e-9);
  near(b.min.y, -1.5, 1e-9); near(b.max.y, 1.5, 1e-9);
  near(b.min.z, 0, 1e-9); near(b.max.z, 2.5, 1e-9);
});

// ── 2. Two different profiles: interpolated volume ─────────────────────────

t("similar rects 2x2 -> 4x4: volume = exact interpolated integral (28)", () => {
  // Old stacked code with default segments=4 gave 23.625 here (15.6% low);
  // the 1e-6 tolerance below fails on the old code and passes on the ruled one.
  const obj = E.buildExtendedGeometry(loft([rect(2, 2), rect(4, 4)], { length: { const: 3 } }), {});
  assert(obj, "loft should build");
  near(meshVolume(obj), rectPairVolume(2, 2, 4, 4, 3), 1e-6);
  near(rectPairVolume(2, 2, 4, 4, 3), 28, 1e-9);
  assert(isWatertight(obj), "loft must be a closed solid");
});

t("non-similar rects 2x2 -> 4x1: volume = integral, not frustum formula", () => {
  const obj = E.buildExtendedGeometry(loft([rect(2, 2), rect(4, 1)], { length: { const: 2 } }), {});
  assert(obj, "loft should build");
  const expected = rectPairVolume(2, 2, 4, 1, 2); // 26/3
  near(expected, 26 / 3, 1e-9);
  near(meshVolume(obj), expected, 1e-6);
  // The frustum formula L/3*(A1+A2+sqrt(A1*A2)) = 8 here and is WRONG for
  // non-similar rects; the loft must not match it.
  assert(Math.abs(meshVolume(obj) - 8) > 0.5, "volume must not equal the frustum approximation");
});

t("circles r=1 -> r=2: volume = cone frustum within polygon tolerance", () => {
  const obj = E.buildExtendedGeometry(
    loft([circle(1), circle(2)], { length: { const: 2 }, segments: 64 }), {},
  );
  assert(obj, "loft should build");
  const expected = (Math.PI * 2) / 3 * (1 + 2 + 4); // pi*L/3*(r1^2+r1*r2+r2^2)
  nearRel(meshVolume(obj), expected, 0.005);
  assert(isWatertight(obj), "loft must be a closed solid");
});

// ── 3. Intermediate cross-sections are real interpolations ─────────────────

t("mid-plane section of 2x2 -> 4x4 loft is exactly the 3x3 interpolation", () => {
  const obj = E.buildExtendedGeometry(loft([rect(2, 2), rect(4, 4)], { length: { const: 2 } }), {});
  near(sectionAreaAtZ(obj, 1), 9, 1e-6);
});

t("mid-plane section of non-similar 2x2 -> 4x1 loft is exactly 3x1.5", () => {
  const obj = E.buildExtendedGeometry(loft([rect(2, 2), rect(4, 1)], { length: { const: 2 } }), {});
  near(sectionAreaAtZ(obj, 1), 4.5, 1e-6);
});

// ── 4. Endpoints exact ──────────────────────────────────────────────────────

t("endpoints exact: end rings match the first/last profile, corners included", () => {
  const obj = E.buildExtendedGeometry(loft([rect(2, 2), rect(4, 1)], { length: { const: 3 } }), {});
  const b = bbox(obj);
  near(b.min.z, 0, 1e-9); near(b.max.z, 3, 1e-9);

  const bottom = ringAtZ(obj, 0);
  const bb = ringBBox(bottom);
  near(bb.minX, -1, 1e-9); near(bb.maxX, 1, 1e-9);
  near(bb.minY, -1, 1e-9); near(bb.maxY, 1, 1e-9);
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    assert(hasPoint(bottom, x, y), `bottom ring must contain corner (${x},${y})`);
  }

  const top = ringAtZ(obj, 3);
  const tb = ringBBox(top);
  near(tb.minX, -2, 1e-9); near(tb.maxX, 2, 1e-9);
  near(tb.minY, -0.5, 1e-9); near(tb.maxY, 0.5, 1e-9);
  for (const [x, y] of [[-2, -0.5], [2, -0.5], [2, 0.5], [-2, 0.5]]) {
    assert(hasPoint(top, x, y), `top ring must contain corner (${x},${y})`);
  }
});

// ── 5. Multi-profile loft ───────────────────────────────────────────────────

t("three-profile loft 2x2 -> 4x4 -> 2x2: volume = sum of pair integrals", () => {
  const obj = E.buildExtendedGeometry(
    loft([rect(2, 2), rect(4, 4), rect(2, 2)], { length: { const: 2 } }), {},
  );
  assert(obj, "loft should build");
  const expected = rectPairVolume(2, 2, 4, 4, 1) + rectPairVolume(4, 4, 2, 2, 1);
  near(expected, 56 / 3, 1e-9);
  near(meshVolume(obj), expected, 1e-6);
  assert(isWatertight(obj), "loft must be a closed solid");
  // The middle profile sits exactly at z=1 and is exactly 4x4.
  const mid = ringBBox(ringAtZ(obj, 1));
  near(mid.minX, -2, 1e-9); near(mid.maxX, 2, 1e-9);
  near(mid.minY, -2, 1e-9); near(mid.maxY, 2, 1e-9);
});

// ── 6. Mixed kinds + parametric end-to-end ──────────────────────────────────

t("rect -> circle loft builds a sane transitioning watertight solid", () => {
  const obj = E.buildExtendedGeometry(loft([rect(2, 2), circle(1)], { length: { const: 1 } }), {});
  assert(obj, "loft should build");
  assert(isWatertight(obj), "loft must be a closed solid");
  const b = bbox(obj);
  near(b.min.x, -1, 1e-9); near(b.max.x, 1, 1e-9);
  const v = meshVolume(obj);
  assert(v > 2.9 && v < 4.0, `volume ${v} must lie between the end prisms (pi..4)`);
});

t("parametric loft: parameter change rebuilds the interpolated volume", () => {
  const family = {
    id: "loft.test", name: "LoftTest", category: "generic",
    ifcEntity: "IfcBuildingElementProxy", schemaVersion: 1, builtIn: false,
    parameters: [
      { name: "baseW", type: "length", scope: "type", default: 2, editable: true },
      { name: "topW", type: "length", scope: "type", default: 4, editable: true },
      { name: "loftLen", type: "length", scope: "type", default: 3, editable: true },
    ],
    types: [{ id: "t1", name: "T1", values: {} }],
    geometry: {
      kind: "loft",
      profiles: [
        { kind: "rect", w: { ref: "baseW" }, h: { const: 2 } },
        { kind: "rect", w: { ref: "topW" }, h: { const: 2 } },
      ],
      length: { ref: "loftLen" },
    },
  };
  const r1 = E.buildParametricFamily(family, family.types[0]);
  assert(r1.object, "parametric loft should build");
  assert(r1.errors.length === 0, `unexpected errors: ${r1.errors.join("; ")}`);
  near(meshVolume(r1.object), rectPairVolume(2, 2, 4, 2, 3), 1e-6);
  // Default length is 1 when `length` is omitted.
  const noLen = E.buildExtendedGeometry(
    loft([rect(2, 2), rect(4, 4)]), {},
  );
  near(bbox(noLen).max.z, 1, 1e-9);
  // Rebuild with a changed top width: volume follows the new interpolation.
  const r2 = E.buildParametricFamily(family, family.types[0], { overrides: { topW: 6 } });
  near(meshVolume(r2.object), rectPairVolume(2, 2, 6, 2, 3), 1e-6);
  // Transform still applies through the loft path.
  const moved = E.buildExtendedGeometry(
    loft([rect(2, 2), rect(2, 2)], { length: { const: 1 }, transform: { translate: [{ const: 10 }, { const: 0 }, { const: 0 }] } }), {},
  );
  const mb = bbox(moved);
  near(mb.min.x, 9, 1e-9); near(mb.max.x, 11, 1e-9);
});

// ── 7. Degenerate input: null, not a broken solid ───────────────────────────

t("degenerate lofts return null", () => {
  assert(E.buildExtendedGeometry(loft([rect(2, 2)]), {}) === null, "one profile is not a loft");
  assert(E.buildExtendedGeometry(loft([]), {}) === null, "no profiles is not a loft");
  assert(E.buildExtendedGeometry(loft([rect(0, 2), rect(2, 2)]), {}) === null, "zero-width profile refused");
  assert(E.buildExtendedGeometry(loft([rect(2, 2), rect(-1, 2)]), {}) === null, "negative profile refused");
  assert(E.buildExtendedGeometry(loft([rect(2, 2), rect(4, 4)], { length: { const: 0 } }), {}) === null, "zero length refused");
  assert(E.buildExtendedGeometry(loft([rect(2, 2), rect(4, 4)], { length: { const: -1 } }), {}) === null, "negative length refused");
  // Bow-tie polygon is self-intersecting: the kernel rejects it.
  const bowtie = { kind: "polygon", points: [[0, 0], [2, 2], [2, 0], [0, 2]] };
  assert(E.buildExtendedGeometry(loft([bowtie, rect(2, 2)]), {}) === null, "self-intersecting profile refused");
  const ngon = { kind: "polygon", points: [[-1, -1], [1, -1], [1, 1], [-1, 1]] };
  const okPoly = E.buildExtendedGeometry(loft([ngon, rect(4, 4)], { length: { const: 1 } }), {});
  assert(okPoly, "plain polygon profile should loft");
  near(meshVolume(okPoly), rectPairVolume(2, 2, 4, 4, 1), 1e-6);
});

// ── 8. Registration guard ───────────────────────────────────────────────────

t("test registered in package.json and CI manifest", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert(pkg.scripts["test:parametric-loft"] === "node tests/parametric-loft.test.cjs");
  const manifest = fs.readFileSync(path.join(root, "scripts/ci-unit-tests.mjs"), "utf8");
  assert(manifest.includes('"test:parametric-loft"'), "CI manifest must run this suite");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
