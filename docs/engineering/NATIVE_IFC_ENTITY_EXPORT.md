# Native Twin IFC entity export — GAP-05

Writer: `src/modules/export/native-twin-ifc.ts` (IFC4, single Project / Site /
Building / Storey). Validator: `scripts/validate_native_ifc_export.py`
(IfcOpenShell). Tests: `tests/native-ifc-entities.test.cjs`,
`tests/native-ifc-independent-validation.test.cjs`.

## What was wrong

`safeEntityName()` was called and its result discarded
(`void safeEntityName(edit)`), and the writer hard-coded
`IFCBUILDINGELEMENTPROXY` for every element. A wall, a door and a slab all
exported as proxies: the file parsed, but no receiving tool could see what
anything was. Fixed on branch `fix/native-ifc-entities` (base `e8e5afb`):
the resolved entity is now the entity emitted, with the correct per-type
attribute list from the IFC4 schema.

## Genuinely supported types (18)

"Genuinely supported" means the full chain is demonstrated for the type:
mapping + per-type attributes + placement + storey containment + pset
relationships + IfcOpenShell validation (including a geometry-kernel shape
for a closed-box fixture). All 18 are validated that way; see the
independent-validation test output.

| Entity | IFC4 attrs | PredefinedType | Notes |
|---|---|---|---|
| IfcWall | 9 | full IfcWallTypeEnum | IfcWallStandardCase / IfcWallElementedCase map here: StandardCase needs SweptSolid+Axis, ElementedCase needs subordinate aggregation — tessellated twins can satisfy neither, so plain IfcWall is correct. |
| IfcSlab | 9 | full IfcSlabTypeEnum | |
| IfcBeam | 9 | full IfcBeamTypeEnum | |
| IfcColumn | 9 | full IfcColumnTypeEnum | |
| IfcMember | 9 | full IfcMemberTypeEnum | |
| IfcPlate | 9 | full IfcPlateTypeEnum | |
| IfcFooting | 9 | full IfcFootingTypeEnum | |
| IfcRailing | 9 | full IfcRailingTypeEnum | |
| IfcStair | 9 | full IfcStairTypeEnum | |
| IfcRamp | 9 | full IfcRampTypeEnum | |
| IfcPile | 10 | full IfcPileTypeEnum + ConstructionType `.NOTDEFINED.` | Twins carry no construction type. |
| IfcDoor | 13 | full IfcDoorTypeEnum | + OverallHeight/OverallWidth (see below); OperationType `$` (unknown). |
| IfcWindow | 13 | full IfcWindowTypeEnum | + OverallHeight/OverallWidth; PartitioningType `$` (unknown). |
| IfcFurnishingElement | 8 | — (no such attribute) | No standard common pset in IFC4. |
| IfcFlowSegment | 8 | — | Common pset: Pset_DistributionFlowElementCommon. |
| IfcFlowTerminal | 8 | — | Common pset: Pset_DistributionFlowElementCommon. |
| IfcFlowFitting | 8 | — | Common pset: Pset_DistributionFlowElementCommon. |
| IfcDistributionElement | 8 | — | No standard common pset in IFC4. |

