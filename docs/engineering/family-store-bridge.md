# Family store bridge — design note

Closes the #1 finding of the Family Creator audit (2026-11-24): the
TS family service and the legacy Family Creator never met.

## The two stores

- **Service** (`src/modules/families/`): `familyStore` + the parametric
  service on `ctx.features.family` / `window.__obsFamily`. Records are
  `FamilyDefinition` (schema v2, migrated on load), persisted per
  project to `obs.families.v1.<projectId>`, and travel with the project
  document via `serializeUserFamilies` / `restoreUserFamilies`.
- **Editor** (`public/js/obs-family-editor.js`): plain script. Its
  library is localStorage `obs.families.v1`, an object keyed by family
  name holding editor-shaped records; shared parameters live in
  `obs.families.shared.v1` as `{ name, kind }` pairs.

## Decision: bridge, don't retire

The user chose "bridge the two stores first" (2026-11-24). Neither
store is retired. The store is **authoritative after bridging**; the
editor library is a mirror of it plus a staging area for editor saves.

## How it works

`src/modules/families/family-bridge.ts` — pure conversion + sync over
injected adapters (store / shared-parameter manager / storage). Its
only runtime import is the family migrator, so the node suite compiles
it standalone.

`src/modules/families/family-bridge-boot.ts` — app wiring: runs
`syncAll` once at parametric-family boot, exposes
`window.__obsFamilyBridge` for the editor, and re-exports the editor
library on every store change (export only writes localStorage, so it
cannot loop).

Editor hooks (`obs-family-editor.js`, all guarded so a bridge failure
never loses a local save): `open()` syncs first; `saveToLibrary()`
pushes into the store; `deleteFromLibrary()` removes a bridged family
from the store too; shared-parameter add/delete syncs the manager.

Live refresh: the Parametric Panel and the Family Browser subscribe
to the store's `onChange` and re-render their family lists while open
(the panel sits open behind the creator modal).

## Identity and merge rules

- The TS family id is stamped onto the editor record as `serviceId`;
  records without one match by name on import (the editor's own
  identity — its library is keyed by name). A repeat save updates the
  same family; type ids are preserved by matching types by name. The
  push also stamps `serviceProject` (the current project id, read
  fresh on every call) — because the store is per-project while the
  editor library is global, an entry stamped for another project is
  left alone by this project's import and export, and an entry whose
  `serviceId` is no longer in this project's store is skipped on
  import (never resurrecting a delete) and cleaned up by export.
- The verbatim editor record is kept on the definition as
  `editorSource`, so editor-only data (placement, constraints, voids,
  manufacturer, model, version, description, shared-parameter refs)
  survives panel edits and round-trips. TS → editor starts from that
  record and overlays the current TS name / parameters / types.
- Export scope: only non-built-in, non-seed-catalog families are
  exported into the editor library, so the 54 shipped seed families
  never flood it. Seed families are stamped `origin: "seed-catalog"`
  by the library loader (at create time, plus a by-name pass over
  legacy persisted copies).
- Export reconciles: library entries whose `serviceId` left the
  exportable set are removed. Editor-native entries (no `serviceId`)
  are never removed by export; import picks them up.
- Deletes: an editor delete of a bridged family removes it from the
  store (otherwise the next export would resurrect it); a store delete
  removes its library entry on the next export.
- Shared parameters sync by name both ways. The manager is the richer
  record (GUID, group, type, default, scope); the editor list carries
  `{ name, kind, guid? }`. A manager delete cleans up bridged editor
  entries; editor-native entries are never deleted by the export side.
  Editor entries carrying a `guid` are mirrors of manager definitions
  and are skipped on import, so a manager delete is not resurrected
  by its own exported mirror.

## Geometry

Extrusion maps faithfully both ways (Rectangle / Circle / Polygon
profiles; depth as a parameter reference or a constant; origin as a
translate). Ellipse degrades to a circle (radius = width / 2) and
Polygon to its bounding rectangle — the verbatim recipe rides in
`editorSource`, so the round-trip is still exact.

Other kinds (Revolve / Sweep / Blend / Boolean, and TS box /
cylinder / composed / custom) have no counterpart: the kind string is
kept (the migrator keeps unknown kinds as-is, the engine returns
null for them) and the verbatim geometry is preserved
(`editorSource` / `serviceGeometry`), so a save back restores it
untouched. Editing the geometry recipe of a TS-native non-extrusion
family in the editor has no effect until a recipe editor for those
kinds exists; parameters and types still round-trip.

Constraints: equality and ratio map to the TS constraint graph
(`svc.setConstraints`); range / min / max have no TS equivalent and
stay in `editorSource` only.

Not mapped (preserved in `editorSource`, never invented):
`sourceElementType` (the editor's placement host is not an element
type), MEP connector definitions, and the seed-catalog `description`
handling is unchanged. A family edited in the editor keeps the
store's `connectorDefs` / `sourceElementType` / `group` on update.

## What this deliberately leaves out

- The dead "Test in scene" button, the native `alert()` / `prompt()`
  / `confirm()` calls, the hidden "FAM" button, and the panel "Place
  instance" path for unmapped families — separate audit items, in
  that order.
- The seed-catalog loader re-adds the catalog on every boot because
  its skip check (`familyStore.get(entry.id)`) can never match — the
  store assigns a fresh uid on create. Found while building this
  bridge (the bridge's export rule had to be robust to it); not fixed
  here, needs its own item. Browser-confirmed by the bridge spec run:
  the service family list grew 51 -> 107 across one reload, while the
  bridged family still appeared exactly once by name.
- No deletion sync for shared parameters from the editor side beyond
  the manager cleanup above; no conflict UI when the same family is
  edited in both systems between syncs (last writer wins per field:
  TS wins for name / parameters / types on export, the editor wins on
  push).
