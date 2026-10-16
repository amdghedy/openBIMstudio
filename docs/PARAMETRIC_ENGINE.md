# Parametric Engine — Revit-competitive layer for Open BIM Studio

## What you already had

| Module | Role |
|--------|------|
| `types.ts` | `FamilyDefinition`, parameters, type/instance scope, basic geometry specs |
| `formula-engine.ts` | Topo-sorted formulas, cycle detection, Math helpers |
| `parametric-geometry.ts` | box / cylinder / extrusion / composed / custom |
| `registry.ts` + `store.ts` | CRUD, resolveParams, buildGeometry |
| `builtin-families.ts` | Seed walls, doors, windows, MEP, … |

## What this package adds

| File | Capability |
|------|------------|
| **`parametric-engine.ts`** | Full pipeline: shared → type → instance → formulas → **constraints** → geometry (sweep / revolve / loft / void / conditional / nested / array) |
| **`formula-engine-enhanced.ts`** | `if()`, boolean ops, comparisons, unit helpers (`mm`, `ft`, `deg`), dependency graph |
| **`constraint-graph.ts`** | equality, offset, ratio, sum, difference, fixed, distance |
| **`array-expander.ts`** | Linear / rotational / grouped arrays with alternate mirror |
| **`nested-families.ts`** | Nested family refs + param mapping + shared flag |
| **`types-extended.ts`** | TypeScript types for the new geometry kinds |
| **`registry-parametric.ts`** | Drop-in `createParametricFamilyService()` |

## Integration (minimal)

### 1. Prefer the enhanced formula engine

In `registry.ts` (or anywhere that imports `evaluateParameters`):

```ts
// was:
import { evaluateParameters } from "./formula-engine";
// become:
import { evaluateParameters } from "./formula-engine-enhanced";
```

Or rename: copy `formula-engine-enhanced.ts` over `formula-engine.ts`.

### 2. Switch the service factory

In `src/modules/families/index.ts`:

```ts
// was:
import { createFamilyService } from "./registry";
// become:
import { createParametricFamilyService as createFamilyService } from "./registry-parametric";
```

`setupFamilies()` and `ctx.features.family` stay the same shape; you gain:

```ts
const fam = ctx.features.family as ParametricFamilyService;

fam.buildParametric(familyId, typeId, { overrides: { Width: 1.2 } });
fam.setConstraints(familyId, [
  { kind: "ratio", a: "Height", b: "Width", k: 2.1 },
  { kind: "offset", a: "HeadHeight", b: "Height", delta: 0.05 },
]);
fam.reportingValues(familyId, typeId);
```

### 3. Author advanced geometry in family definitions

```ts
const door: FamilyDefinition = {
  // …id, name, category, ifcEntity, parameters…
  geometry: {
    kind: "composed",
    parts: [
      {
        kind: "extrusion",
        profile: { kind: "rect", w: { ref: "Width" }, h: { ref: "Height" } },
        depth: { ref: "Thickness" },
      },
      {
        kind: "conditional",
        when: "HasPanel",
        then: {
          kind: "box",
          w: { ref: "PanelWidth" },
          d: { ref: "PanelDepth" },
          h: { ref: "PanelHeight" },
          transform: { translate: [{ const: 0 }, { const: 0 }, { ref: "PanelOffset" }] },
        },
      },
      {
        kind: "array",
        count: { ref: "MullionCount" },
        step: [{ ref: "MullionSpacing" }, { const: 0 }, { const: 0 }],
        of: {
          kind: "box",
          w: { const: 0.05 },
          d: { ref: "Thickness" },
          h: { ref: "Height" },
        },
      },
    ],
  },
  // …
};
```

### 4. Wire type-edit propagation in authoring

When the user edits a **type** parameter in the property palette:

```ts
const bindings: InstanceParamBinding[] = elements
  .filter(e => e.familyId === familyId && e.familyTypeId === typeId)
  .map(e => ({
    elementId: e.id,
    familyId: e.familyId!,
    typeId: e.familyTypeId ?? null,
    overrides: e.instanceParams ?? {},
  }));

const updated = fam.propagateType(familyId, typeId, bindings);
for (const [elementId, params] of updated) {
  authoring.updateElementParams(elementId, params);
  authoring.rebuildElement(elementId);
}
```

## Parameter evaluation order (matches Revit intent)

1. Family defaults  
2. Shared / project parameters (optional)  
3. Type values  
4. Instance overrides  
5. Min/max/integer clamp  
6. Formula pass (topo-sorted)  
7. Constraint solve  
8. Final clamp  

## Formula quick reference

```
= Width * 2
= if(IsDouble, Width / 2, Width)
= max(Height, 2.1)
= HeadHeight - Height          // reporting
= mm(50)                      // 0.05 m
= sind(30) * Radius
= and(HasFrame, gt(Width, 0.9))
```

## Constraints quick reference

```ts
{ kind: "equality", a: "A", b: "B" }
{ kind: "offset", a: "Top", b: "Bottom", delta: 3.0 }
{ kind: "ratio", a: "H", b: "W", k: 1.618 }
{ kind: "sum", a: "Total", terms: ["A", "B", "C"] }
{ kind: "fixed", a: "Clearance", value: 0.15 }
{ kind: "distance", a: "X2", b: "X1", distance: 1.2, drive: "a" }
```

## Gaps vs full Revit (honest roadmap)

| Revit feature | Status here |
|---------------|-------------|
| Type / instance parameters + formulas | ✅ |
| Nested families + param map | ✅ |
| Arrays | ✅ |
| Sweeps / revolves | ✅ (profile-based) |
| Voids (boolean cut) | ⚠️ marked; CSG subtraction still approximate |
| Reference planes / dims in sketch | ❌ UI not yet |
| Adaptive components / points | ❌ |
| Full NURBS loft | ⚠️ linear slice approximation |
| Family types catalog (.txt) | ❌ import/export next |
| Shared parameter file (.txt) | ⚠️ data model only |

## Verify

After wiring:

```bash
npm run typecheck
# optional: extend scripts/verify-v54.mjs to assert
#   evaluateParameters + buildParametricFamily on a door with formulas
```