Attribute order follows the IFC4 schema (IfcRoot 4 + ObjectType + Placement
+ Representation + Tag, then the type's own attributes). `PredefinedType`
defaults to `.NOTDEFINED.`; a supplied value is used only if it is a valid
member of that entity's enum (checked case-insensitively). `USERDEFINED`
without an ObjectType label is downgraded to `.NOTDEFINED.` — emitting it
would violate the IFC4 `CorrectPredefinedType` where-rule. The source Tag
is emitted when present (`tag` / `sourceTag`); otherwise `$`.

Entity labels are matched case-insensitively and with or without the `Ifc`
prefix (`IFCWALL`, `IfcWall`, `Wall` all resolve to IfcWall), because
imported twins carry the uppercase form web-ifc produces.

## Door / window overall sizes

OverallHeight/OverallWidth are **bounding-box approximations, not
parametric source values**, taken in this priority order:

1. explicit `overrides.OverallHeight` / `OverallWidth` (user-supplied);
2. recorded `dimensions` (`height` = Y extent, `width` = X extent, Y-up);
3. local geometry bounding box (Y extent = height, X extent = width);
4. omitted (`$`) when no source yields a positive value.

## Explicit fallback (never silent)

Anything outside the table — `IfcSpace`, `IfcRoof`, `IfcCurtainWall`,
unknown labels, twins with no entity information — is emitted as
`IfcBuildingElementProxy` (`.NOTDEFINED.`) **and** recorded in the
conversion report (`writeFederatedNativeTwinIfcWithReport`) with
`status: "proxied"` and a `fallbackReason`. The report is the
machine-readable entity-level conversion report: per element it records
source entity, emitted entity, status, PredefinedType, Tag, overall sizes,
placement validity, geometry vertex/triangle counts, attached pset names,
fallback reason and notes.

The report is also **surfaced, not just computed**. Every export path
hands it to the user instead of dropping it:

- Federated export (`native-ifc-workflow.ts`, sync and async paths) toasts
  "`N typed, M proxied (types…)`" and records the same counts plus the
  proxied source types in the change history (`export-ifc` entry:
  `typed` / `proxied` / `proxiedTypes`). The per-twin path does the same
  in aggregate.
- The live IFC link records the counts on its 1st and every 10th write.
- A single-twin export (`frag-edit.ts`) toasts a warning naming the type
  when that twin fell back to a proxy.
- The download functions return the report (and take an optional
  `onReport` callback), so any future export path can surface the report
  without re-deriving it.

## Placement, geometry, containment, psets

- Placement: the twin quaternion is normalised to unit length before the
  rotation matrix is built; a non-finite position is reset to the storey
  origin and a degenerate (zero-norm) or non-finite quaternion to identity.
  Every repair is recorded in the report entry (`placementValid: false` +
  note) — never silent.
- Numbers are emitted as STEP REALs with a decimal point (`0.`, `5.`).
  Bare integers in `IfcDirection` ratios made IfcOpenShell's geometry
  kernel fail shape creation ("Unexpected topology") while the file still
  parsed — this was caught by the independent validation, not by any
  self-round-trip, and fixed in the same change.
- Geometry: tessellated Body representation (`IfcTriangulatedFaceSet`)
  from the twin's triangle positions when finite; otherwise no
  representation (`$`). Non-finite coordinates drop the representation
  and are reported.
- Containment: every element gets exactly one
  `IfcRelContainedInSpatialStructure` to the single storey.
- Property sets: every source pset and the `NativeOverrides` pset (when
  overrides exist) are attached via `IfcRelDefinesByProperties`, plus the
  `Pset_NativeTwinLineage` pset (SourceGlobalId / SourceEntity /
  SourceModelId). No empty standard common pset is synthesised: a
  `Pset_<Type>Common` is attached only when the twin actually carries it.
- GUIDs: a valid source GlobalId is preserved; anything else is replaced
  by a deterministic derived GUID (stable across exports for the same
  twin). Relationship/pset GUIDs are fresh random valid GUIDs.

## Documented limits (not supported — do not claim otherwise)

- **No openings / fills.** Doors and windows are standalone products with
  placement, tessellation and storey containment. The writer emits no
  `IfcOpeningElement`, `IfcRelVoidsElement` or `IfcRelFillsElement`:
  twins carry no host-wall information, so a fills relationship would be
  fabricated. (The authored-model writer in
  `src/modules/bim-gaps/authored-ifc.ts` *does* build real openings for
  authored doors/windows — this limit is specific to the twin path.)
- **No `IfcWallStandardCase`.** See the table above.
- **No axis conversion.** Positions, quaternions and geometry are written
  in the twin's own (three.js, Y-up) frame, as before this change. Overall
  sizes are derived in that same frame (see above).
- **No system relationships for flow elements.** `IfcFlowSegment` /
  `IfcFlowTerminal` / `IfcFlowFitting` are exported as standalone
  distribution elements with no port, connectivity or system assignment.
- **No desktop-tool proof.** Files are validated with IfcOpenShell 0.9.0
  and read back with web-ifc 0.0.77 (the app's own import path). No
  exported file has been opened in Revit, ArchiCAD, Solibri or any other
  desktop BIM tool — that validation is still open (GAP-12 area).

## Validation evidence (2026-11-20, base e8e5afb)

- Baseline (pre-fix) file, IfcOpenShell 0.9.0: parses, but 4/4 elements
  `IfcBuildingElementProxy` — 0 typed (wall, door, slab, space).
- Fixed file, IfcOpenShell 0.9.0: 19-element mixed export (18 typed + 1
  proxy) validates with **0 errors**; every element has a valid GlobalId,
  the exported placement, a tessellation (36 verts / 12 tris on the box
  fixture), storey containment and the lineage pset; the geometry kernel
  builds a shape for **all 19** elements.
- web-ifc 0.0.77 (Node API, the app's import parser) reads the fixed file:
  1 `IFCWALL`, 1 `IFCWINDOW`, 1 `IFCDOOR`, 1 proxy; wall properties show
  `PredefinedType: STANDARD`, `Tag: W-01`.
- `tests/native-ifc-entities.test.cjs`: 15 assertions groups pass.
  `tests/native-ifc-independent-validation.test.cjs`: passes with
  IfcOpenShell installed (skips gracefully without it).
