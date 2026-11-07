# KB-BIM CSD Packing Engine — Foundation

## Purpose

The first KB-BIM implementation slice adds a deterministic, pure TypeScript cross-section packing engine to the existing MEP domain. It creates candidate 2D arrangements for service envelopes and ranks only candidates that satisfy supplied hard geometric constraints.

This is a foundation for the complete KB-BIM workflow, not a claim that the complete platform is already delivered.

## Current API

Source: src/modules/mep/csd-packing.ts  
Public function: optimizeCsdPacking(request)

Inputs:
- Rectangular section boundary (metres).
- Service envelope IDs, systems, widths and heights.
- Pair and section-edge clearances.
- Optional fixed or preferred positions.
- Optional 90-degree rotation.
- Pairwise hard relationships: left/right, above/below and same centre axis.
- Bounded-search and objective configuration.

Outputs:
- solved, partial, infeasible or invalid-input.
- Ranked candidate placements.
- Occupied area, envelope area, utilization, preference distance, compactness and objective score.
- Explored-node count, search-completeness flag and diagnostics.

## Solver behavior and engineering boundary

- All dimensions are metres.
- Hard clearances, section bounds and supplied relationships are never traded against a weighted objective.
- Search is deterministic for identical input.
- Search uses a configurable grid plus exact contact positions derived from already placed envelopes.
- Search and candidate limits are explicit.
- A bounded or pruned search returns partial; it must not be presented as exhaustive or globally optimal.
- Every returned candidate has passed the solver's configured geometric constraints.
- Rectangle envelopes are an abstraction; this solver does not replace exact 3D solid intersection or project-specific engineering validation.

## Integration status

- Exported from the MEP public barrel.
- Exposed through the MEP service as optimizeCsdPacking.
- Covered by a dedicated Node/TypeScript regression suite.
- Not yet wired to a CSD workspace, IFC cross-section extraction, Web Worker, ANN training, NDCG ranking, corridor-wide continuity or native model modification.

## Next engineering gates

1. Build actual cross-section extraction from IFC/Fragments geometry, retaining source element IDs and provenance.
2. Add typed rule profiles and discipline-specific hard/soft constraints with source references.
3. Add exact geometry envelopes for rotated/curved elements, insulation and installation allowances.
4. Move large searches into a cancellable worker and benchmark realistic station/corridor models.
5. Add expert grading records and a versioned feature dataset.
6. Implement ANN or learning-to-rank only after collecting traceable expert-labelled candidates; evaluate with held-out data and NDCG@K.
7. Add a multi-section corridor solver with transition continuity and crossover zones.
8. Wire candidate preview, approval and transactional BIM edits into the UI.

## Validation

Run npm run test:kb-bim-csd, npm run typecheck and npm run build. The CI unit-test batch also runs the CSD packing suite.
