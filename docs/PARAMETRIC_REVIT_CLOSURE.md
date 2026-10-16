# Revit + Parametric Engine — Gap Closure Complete

## Install

```bash
cp -r artifacts/src/* <OpenBIMStudio>/src/
npm run typecheck && npm run dev
```

## Parametric engine (Revit family core)

| Feature | Module | Status |
|---------|--------|--------|
| Formula evaluation (topo sort, cycles, `=`) | formula-engine + enhanced | ✅ |
| Dimensional constraints | constraint-graph.ts | ✅ |
| Nested families | nested-families.ts | ✅ |
| Linear / rotational arrays | array-expander.ts | ✅ |
| Sweep / revolve / loft / void / conditional | parametric-engine.ts | ✅ |
| Type → instance propagation | propagateTypeChange | ✅ |
| Reporting parameters | collectReportingValues | ✅ |
| Type catalogs (.txt) | type-catalog | ✅ |
| Shared parameters | shared-params | ✅ |
| Parametric FamilyService | registry-parametric.ts | ✅ |
| Sample parametric door | sample-parametric-door.ts | ✅ seeded on boot |
| **Editor UI** | parametric-family-panel.ts | ✅ |

### UI

| Open | |
|------|--|
| Green **FAM** button | bottom-left |
| **Ctrl+Shift+F** | Parametric Families panel |
| Command Center → **Parametric Fam** | |
| Ctrl+P → “Parametric Families Panel” | |

### Panel actions

1. Select family + type  
2. Edit parameters (formula-driven rows are read-only green)  
3. **Rebuild geometry** → 3D preview in scene  
4. **Save type values**  
5. **Show constraints**  
6. **Place instance** (hooks authoring when mapped)

### API

```js
const svc = __obsFamilyParametric
svc.buildParametric(familyId, typeId)
svc.resolveParametric(familyId, typeId, { overrides })
svc.setConstraints(familyId, constraints)
svc.propagateType(familyId, typeId, instances)
```

## Revit platform gaps (also closed)

| Area | Status |
|------|--------|
| Rooms / areas / phases / design options / groups | ✅ |
| Ref planes / shared params / visibility | ✅ |
| Stairs / railings / curtain walls | ✅ |
| Align / match props / temp dims / hide-isolate | ✅ |
| Copy/Monitor | ✅ |
| Mouse/keyboard Revit map | ✅ |
| CAD + DXF/DWG drawings | ✅ |
| Command Center UI | ✅ |

## Boot log (success)

```
[parametric-families] upgraded service — N families, parametric build active
[parametric-family-panel] ready — FAM button or Ctrl+Shift+F
[critical-gaps-boot] all critical gaps wired
```

## Intentionally later

- Full family sketch editor (draw extrusions in UI)  
- Native `.rfa` import  
- Adaptive components  
- Worksharing element locks  
