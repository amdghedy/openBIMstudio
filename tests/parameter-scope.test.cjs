/**
 * tests/parameter-scope.test.cjs
 *
 * Follow-up 3 — parameter scope is enforced in resolution.
 *
 *   - A type value must no longer silently set an instance-scope
 *     parameter: it is ignored and recorded as a warning (ignore +
 *     warn, not reject — see src/modules/families/parameter-scope.ts
 *     for the rationale). Same for a type value naming a parameter the
 *     family does not declare at all.
 *   - The builtin migration (wall thickness, column thickness/depth,
 *     beam thickness/height, slab thickness: instance -> type scope) and
 *     the seed catalog migration (elevation -> type scope where a type
 *     sets it) must not change any resolved value — except where the
 *     data itself was corrected upstream (see the GOLDENS note below):
 *     the GOLDENS table is the pre-migration resolution of every
 *     builtin family x type, captured on main e8e5afb before the
 *     migration, and every declared parameter must still resolve to it.
 *   - Type-scope parameters still receive type values; instance-scope
 *     parameters still accept instance overrides.
 *
 * The base service (registry.ts) cannot be compiled in isolation — it
 * pulls in the whole app through the project store — so its enforcement
 * is covered by testing the shared helper it calls (applyTypeValues)
 * plus a source-level drift guard that both resolution paths route
 * type values through that helper.
 *
 * Run: `node tests/parameter-scope.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
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

function near(a, b, tol = 1e-9) {
  if (typeof a !== "number" || typeof b !== "number" || !(Math.abs(a - b) <= tol)) {
    throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertValuesEqual(actual, expected, where) {
  for (const [k, v] of Object.entries(expected)) {
    assert(k in actual, `${where}: missing resolved parameter "${k}"`);
    if (typeof v === "number") near(actual[k], v, 1e-9);
    else nassert.deepStrictEqual(actual[k], v, `${where}: "${k}"`);
  }
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-paramscope-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.env.NODE_PATH = path.join(root, "node_modules");
Module._initPaths();
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/families/parametric-engine.ts src/modules/families/builtin-families.ts" +
  " src/modules/families/parameter-scope.ts src/modules/families/sample-parametric-door.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const { resolveParametricValues, buildParametricFamily, applyTypeValues } =
  require(path.join(tmpOut, "modules/families/parametric-engine.js"));
const { createBuiltInFamilies } =
  require(path.join(tmpOut, "modules/families/builtin-families.js"));
const { createParametricDoorFamily } =
  require(path.join(tmpOut, "modules/families/sample-parametric-door.js"));

// ── Pre-migration goldens (main e8e5afb, declared parameters only) ──────────
// Captured with resolveParametricValues on pristine main before the
// migration. Any change here means the migration changed resolution.
// Two entries were re-captured at the 2026-11-22 landing rebase, because
// the data they encode was corrected upstream after e8e5afb — the change
// is the correction, not the migration:
//   - "Round Pipe": slice 2 fixed the pipe formulas (they referenced an
//     undefined `diameter`; they now reference `thickness`), so
//     circumference/crossSectionArea evaluate instead of failing.
//   - "Basic Floor": main 01c4318 renamed the slab type values from the
//     undeclared `thickness` to the declared `height`, and this wave
//     migrated that parameter to type scope (every slab type sets it),
//     so height now follows the type instead of staying at the 0.2 default.
const GOLDENS = {
  "Basic Wall": {
    "types": {
      "Generic 100 mm": {
        "values": {
          "height": 3,
          "thickness": 0.1,
          "elevation": 0,
          "areaPerMeter": 0.30000000000000004,
          "slenderness": 30
        },
        "formulaErrors": [],
        "errors": []
      },
      "Generic 200 mm": {
        "values": {
          "height": 3,
          "thickness": 0.2,
          "elevation": 0,
          "areaPerMeter": 0.6000000000000001,
          "slenderness": 15
        },
        "formulaErrors": [],
        "errors": []
      },
      "Generic 300 mm": {
        "values": {
          "height": 3,
          "thickness": 0.3,
          "elevation": 0,
          "areaPerMeter": 0.8999999999999999,
          "slenderness": 10
        },
        "formulaErrors": [],
        "errors": []
      }
    },
    "noType": {
      "values": {
        "height": 3,
        "thickness": 0.2,
        "elevation": 0,
        "areaPerMeter": 0.6000000000000001,
        "slenderness": 15
      },
      "formulaErrors": []
    }
  },
  "Basic Floor": {
    "types": {
      "Concrete 150 mm": {
        "values": {
          "height": 0.15,
          "elevation": 0
        },
        "formulaErrors": [],
        "errors": []
      },
      "Concrete 200 mm": {
        "values": {
          "height": 0.2,
          "elevation": 0
        },
        "formulaErrors": [],
        "errors": []
      },
      "Concrete 250 mm": {
        "values": {
          "height": 0.25,
          "elevation": 0
        },
        "formulaErrors": [],
        "errors": []
      }
    },
    "noType": {
      "values": {
        "height": 0.2,
        "elevation": 0
      },
      "formulaErrors": []
    }
  },
  "Basic Column": {
    "types": {
      "300 x 300": {
        "values": {
          "height": 3,
          "thickness": 0.3,
          "depth": 0.3,
          "elevation": 0,
          "concreteVolume": 0.27,
          "slenderness": 10
        },
        "formulaErrors": [],
        "errors": []
      },
      "400 x 400": {
        "values": {
          "height": 3,
          "thickness": 0.4,
          "depth": 0.4,
          "elevation": 0,
          "concreteVolume": 0.4800000000000001,
          "slenderness": 7.5
        },
        "formulaErrors": [],
        "errors": []
      }
    },
    "noType": {
      "values": {
        "height": 3,
        "thickness": 0.3,
        "depth": 0.3,
        "elevation": 0,
        "concreteVolume": 0.27,
        "slenderness": 10
      },
      "formulaErrors": []
    }
  },
  "Basic Beam": {
    "types": {
      "300 x 500": {
        "values": {
          "height": 0.5,
          "thickness": 0.3,
          "elevation": 0,
          "sectionArea": 0.15,
          "sectionInertia": 0.0031249999999999997
        },
        "formulaErrors": [],
        "errors": []
      },
      "250 x 500": {
        "values": {
          "height": 0.5,
          "thickness": 0.25,
          "elevation": 0,
          "sectionArea": 0.125,
          "sectionInertia": 0.0026041666666666665
        },
        "formulaErrors": [],
        "errors": []
      }
    },
    "noType": {
      "values": {
        "height": 0.5,
        "thickness": 0.25,
        "elevation": 0,
        "sectionArea": 0.125,
        "sectionInertia": 0.0026041666666666665
      },
      "formulaErrors": []
    }
  },
  "Basic Door": {
    "types": {
      "Single 900 x 2100": {
        "values": {
          "width": 0.9,
          "height": 2.1,
          "frameThickness": 0.06,
          "sillHeight": 0,
          "offsetAlongHost": 0
        },
        "formulaErrors": [],
        "errors": []
      },
      "Single 1000 x 2100": {
        "values": {
          "width": 1,
          "height": 2.1,
          "frameThickness": 0.06,
          "sillHeight": 0,
          "offsetAlongHost": 0
        },
        "formulaErrors": [],
        "errors": []
      },
      "Double 1800 x 2100": {
        "values": {
          "width": 1.8,
          "height": 2.1,
          "frameThickness": 0.06,
          "sillHeight": 0,
          "offsetAlongHost": 0
        },
        "formulaErrors": [],
        "errors": []
      }
    },
    "noType": {
      "values": {
        "width": 0.9,
        "height": 2.1,
        "frameThickness": 0.06,
        "sillHeight": 0,
        "offsetAlongHost": 0
      },
      "formulaErrors": []
    }
  },
  "Basic Window": {
    "types": {
      "1200 x 1400": {
        "values": {
          "width": 1.2,
          "height": 1.4,
          "frameThickness": 0.05,
          "sillHeight": 0.9,
          "offsetAlongHost": 0
        },
        "formulaErrors": [],
        "errors": []
      },
      "1500 x 1500": {
        "values": {
          "width": 1.5,
          "height": 1.5,
          "frameThickness": 0.05,
          "sillHeight": 0.9,
          "offsetAlongHost": 0
        },
        "formulaErrors": [],
        "errors": []
      }
    },
    "noType": {
      "values": {
        "width": 1.2,
        "height": 1.4,
        "frameThickness": 0.05,
        "sillHeight": 0.9,
        "offsetAlongHost": 0
      },
      "formulaErrors": []
    }
  },
  "Rectangular Duct": {
    "types": {
      "600 x 400": {
        "values": {
          "thickness": 0.6,
          "height": 0.4,
          "elevation": 0
        },
        "formulaErrors": [],
        "errors": []
      },
      "400 x 300": {
        "values": {
          "thickness": 0.4,
          "height": 0.3,
          "elevation": 0
        },
        "formulaErrors": [],
        "errors": []
      }
    },
    "noType": {
      "values": {
        "thickness": 0.6,
        "height": 0.4,
        "elevation": 0
      },
      "formulaErrors": []
    }
  },
  "Round Pipe": {
    "types": {
      "DN 50": {
        "values": {
          "thickness": 0.05,
          "elevation": 0,
          "circumference": 0.15707963267948966,
          "crossSectionArea": 0.001963495408493621
        },
        "formulaErrors": [],
        "errors": []
      },
      "DN 100": {
        "values": {
          "thickness": 0.1,
          "elevation": 0,
          "circumference": 0.3141592653589793,
          "crossSectionArea": 0.007853981633974483
        },
        "formulaErrors": [],
        "errors": []
      },
      "DN 150": {
        "values": {
          "thickness": 0.15,
          "elevation": 0,
          "circumference": 0.47123889803846897,
          "crossSectionArea": 0.017671458676442587
        },
        "formulaErrors": [],
        "errors": []
      }
    },
    "noType": {
      "values": {
        "thickness": 0.1,
        "elevation": 0,
        "circumference": 0.3141592653589793,
        "crossSectionArea": 0.007853981633974483
      },
      "formulaErrors": []
    }
  },
  "Cable Tray": {
    "types": {
      "300 mm": {
        "values": {
          "thickness": 0.3,
          "height": 0.1,
          "elevation": 0
        },
        "formulaErrors": [],
        "errors": []
      },
      "450 mm": {
        "values": {
          "thickness": 0.45,
          "height": 0.1,
          "elevation": 0
        },
        "formulaErrors": [],
        "errors": []
      }
    },
    "noType": {
      "values": {
        "thickness": 0.3,
        "height": 0.1,
        "elevation": 0
      },
      "formulaErrors": []
    }
  },
  "Conduit": {
    "types": {
      "20 mm": {
        "values": {
          "thickness": 0.02,
          "elevation": 0
        },
        "formulaErrors": [],
        "errors": []
      },
      "25 mm": {
        "values": {
          "thickness": 0.025,
          "elevation": 0
        },
        "formulaErrors": [],
        "errors": []
      }
    },
    "noType": {
      "values": {
        "thickness": 0.025,
        "elevation": 0
      },
      "formulaErrors": []
    }
  },
  "Generic Equipment": {
    "types": {
      "Generic 800 x 800 x 1200": {
        "values": {
          "thickness": 0.8,
          "depth": 0.8,
          "height": 1.2,
          "elevation": 0
        },
        "formulaErrors": [],
        "errors": []
      }
    },
    "noType": {
      "values": {
        "thickness": 0.8,
        "depth": 0.8,
        "height": 1.2,
        "elevation": 0
      },
      "formulaErrors": []
    }
  }
};

// ── Synthetic family for enforcement tests ──────────────────────────────────
function syntheticFamily() {
  return {
    id: "test-scope",
    name: "Scope Test",
    category: "generic",
    ifcEntity: "IfcBuildingElementProxy",
    schemaVersion: 1,
    builtIn: false,
    parameters: [
      { name: "width", type: "length", scope: "type", default: 1.0, editable: true },
      { name: "depth", type: "length", scope: "instance", default: 0.5, editable: true },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true },
      { name: "area", type: "area", scope: "instance", default: 0, editable: false, formula: "= width * depth" },
    ],
    geometry: {
      kind: "box",
      w: { ref: "width" },
      d: { ref: "depth" },
      h: { const: 1 },
      transform: { translate: [{ const: 0 }, { ref: "elevation" }, { const: 0 }] },
    },
    types: [
      {
        id: "t-bad",
        name: "Bad Type",
        values: { width: 2.0, depth: 0.9, elevation: 1.5, ghost: 7 },
      },
      { id: "t-good", name: "Good Type", values: { width: 1.5 } },
    ],
  };
}

// ── A. Enforcement ──────────────────────────────────────────────────────────
t("A1 type value on an instance-scope parameter is ignored, value stays at default, warning names it", () => {
  const fam = syntheticFamily();
  const bad = fam.types[0];
  const { values, warnings } = resolveParametricValues(fam, bad, {});
  near(values.depth, 0.5);
  near(values.elevation, 0.0);
  assert(warnings.some((w) => w.includes('"depth"') && w.includes("instance-scope")), "warning names depth: " + warnings.join(" | "));
  assert(warnings.some((w) => w.includes('"elevation"') && w.includes("instance-scope")), "warning names elevation: " + warnings.join(" | "));
});

t("A2 type value on an undeclared parameter is ignored and warned, key absent from resolved map", () => {
  const fam = syntheticFamily();
  const { values, warnings } = resolveParametricValues(fam, fam.types[0], {});
  assert(!("ghost" in values), "undeclared 'ghost' must not leak into resolved values");
  assert(warnings.some((w) => w.includes('"ghost"') && w.includes("undeclared")), "warning names ghost: " + warnings.join(" | "));
});

t("A3 type value on a type-scope parameter still applies", () => {
  const fam = syntheticFamily();
  const { values, warnings } = resolveParametricValues(fam, fam.types[0], {});
  near(values.width, 2.0);
  assert(!warnings.some((w) => w.includes('"width"')), "no warning for a legal type value: " + warnings.join(" | "));
});

t("A4 instance override on an instance-scope parameter still applies (overrides are not blocked)", () => {
  const fam = syntheticFamily();
  const { values } = resolveParametricValues(fam, fam.types[1], { overrides: { depth: 0.9, elevation: 1.5 } });
  near(values.depth, 0.9);
  near(values.elevation, 1.5);
});

t("A5 instance override on a type-scope parameter still wins over the type value", () => {
  const fam = syntheticFamily();
  const { values } = resolveParametricValues(fam, fam.types[1], { overrides: { width: 3.0 } });
  near(values.width, 3.0);
});

t("A6 a clean type resolves with no scope warnings", () => {
  const fam = syntheticFamily();
  const { warnings } = resolveParametricValues(fam, fam.types[1], {});
  nassert.deepStrictEqual(warnings, []);
});

t("A7 buildParametricFamily surfaces scope warnings and builds with the default, not the type, value", () => {
  const fam = syntheticFamily();
  const result = buildParametricFamily(fam, fam.types[0], {});
  assert(result.object !== null, "geometry still builds");
  near(result.params.depth, 0.5);
  near(result.params.elevation, 0.0);
  assert(result.warnings.length >= 3, "warnings surface on the build result: " + result.warnings.join(" | "));
  assert(result.warnings.some((w) => w.includes('"depth"')), "build warnings name depth");
});

t("A8 formulas see the enforced value, not the ignored type value", () => {
  const fam = syntheticFamily();
  const { values } = resolveParametricValues(fam, fam.types[0], {});
  // width 2.0 (type) x depth 0.5 (default — the type's 0.9 was ignored)
  near(values.area, 1.0);
});

t("A9 applyTypeValues is pure: it does not mutate the family or the type", () => {
  const fam = syntheticFamily();
  const snapshot = JSON.stringify(fam);
  const { applied } = applyTypeValues(fam, fam.types[0]);
  nassert.deepStrictEqual(applied, { width: 2.0 });
  assert(JSON.stringify(fam) === snapshot, "family mutated by applyTypeValues");
});

// ── B. Builtin goldens — migration must not change resolution ──────────────
const builtins = createBuiltInFamilies();
const builtinByName = new Map(builtins.map((f) => [f.name, f]));

t("B1 every builtin family x type resolves to its pre-migration golden (declared params + formula errors)", () => {
  for (const [famName, golden] of Object.entries(GOLDENS)) {
    const fam = builtinByName.get(famName);
    assert(fam, `builtin family missing: ${famName}`);
    for (const [typeName, expected] of Object.entries(golden.types)) {
      const type = fam.types.find((x) => x.name === typeName);
      assert(type, `${famName}: type missing: ${typeName}`);
      const r = resolveParametricValues(fam, type, {});
      assertValuesEqual(r.values, expected.values, `${famName}/${typeName}`);
      nassert.deepStrictEqual(r.formula.errors.map((e) => `${e.parameter}: ${e.message}`), expected.formulaErrors, `${famName}/${typeName} formula errors`);
      nassert.deepStrictEqual(r.errors, expected.errors, `${famName}/${typeName} errors`);
    }
    const r0 = resolveParametricValues(fam, null, {});
    assertValuesEqual(r0.values, golden.noType.values, `${famName}/no-type`);
    nassert.deepStrictEqual(r0.formula.errors.map((e) => `${e.parameter}: ${e.message}`), golden.noType.formulaErrors, `${famName}/no-type formula errors`);
  }
});

t("B2 slab thickness is a type parameter: types set it, it resolves, and nothing warns", () => {
  // Was: "slab types no longer inject the undeclared 'thickness' key, and
  // warn about it". Main 01c4318 renamed the slab type values to the
  // declared `height` (label "Thickness"), and this wave migrated that
  // parameter to type scope — so the wart the old test pinned (an
  // undeclared key, silently injected) no longer exists at all: the
  // types now set a declared type-scope parameter and it applies.
  const slab = builtinByName.get("Basic Floor");
  assert(slab, "Basic Floor missing");
  for (const type of slab.types) {
    const { values, warnings } = resolveParametricValues(slab, type, {});
    assert(!("thickness" in values), `slab ${type.name} injects a thickness key`);
    assert(warnings.length === 0, `slab ${type.name} warnings: ` + warnings.join(" | "));
  }
  near(resolveParametricValues(slab, slab.types[0], {}).values.height, 0.15);
  near(resolveParametricValues(slab, slab.types[1], {}).values.height, 0.2);
  near(resolveParametricValues(slab, slab.types[2], {}).values.height, 0.25);
});

t("B3 no builtin type value targets an instance-scope parameter or an undeclared parameter", () => {
  // Was: "...the only exception is slab's undeclared thickness". That
  // exception is gone: main 01c4318 renamed the slab type values to the
  // declared `height`, and this wave migrated it to type scope — so no
  // builtin type value is an exception any more, and the list is empty.
  const exceptions = [];
  for (const fam of builtins) {
    const byName = new Map(fam.parameters.map((p) => [p.name, p]));
    for (const type of fam.types) {
      for (const k of Object.keys(type.values ?? {})) {
        const p = byName.get(k);
        if (!p) exceptions.push(`${fam.name}/${type.name}: undeclared "${k}"`);
        else if (p.scope !== "type") exceptions.push(`${fam.name}/${type.name}: "${k}" scope ${p.scope}`);
      }
    }
  }
  nassert.deepStrictEqual(exceptions, []);
});

t("B4 the migration itself: wall/column/beam/slab dimensions that types set are now type-scope", () => {
  const scopeOf = (famName, param) => {
    const fam = builtinByName.get(famName);
    const p = fam.parameters.find((x) => x.name === param);
    assert(p, `${famName} missing ${param}`);
    return p.scope;
  };
  assert(scopeOf("Basic Wall", "thickness") === "type", "wall thickness");
  assert(scopeOf("Basic Column", "thickness") === "type", "column thickness");
  assert(scopeOf("Basic Column", "depth") === "type", "column depth");
  assert(scopeOf("Basic Beam", "thickness") === "type", "beam thickness");
  assert(scopeOf("Basic Beam", "height") === "type", "beam height");
  assert(scopeOf("Basic Floor", "height") === "type", "slab thickness (height)");
  // Parameters no type sets stay instance-scope.
  assert(scopeOf("Basic Wall", "height") === "instance", "wall height stays instance");
  assert(scopeOf("Basic Wall", "elevation") === "instance", "wall elevation stays instance");
  assert(scopeOf("Basic Column", "height") === "instance", "column height stays instance");
});

t("B5 sample parametric door is clean: no type value targets an instance-scope or undeclared parameter", () => {
  const fam = createParametricDoorFamily();
  const byName = new Map(fam.parameters.map((p) => [p.name, p]));
  for (const type of fam.types) {
    for (const k of Object.keys(type.values ?? {})) {
      const p = byName.get(k);
      assert(p, `door type ${type.name} sets undeclared "${k}"`);
      assert(p.scope === "type", `door type ${type.name} sets ${p.scope}-scope "${k}"`);
    }
    const { warnings } = resolveParametricValues(fam, type, {});
    nassert.deepStrictEqual(warnings, [], `door type ${type.name} warnings`);
  }
});

// ── C. Scope semantics on the builtins ──────────────────────────────────────
t("C1 door: type values apply to type-scope width, instance overrides win, instance-scope sillHeight accepts overrides", () => {
  const door = builtinByName.get("Basic Door");
  const single = door.types.find((x) => x.name === "Single 900 x 2100");
  const dbl = door.types.find((x) => x.name === "Double 1800 x 2100");
  near(resolveParametricValues(door, single, {}).values.width, 0.9);
  near(resolveParametricValues(door, dbl, {}).values.width, 1.8);
  near(resolveParametricValues(door, single, { overrides: { width: 1.1 } }).values.width, 1.1);
  near(resolveParametricValues(door, single, { overrides: { sillHeight: 0.3 } }).values.sillHeight, 0.3);
});

t("C2 wall: 100 mm type resolves thickness 0.1, an instance override of thickness still wins, elevation override applies", () => {
  const wall = builtinByName.get("Basic Wall");
  const t100 = wall.types.find((x) => x.name === "Generic 100 mm");
  near(resolveParametricValues(wall, t100, {}).values.thickness, 0.1);
  near(resolveParametricValues(wall, t100, { overrides: { thickness: 0.25 } }).values.thickness, 0.25);
  near(resolveParametricValues(wall, t100, { overrides: { elevation: 0.5 } }).values.elevation, 0.5);
});

t("C3 formulas use post-enforcement values (wall 300 mm, column 400)", () => {
  const wall = builtinByName.get("Basic Wall");
  const t300 = wall.types.find((x) => x.name === "Generic 300 mm");
  const wv = resolveParametricValues(wall, t300, {}).values;
  near(wv.areaPerMeter, 0.9);
  near(wv.slenderness, 10);
  const col = builtinByName.get("Basic Column");
  const c400 = col.types.find((x) => x.name === "400 x 400");
  near(resolveParametricValues(col, c400, {}).values.concreteVolume, 0.48);
});

t("C4 pipe formulas now succeed: slice 2 fixed the diameter bug, so circumference and area evaluate", () => {
  // Was: "pipe formula failures are unchanged by the migration (diameter
  // bug is Slice 2's, still failing identically)". Slice 2 landed in
  // this chain and fixed the formulas (they referenced an undefined
  // `diameter`; they now reference `thickness`), so the failures the
  // old test pinned no longer exist — the formulas evaluate, and the
  // values are exact: circumference = pi * thickness, area =
  // pi * (thickness / 2)^2.
  const pipe = builtinByName.get("Round Pipe");
  const expected = {
    "DN 50": [0.15707963267948966, 0.001963495408493621],
    "DN 100": [0.3141592653589793, 0.007853981633974483],
    "DN 150": [0.47123889803846897, 0.017671458676442587],
  };
  for (const type of pipe.types) {
    const r = resolveParametricValues(pipe, type, {});
    nassert.deepStrictEqual(r.formula.errors, [], `pipe ${type.name} formula errors`);
    nassert.deepStrictEqual(r.errors, [], `pipe ${type.name} errors`);
    near(r.values.circumference, expected[type.name][0]);
    near(r.values.crossSectionArea, expected[type.name][1]);
  }
});

// ── D. Seed catalog ─────────────────────────────────────────────────────────
const seedRoot = path.join(root, "public/families");
const seedIndex = JSON.parse(fs.readFileSync(path.join(seedRoot, "index.json"), "utf8"));
const seedEntries = Array.isArray(seedIndex) ? seedIndex : seedIndex.families ?? seedIndex.entries ?? [];
function loadSeed(relPath) {
  return JSON.parse(fs.readFileSync(path.join(seedRoot, relPath), "utf8"));
}

t("D1 no seed family type value targets an instance-scope or undeclared parameter", () => {
  const violations = [];
  for (const e of seedEntries) {
    const fam = loadSeed(e.path);
    const byName = new Map((fam.parameters ?? []).map((p) => [p.name, p]));
    for (const type of fam.types ?? []) {
      for (const k of Object.keys(type.values ?? {})) {
        const p = byName.get(k);
        if (!p) violations.push(`${e.path}/${type.name}: undeclared "${k}"`);
        else if (p.scope !== "type") violations.push(`${e.path}/${type.name}: "${k}" scope ${p.scope}`);
      }
    }
  }
  nassert.deepStrictEqual(violations, []);
});

t("D2 migrated seed families still resolve elevation to the type value, with no scope warnings", () => {
  const cases = [
    ["Electrical Fixtures/ceiling-sensor.json", "PIR 100 x 100", 2.7],
    ["Lighting Fixtures/high-bay-light.json", "300 x 300 Industrial", 6],
    ["Lighting Fixtures/high-bay-light.json", "400 x 400 Industrial", 8],
    ["Electrical Fixtures/single-socket.json", "1-Gang", 0.3],
    ["Plumbing Fixtures/countertop-sink.json", "Oval 500 x 350", 0.85],
    ["Mechanical Equipment/fan-coil-unit-fcu.json", "600 x 600 Ceiling", 2.7],
  ];
  for (const [rel, typeName, elevation] of cases) {
    const fam = loadSeed(rel);
    const type = fam.types.find((x) => x.name === typeName);
    assert(type, `${rel}: type ${typeName} missing`);
    const { values, warnings } = resolveParametricValues(fam, type, {});
    near(values.elevation, elevation, 1e-9);
    nassert.deepStrictEqual(warnings, [], `${rel}/${typeName} warnings`);
  }
});

t("D3 seed families whose elevation stays instance-scope still resolve it to the default", () => {
  let checked = 0;
  for (const e of seedEntries) {
    const fam = loadSeed(e.path);
    const elev = (fam.parameters ?? []).find((p) => p.name === "elevation");
    if (!elev || elev.scope !== "instance") continue;
    if ((fam.types ?? []).some((ty) => "elevation" in (ty.values ?? {}))) continue;
    for (const type of fam.types ?? []) {
      const { values } = resolveParametricValues(fam, type, {});
      near(values.elevation, elev.default, 1e-9);
      checked++;
    }
  }
  assert(checked > 0, "expected at least one unmigrated seed elevation to check");
});

// ── E. Drift guards ─────────────────────────────────────────────────────────
t("E1 both resolution paths route type values through applyTypeValues", () => {
  for (const rel of ["src/modules/families/parametric-engine.ts", "src/modules/families/registry.ts"]) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    assert(/applyTypeValues\s*\(\s*family\s*,\s*type\s*\)/.test(src), `${rel} does not call applyTypeValues(family, type)`);
    assert(!/for\s*\(\s*const\s*\[k,\s*v\]\s*of\s*Object\.entries\(type\.values\)\)\s*\{\s*values\[k\]\s*=\s*v/.test(src), `${rel} still applies type.values unconditionally`);
  }
  const helperSrc = fs.readFileSync(path.join(root, "src/modules/families/parameter-scope.ts"), "utf8");
  assert(/scope !== "type"/.test(helperSrc), "parameter-scope.ts does not check scope");
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`parameter-scope: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
