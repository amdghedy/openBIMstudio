
const assert = require("assert");

function shouldPreferParametricSolid(editMode, force = false) {
  if (force) return true;
  if (editMode === "force-parametric-linear") return true;
  if (editMode === "parametric-linear") return false; // no longer auto
  return false;
}

// Converted wall with baseline must NOT prefer parametric solid
assert.strictEqual(shouldPreferParametricSolid("parametric-linear", false), false);
assert.strictEqual(shouldPreferParametricSolid("boundary-mesh", false), false);
assert.strictEqual(shouldPreferParametricSolid("force-parametric-linear", false), true);
assert.strictEqual(shouldPreferParametricSolid("boundary-mesh", true), true);

console.log("native-twin-preserve-geometry.test.cjs: ok");
