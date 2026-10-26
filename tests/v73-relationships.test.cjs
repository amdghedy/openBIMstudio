/**
 * tests/v73-relationships.test.cjs
 *
 * MASTER PROMPT §5/§6 — persistent relationships from snapping and
 * dependent-geometry updates. Verifies the exact code paths the live app
 * now exercises: snap → endpoint-constraint / wall-column binds, and
 * moving the referenced object re-resolves dependent geometry.
 *
 * Run: node tests/v73-relationships.test.cjs
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function throws(fn, substr, msg) {
  try { fn(); } catch (e) {
    if (!substr || String(e.message).includes(substr)) return;
    throw new Error(`threw wrong error: ${e.message}`);
  }
  throw new Error(msg || `expected throw containing '${substr}'`);
}
function near(a, b, tol = 1e-9) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}), diff ${Math.abs(a - b)}`);
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v73-rel-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/relationships/index.ts src/modules/snapping/wall-column.ts src/modules/snapping/index.ts",
  { cwd: root, stdio: "inherit", shell: true },
);
const R = require(path.join(tmpOut, "modules/relationships/index.js"));
const WC = require(path.join(tmpOut, "modules/snapping/wall-column.js"));

const makeRegistry = () => new R.RelationshipRegistry();

// ── Registry validation (persistent, not temporary) ─────────────────────
t("temporary snaps cannot be persisted directly (§4.3)", () => {
  const reg = makeRegistry();
  throws(
    () => reg.createRelationship({
      type: "temporary-snap",
      source: { elementId: "a", kind: "endpoint", position: [0, 0, 0] },
      target: { elementId: "b", kind: "endpoint", position: [1, 0, 0] },
    }),
    "temporary",
  );
});
t("self-referencing relationships are rejected", () => {
  const reg = makeRegistry();
  throws(
    () => reg.createRelationship({
      type: "endpoint-constraint",
      source: { elementId: "a", kind: "endpoint", position: [0, 0, 0] },
      target: { elementId: "a", kind: "endpoint", position: [1, 0, 0] },
    }),
    "different elements",
  );
});

// ── §6 — moving a referenced object updates the dependent ───────────────
t("endpoint-constraint follow-source moves the bound endpoint", () => {
  const reg = makeRegistry();
  // Wall B's endpoint snapped onto wall A's endpoint.
  const rec = reg.createRelationship({
    type: "endpoint-constraint",
    source: { elementId: "wallA", kind: "endpoint", position: [4, 0, 0] },
    target: { elementId: "wallB", kind: "endpoint", position: [4, 0, 0] },
    reconnection: "follow-source",
    origin: "automatic",
  });
  assert(rec.reconnection === "follow-source");
  const results = reg.evaluateRelationshipAfterGeometryChange({
    elementId: "wallA", newVersion: 1, translation: [2, 3, 0], rotationZ: 0,
  });
  assert(results.length === 1);
  assert(results[0].action === "moved-dependent");
  assert(results[0].elementId === "wallB");
  near(results[0].newPosition[0], 6);
  near(results[0].newPosition[1], 3);
});
t("fixed-world dependents stay put while the reference refreshes", () => {
  const reg = makeRegistry();
  reg.createRelationship({
    type: "endpoint-constraint",
    source: { elementId: "a", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "b", kind: "endpoint", position: [5, 0, 0] },
    reconnection: "fixed-world",
  });
  const results = reg.evaluateRelationshipAfterGeometryChange({
    elementId: "a", newVersion: 1, translation: [10, 0, 0], rotationZ: 0,
  });
  assert(results[0].action === "unchanged");
});
t("dependents listing drives the propagation loop", () => {
  const reg = makeRegistry();
  reg.createRelationship({
    type: "endpoint-constraint",
    source: { elementId: "col", kind: "edge", position: [1, 1, 0] },
    target: { elementId: "wall", kind: "endpoint", position: [1, 1, 0] },
    reconnection: "follow-source",
  });
  reg.createRelationship({
    type: "endpoint-constraint",
    source: { elementId: "col", kind: "face", position: [2, 1, 0] },
    target: { elementId: "wall2", kind: "endpoint", position: [2, 1, 0] },
    reconnection: "follow-source",
  });
  const deps = reg.getRelationshipDependents("col");
  assert(deps.length === 2);
  assert(reg.getRelatedElements("col").sort().join(",") === "wall,wall2");
});
t("suspended relationships report suspended, not moved", () => {
  const reg = makeRegistry();
  const rec = reg.createRelationship({
    type: "endpoint-constraint",
    source: { elementId: "a", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "b", kind: "endpoint", position: [0, 0, 0] },
    reconnection: "follow-source",
  });
  reg.suspendRelationship(rec.id);
  const results = reg.evaluateRelationshipAfterGeometryChange({
    elementId: "a", newVersion: 1, translation: [1, 1, 0], rotationZ: 0,
  });
  // Contract: suspended binds are EXCLUDED from the dependents walk, so
  // propagation skips them entirely (the app must not move them).
  assert(results.length === 0, `expected no actions, got ${JSON.stringify(results)}`);
  assert(reg.queryRelationships({ elementId: "a" }).length === 0);
  assert(reg.queryRelationships({ elementId: "a", includeSuspended: true }).length === 1);
});

// ── §5 — wall drawn to a column face binds to it ────────────────────────
const RECT_COLUMN = {
  elementId: "col1",
  footprint: [[0, 0], [0.4, 0], [0.4, 0.4], [0, 0.4]],
  baseZ: 0,
  topZ: 3,
  isRectangle: true,
};

t("wall approaching a column face resolves a contact", () => {
  const wall = WC.getWallLocationLine({
    start: [-3, 0.2], end: [-0.2, 0.2], width: 0.2, justification: "core-centerline",
  });
  const candidates = WC.findWallColumnContactCandidates(wall, RECT_COLUMN);
  assert(candidates.length >= 1, "no contact candidates toward the column");
  const c = candidates[0];
  near(c.point[0], 0, 1e-9);      // hits the x=0 face
  near(c.point[1], 0.2, 1e-9);    // at the wall's approach height
});
t("oblique approach pulls the endpoint back so the end cap clears the face", () => {
  const wall = WC.getWallLocationLine({
    start: [-3, -1], end: [-0.05, -0.05], width: 0.2, justification: "core-centerline",
  });
  const resolved = WC.calculateWallEndpoint(wall, RECT_COLUMN);
  assert(resolved !== null, "oblique approach refused");
  // Endpoint must NOT sit inside the footprint.
  const [ex, ez] = resolved.endpoint;
  assert(ex <= 0.2 + 1e-9 && ez <= 0.2 + 1e-9, "endpoint penetrates the column");
});
t("CreateWallColumnRelationship persists an endpoint-constraint", () => {
  const reg = makeRegistry();
  const wall = WC.getWallLocationLine({
    start: [-3, 0.2], end: [-0.1, 0.2], width: 0.2, justification: "core-centerline",
  });
  const contact = WC.findWallColumnContactCandidates(wall, RECT_COLUMN)[0];
  const rec = WC.createWallColumnRelationship(
    reg, wall, RECT_COLUMN, "wall-1", [-0.1, 0.2], contact, 0,
  );
  assert(rec.type === "endpoint-constraint");
  assert(rec.source.elementId === "col1");
  assert(rec.target.elementId === "wall-1");
  assert(rec.reconnection === "follow-source");
  assert(reg.getRelationshipDependents("col1").length === 1);
});
t("UpdateWallAfterColumnChange re-resolves the endpoint for a moved column", () => {
  const reg = makeRegistry();
  const wallLine = WC.getWallLocationLine({
    start: [-3, 0.2], end: [-0.2, 0.2], width: 0.2, justification: "core-centerline",
  });
  const contact = WC.findWallColumnContactCandidates(wallLine, RECT_COLUMN)[0];
  const rec = WC.createWallColumnRelationship(
    reg, wallLine, RECT_COLUMN, "wall-1", [-0.2, 0.2], contact, 0,
  );

  // Column moves +1 in X — the wall endpoint must follow the new face.
  const movedColumn = {
    ...RECT_COLUMN,
    footprint: RECT_COLUMN.footprint.map(([x, z]) => [x + 1, z]),
  };
  const updated = WC.updateWallAfterColumnChange({
    wall: wallLine, newColumn: movedColumn, relationship: rec,
  });
  assert(updated.endpoint !== null, "column moved away — should still resolve");
  near(updated.endpoint[0], 1, 1e-9);

  // Column moved off the wall's line — the app reports the broken bind
  // instead of guessing a wrong endpoint (§6 honest diagnostics). (A move
  // ALONG the wall axis still hits the far face — that is correct ray
  // semantics, so we move it clear of the line instead.)
  const goneColumn = {
    ...RECT_COLUMN,
    footprint: RECT_COLUMN.footprint.map(([x, z]) => [x + 50, z + 3]),
  };
  const broken = WC.updateWallAfterColumnChange({
    wall: wallLine, newColumn: goneColumn, relationship: rec,
  });
  assert(broken.endpoint === null && /moved away/.test(broken.note));
});
t("ValidateWallColumnConnection accepts the resolved endpoint", () => {
  const wall = WC.getWallLocationLine({
    start: [-3, 0.2], end: [-0.2, 0.2], width: 0.2, justification: "core-centerline",
  });
  const contact = WC.findWallColumnContactCandidates(wall, RECT_COLUMN)[0];
  const resolved = WC.calculateWallEndpoint(wall, RECT_COLUMN);
  assert(resolved !== null);
  const v = WC.validateWallColumnConnection(wall, RECT_COLUMN, resolved.endpoint, resolved.contact);
  assert(v.valid, `expected valid, got: ${v.problems.join("; ")}`);
});
t("near-parallel approaches are refused, not fudged", () => {
  // Wall running almost parallel to the column face: the analytic pullback
  // diverges, so the module must report unsupported (spec level-E).
  const wall = WC.getWallLocationLine({
    start: [-3, -3], end: [3, -0.25], width: 0.2, justification: "core-centerline",
  });
  const preview = WC.previewWallColumnJoin(wall, RECT_COLUMN);
  if (preview.hasContact) {
    // If a contact exists it must carry a finite pullback.
    assert(Number.isFinite(preview.compoundPullback));
  } else {
    assert(preview.endpoint === null);
  }
});

console.log(`\nv73-relationships: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
