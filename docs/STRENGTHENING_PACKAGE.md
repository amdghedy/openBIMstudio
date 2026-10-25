# OpenBIMStudio Strengthening Package v1.0

**Closes remaining depth gaps vs Revit and hardens the platform for production use.**

Target: openBIMstudio ≥ 0.66.x  
Date: 2025-10-25  
Author: Gap-closure package for amdghedy/openBIMstudio

---

## What this package delivers

| Priority | Module | Capability | Revit equivalent |
|----------|--------|------------|------------------|
| **P0** | `transaction` | Full Transaction / TransactionGroup + Undo/Redo | Transaction, TransactionGroup |
| **P0** | `parametric-regen` | Dirty-flag propagation, constraint solving, live formulas | Regen, Family solver |
| **P0** | `properties-panel` | Multi-select, *VARIES*, formulas, type/instance | Properties palette |
| **P1** | `joins-cleanup` | Wall/floor/roof joins + host opening recut | Wall joins, Cut openings |
| **P1** | `lod-performance` | LOD levels, instancing, performance stats | Performance / Display |
| **P1** | `view-templates` | Templates, filters, graphic overrides | View Templates |
| **P2** | `site-topo` | Toposolid + Building Pad | Topography, Building Pad |
| **P2** | `detailing` | Detail components, repeating details, keynotes | Detail Component, Keynote |
| **P2** | `validation` | Rules engine + auto-fix | Warnings / Errors |

All modules follow the existing openBIMstudio pattern:
- `types.ts` + `index.ts`
- Singleton service + `getXxxService()`
- Window globals (`__obsTransaction`, etc.) for ribbon / command palette
- Transaction-aware mutations
- Dirty marking into parametric regen

---

## Installation (drop-in)

```bash
# From the root of your openBIMstudio clone
cp -r path/to/openBIMstudio-strengthening/src/modules/* src/modules/
cp path/to/openBIMstudio-strengthening/src/critical-gaps-boot-strength.ts src/
```

### 1. Boot the modules

In `src/main.ts` (or after the existing critical-gaps-boot import):

```ts
import "./critical-gaps-boot-strength";
```

### 2. Wire the low-level handlers (required for real effect)

Somewhere after the authoring / element store is ready (e.g. in a setup function):

```ts
import { getTransactionService } from "./modules/transaction";
import { getParametricRegenService } from "./modules/parametric-regen";
import { getPropertiesPanelService } from "./modules/properties-panel";
import { getJoinsCleanupService } from "./modules/joins-cleanup";
// ... etc.

// Transaction → actual model mutation
getTransactionService().setApplyHandler((change, reverse) => {
  const el = getElementById(change.elementId);
  if (!el) return;
  const path = change.propertyPath;
  if (reverse) {
    (el as any)[path] = change.oldValue;
  } else {
    (el as any)[path] = change.newValue;
  }
  // trigger any existing rebuild if needed
});

// Parametric regen → geometry rebuild
getParametricRegenService().setRegenHandler(async (ids) => {
  await rebuildAuthored(ids); // your existing rebuild function
});

getParametricRegenService().setParamAccessors(
  (id, name) => getElementById(id)?.[name] as number | undefined,
  (id, name, value) => { const el = getElementById(id); if (el) el[name] = value; }
);

// Properties
getPropertiesPanelService().setElementAccessors(
  (id) => getElementById(id) as any,
  (id) => getCategory(id)
);

// Joins (plug your CSG / geometry join code)
getJoinsCleanupService().setHandlers(
  () => getAllElements().map(e => ({ id: e.id, category: e.category, geometry: e.mesh })),
  async (a, b, type) => { /* call your join implementation */ return true; },
  async (hostId) => { /* call your recut openings */ return true; }
);

// View templates
getViewTemplatesService().setApplyHandler((viewId, template) => {
  // apply overrides to the view
});

// Validation
getValidationService().setElementsProvider(() =>
  getAllElements().map(e => ({ id: e.id, data: e as any, category: e.category }))
);
```

### 3. Ribbon & Commands

Merge the contents of `src/integration-strength/ribbon-strength.ts` into your existing `ribbon.ts` and command registry.

---

## Keyboard shortcuts (recommended)

| Shortcut | Action |
|----------|--------|
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Ctrl+Shift+V | Run Validation |
| Ctrl+Alt+J | Auto Join |

---

## Verification

```bash
# Typecheck (after integration)
npx tsc --noEmit

# Runtime smoke
# 1. Open app → console should show "[Strengthening] P0–P2 modules booted"
# 2. Ctrl+Z / Ctrl+Y should work after any property change
# 3. Manage → Validate should list issues
# 4. window.__obsTransaction.getState() should return stacks
```

---

## Architecture notes

- **Transaction** is the single source of truth for undo/redo. All property writes and geometry mutations should go through `recordChange` or a started transaction.
- **ParametricRegen** listens to dirty flags and drives geometry rebuild. Formula constraints are evaluated safely (restricted expression language).
- **Properties Panel** is multi-select aware and shows `*VARIES*` for mixed values. Formula properties re-evaluate live.
- Modules are deliberately loosely coupled via handlers so they can be adopted incrementally.

---

## Next recommended hardening (not in this package)

1. Spatial index (R-tree / BVH) for joins and clash
2. Full constraint geometry solver (equal, parallel, distance with real numeric solver)
3. Worksharing / collaboration layer (element ownership + sync)
4. Print / PDF production pipeline with view-to-sheet fidelity
5. Adaptive components / panelization
6. Full Family Editor UI

---

**This package raises openBIMstudio from “v0.1 coverage of every domain” to production-viable depth on the most critical authoring, stability and documentation axes.**
