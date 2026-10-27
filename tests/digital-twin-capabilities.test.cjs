const assert = require("assert");

// Mirror classification rules (keep in sync with capabilities.ts)
const LINEAR = new Set(["wall","beam","brace","truss","strip","mline","duct","pipe","cable-tray","conduit"]);
const VERTICAL = new Set(["column","footing","equipment","fitting"]);
const SLAB = new Set(["slab","roof","ceiling","terrain","room","area"]);

function elementTypeFromIfcEntity(entity) {
  const e = String(entity || "").toLowerCase();
  if (e.includes("curtain")) return "curtain-wall";
  if (e.includes("wall")) return "wall";
  if (e.includes("ductfitting") || (e.includes("duct") && e.includes("fitting"))) return "fitting";
  if (e.includes("duct")) return "duct";
  if (e.includes("pipefitting") || (e.includes("pipe") && e.includes("fitting"))) return "fitting";
  if (e.includes("pipe")) return "pipe";
  if (e.includes("cabletray") || (e.includes("cable") && e.includes("tray"))) return "cable-tray";
  if (e.includes("conduit")) return "conduit";
  if (e.includes("column")) return "column";
  if (e.includes("beam")) return "beam";
  if (e.includes("slab")) return "slab";
  if (e.includes("lightfixture") || e.includes("equipment")) return "equipment";
  return "generic";
}

function shouldPreferParametricSolid(type, editMode, hasLinear, hasPoint, hasPolygon, force = false) {
  if (force) return true;
  if (editMode === "force-parametric-linear" && hasLinear) return true;
  if (editMode === "force-parametric-vertical" && hasPoint) return true;
  if (editMode === "force-parametric-slab" && hasPolygon) return true;
  return false;
}

assert.strictEqual(elementTypeFromIfcEntity("IfcWallStandardCase"), "wall");
assert.strictEqual(elementTypeFromIfcEntity("IfcDuctSegment"), "duct");
assert.strictEqual(elementTypeFromIfcEntity("IfcPipeFitting"), "fitting");
assert.strictEqual(elementTypeFromIfcEntity("IfcCableTraySegment"), "cable-tray");
assert.strictEqual(elementTypeFromIfcEntity("IfcLightFixture"), "equipment");

assert.strictEqual(shouldPreferParametricSolid("wall", "parametric-linear", true, false, false), false);
assert.strictEqual(shouldPreferParametricSolid("column", "parametric-vertical", false, true, false), false);
assert.strictEqual(shouldPreferParametricSolid("slab", "parametric-slab", false, false, true), false);
assert.strictEqual(shouldPreferParametricSolid("wall", "boundary-mesh", false, false, false), false);
assert.strictEqual(shouldPreferParametricSolid("duct", "force-parametric-linear", true, false, false), true);
assert.strictEqual(shouldPreferParametricSolid("wall", "boundary-mesh", true, false, false, true), true);

console.log("digital-twin-capabilities.test.cjs: ok");
