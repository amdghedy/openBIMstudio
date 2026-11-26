# Decision: one canonical element store, discipline views as adapters

**Proposed:** 2026-11-26, against `main` `e033829`.
**Status:** proposal, pending review. This is the Phase 1 "single source of
truth for BIM elements, parameters and types" work; it lands incrementally,
not as one rewrite.

## Decision

Establish one canonical store — `src/core/element-store.ts` — that owns the
id → element record mapping for every element in the document, regardless
of discipline. Each discipline keeps its editor and its geometry, but
registers its elements into the store through a kind adapter:

- **Authoring (native BIM elements)** is kind adapter #1. It already owns
  native elements and routes edits through `applyElementParamChange`; the
  store adopts that ownership unchanged.
- **CAD entities** (`cad-engine`, `drafting-2d`) are kind adapter #2.
- **Family instances** (the family store) are kind adapter #3.

All parameter changes, in every kind, funnel through one
`applyParamChange(id, param, value)` path that validates against the type,
regenerates the owning kind's geometry, and pushes exactly one entry onto
the canonical history stack (`features/history.ts`). Type definitions live
with the store so two kinds cannot define the same parameter two ways.

The project store stops being a parallel element owner: on save it
serializes FROM the canonical store, and on load it hydrates INTO it.

## Evidence (2026-11-26)

- Today there is no one model: `ARCHITECTURE.md` says authoring owns native
  elements, but CAD entities live in the cad-engine and drafting-2d stores,
  families in the family store, and the project store holds its own
  `elements` array that `saveProject()` overwrites from `getElements()`.
  An element that exists in two stores can be edited in one and saved from
  the other — that is the Phase 1 "silent data loss" class.
- Precedent for the one-owner shape already exists and works: one history
  stack (`global-undo.ts` owns the keyboard path), one service registry
  (`core/services.ts`), one autosave owner (`persistence.ts`). This
  decision extends the same pattern to element state.

## Migration order (each step independently shippable)

1. Define the store and the kind-adapter interface; register authoring as
   the first kind with **no behavior change** (the store delegates to the
   existing authoring functions). Add a unit test that one id maps to one
   record across a param change.
2. CAD entities adapter. This is the risky step — the CAD engines keep
   their own selection/undo paths — so it lands behind the existing e2e CAD
   specs.
3. Family instances adapter.
4. Point persistence at the store (save reads it, load writes it); the
   recovery and edit-undo-save e2e specs are the gate.
5. Ratchet: new element state outside the store fails CI (same style as
   the `window.__obs*` ratchet).

## Explicitly out of scope

- MEP systems/network state (already has its own lifecycle snapshot).
- Fragment/IFC model data (owned by the importer and `fragments` manager;
  the store references imported elements by id, it does not copy geometry).
