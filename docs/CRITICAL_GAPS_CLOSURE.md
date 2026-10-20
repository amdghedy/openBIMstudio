# Open BIM Studio ↔ BIM — Critical Gaps Closed

## Install

```bash
cp -r artifacts/src/* <OpenBIMStudio>/src/
cd <OpenBIMStudio>
npm run typecheck
npm run dev
```

`main.ts` already contains `import "./critical-gaps-boot"` — no entry-point change.

---

## Complete capability matrix

| BIM workflow | Open BIM Studio | Module |
|----------------|-----------------|--------|
| Parametric families + formulas | ✅ | `modules/families/parametric-engine.ts` |
| Family constraints | ✅ | `modules/families/constraint-graph.ts` |
| Nested families / arrays | ✅ | `nested-families.ts`, `array-expander.ts` |
| Type catalog (.txt) | ✅ | `modules/type-catalog/type-catalog.ts` |
| Shared / project parameters | ✅ | `modules/shared-params/shared-params.ts` |
| Rooms & areas | ✅ | `modules/rooms/rooms.ts` |
| Phasing + phase filters | ✅ | `modules/phases/phases.ts` |
| Design options | ✅ | `modules/design-options/design-options.ts` |
| Model groups | ✅ | `modules/groups/groups.ts` |
| Reference planes / work plane | ✅ | `modules/ref-planes/ref-planes.ts` |
| Stairs (straight / L / U) | ✅ | `modules/stairs/stairs.ts` |
| Railings | ✅ | `modules/railings/railings.ts` |
| Curtain walls | ✅ | `modules/curtain-wall/curtain-wall.ts` |
| Align / distribute | ✅ | `features/align-tool.ts` |
| Match properties | ✅ | `features/bim-parity-bridge.ts` |
| Create similar | ✅ | parity bridge → authoring |
| Temporary dimensions | ✅ | `features/temp-dimensions.ts` |
| Temporary hide / isolate | ✅ | `modules/visibility/visibility-filter.ts` |
| Copy / Monitor | ✅ | `modules/copy-monitor/copy-monitor.ts` |
| MEP System Browser | ✅ enabled | existing + UI patch |
| Navigation bar | ✅ enabled | existing + UI patch |
| P&ID / Fabrication panels | ✅ enabled | existing + UI patch |
| Hosted doors/windows + openings | ✅ | existing |
| Clash / IDS / BCF / 4D / 5D | ✅ | existing |
| Sheets / schedules / views | ✅ | existing |
| Command palette integration | ✅ | parity bridge registers 20+ cmds |

---

## Bottom toolbar (critical-gaps-ui)

```
[D] Draft | Hosts | Solve | Stair | Railing | Curtain | Room
| Align X | Match | Paint | Group | Hide | Isolate | Reset Vis
| Phases | Rooms | Options | LOD | Perf
```

---

## Command palette (Ctrl+P)

Search categories **Architecture**, **Modify**, **View**, **Panels** for:

- Place Stair / Railing / Curtain Wall  
- Align / Distribute  
- Match Properties  
- Temporary Hide / Isolate  
- Rooms / Phases / Design Options / Groups / Copy-Monitor panels  
- Set Work Plane  

---

## Runtime globals

| Global | Purpose |
|--------|---------|
| `__obsRooms` | Rooms & areas store |
| `__obsPhases` | Phasing |
| `__obsGroups` | Model groups |
| `__obsDesignOptions` | Design options |
| `__obsRefPlanes` | Reference planes |
| `__obsSharedParams` | Shared parameters |
| `__obsVisibility` | Visibility filter |
| `__obsStairs` / `__obsRailings` / `__obsCurtainWall` | Generators |
| `__obsCopyMonitor` | Copy/Monitor |
| `__obsTypeCatalog` | Type catalogs |
| `__obsAlign` | Align / distribute |
| `__obsTempDims` | Temporary dimensions |
| `__obsBIMParity` | Placement + match props bridge |
| `__obsFamilyParametric` | Parametric family service |

---

## Still future (not critical for openBIM parity)

| Item | Why deferred |
|------|----------------|
| Native `.rfa` / `.rte` import | openBIM path is IFC + parametric families |
| Adaptive components UI | Needs full family editor canvas |
| Sketch-based stairs | Generators cover standard runs |
| Granular worksharing locks | Workshare client exists; ACL layer next |
| Full mesh CSG voids | Marked in geometry pipeline |

---

## File count

**26 TypeScript modules** under `artifacts/src/` covering parametric, spatial, coordination, architecture generators, visibility, and UI integration.
