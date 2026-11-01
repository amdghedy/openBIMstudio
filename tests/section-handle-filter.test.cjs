const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "sh-"));
execSync(`npx tsc src/features/section-handle-filter.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const m = require(path.join(out, "section-handle-filter.js"));
let n = 0; const ok = (c, s) => { assert.ok(c, s); n++; };
const mesh = (geo, extra = {}) => ({ visible: true, geometry: { type: geo }, ...extra });
ok(m.isGrabbableHandle(mesh("ConeGeometry")), "arrow is grabbable");
ok(!m.isGrabbableHandle(mesh("PlaneGeometry")), "the plane quad is not a handle");
ok(m.isGrabbableHandle(mesh("CylinderGeometry", { visible: false })), "invisible gizmo pickers stay grabbable");
ok(m.isGrabbableHandle({ visible: true }), "plain object without geometry stays grabbable");
// stuck-drag detection: button no longer down while we think we are dragging
ok(m.isStaleDrag(0, true), "buttons=0 while dragging -> stale");
ok(!m.isStaleDrag(1, true), "left button still down -> live drag");
ok(!m.isStaleDrag(0, false), "not dragging -> nothing to release");
ok(!m.isStaleDrag(undefined, true), "unknown buttons -> do not guess");
console.log(`section-handle-filter: ${n} checks OK`);
