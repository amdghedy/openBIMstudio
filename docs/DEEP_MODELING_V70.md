# Deep Modeling — v0.70

The v0.70 wave closes the platform's biggest remaining solid-modeling
technique gap — the v0.68 Authoring Core's **Deviation D-3** (boolean
operations restricted to convex operands) — and adds two Revit-grade
modeling techniques on top: **shell/hollow** and **multi-section loft**.
Everything ships as pure, Node-testable engines with closed-form-verified
tests, and every function is wired to ribbon buttons.

---

## 1. General boolean kernel (`src/modules/solid-kernel/general-csg.ts`)

`generalBoolean(op, a, b)` performs **union / intersect / subtract on
arbitrary closed meshes** — both operands may be non-convex (L-shaped
masses, walls with existing openings, stepped solids, donut sections).
Convenience wrappers: `generalUnion`, `generalIntersect`,
`generalSubtract`; n-ary `fuseAll` reduces a list of solids with the
general union; `weldMesh` converts the output polygon soup into an
indexed mesh so `validateMeshDiagnostics` can count topology.

### Algorithm (level E, closed-form-verified)

1. **Global cut set.** For each mesh we build cutting objects: every
   triangle's support plane **plus** an edge-perpendicular plane through
   every triangle edge (a plane containing the edge, perpendicular to
   the edge's own triangle). Every triangle of **both** meshes is then
   split by **every** cutting object — no early exit, because for a
   non-convex solid "in front of some face plane" does *not* imply
   outside. Splitting convex pieces keeps every fragment convex.

   The edge-perpendicular planes are what make the result
   **T-junction-free**: a cutter plane that crosses one face but merely
   touches its neighbour along a shared edge (or an internal
   triangulation diagonal crossing the other mesh) would otherwise
   create a vertex on one side only. With the global cut set, any
   vertex created on a face is mirrored on the neighbour across every
   edge it touches, because the neighbour is cut by the same objects —
   seam consistency holds by construction, verified by
   `non-manifold-edge == 0` assertions after welding in the test suite.

2. **Probe classification.** Each fragment is classified with the
   robust 3-direction majority point-in-solid test (`isInsideRobust`),
   probing the centroid displaced `PROBE_EPS = 1e-6 m` along the
   fragment outward normal:
   - `u = c + eps·n` — just OUTSIDE the owner solid
   - `l = c − eps·n` — just INSIDE (material side)

   Per-op membership rules (local-sector derivation: a boundary point
   of the result needs a "neither solid" sector):

   | fragment | union            | intersect       | subtract |
   |----------|------------------|-----------------|----------|
   | A-skin   | keep iff ¬inB(u) | keep iff inB(l) | keep iff ¬inB(l) |
   | B-skin   | keep iff ¬inA(u) | keep iff inA(l) | keep iff inA(u), **flipped** |

   The subtract B-rule reuses the exact v0.68 probe convention, so
   flush through-openings behave identically to the voids engine.

3. **Coplanar resolution.** A fragment landing exactly on a face plane
   of the other mesh is tagged and additionally split **in plane** by
   every edge line the other mesh runs on that plane (coplanar face
   boundaries, faces ending on the plane, and internal triangulation
   diagonals). Each cell is then classified by the same probe rules,
   with one ownership exception:
   - **A owns the overlap skin.** A B-cell covered by a SAME-facing A
     triangle is dropped (the A pass emits that skin exactly once).
     Without it, coincident same-facing skins would be emitted twice
     and welded to a count-4 (non-manifold) seam.
   - Opposite-facing coplanar contact (stacked solids) resolves through
     the probes: the contact region is interior to the union (dropped),
     reproduced correctly by intersect (empty), and kept exactly once
     by subtract.
   - Subtract drops **all** coplanar B-cells: a coplanar void face is
     either flush with a host face (the opening must stay open) or
     buried (the host's own cells decide). This reproduces the v0.68
     semantics, including the celebrated flush through-opening case.

### What the tests prove (tests/v70-deep-modeling.test.cjs)

- union of overlapping boxes with coplanar tops → **1.75 m³ exactly**,
  watertight (the L-shape headline case)
- stacked boxes (opposite-facing contact) → 2.0, no interior skin
- glued side-by-side boxes → 2.0, watertight
- disjoint union → volumes add (compound solid)
- intersect of overlapping boxes → 0.5 exactly, watertight
- intersect with a **non-convex chained union output** → both notch
  corners cut exactly (1 − 2·0.0625)
- subtract with a **non-convex L cutter** → 0.75 exactly
- interior non-convex cavity → 8 − 0.75 exactly, watertight
- flush through-opening (window in wall) → 4.44 exactly, watertight
- union volume symmetry union(A,B) == union(B,A)
- `fuseAll` chain of three overlapping cubes → 2.5 exactly

## 2. Shell / hollow (`src/modules/solid-kernel/shell.ts`)

- `offsetClosedRing(ring, offset)` — miter offset of a validated simple
  ring; positive shrinks (inward, the interior side of a CCW ring),
  negative grows. Collinear vertices are dropped first (miters are
  undefined there); the result is validated (simple, no collapsed
  edges, area strictly shrunk/grown) and throws precise errors
  (`offset-self-intersects`, `offset-collapses`) instead of returning
  wrong geometry.
- `hollowExtrusion({ profile, depth, thickness })` — watertight hollow
  prism: outer skin (extrude winding), cavity walls (reversed), and
  annular bottom/top caps as quad strips between the two rings. The
  miter offset preserves the vertex count, so no polygon-with-hole
  triangulation is needed.
- Volume identity **V = depth · (A_outer − A_inner)** asserted exactly
  (rect and L profiles) plus watertightness; `hollowMetrics` exposes
  the closed-form for UI reports.

## 3. Multi-section loft (`src/modules/solid-kernel/loft.ts`)

`loftSections({ sections, height, levels? })` connects N ≥ 2 closed
sections with ruled side bands and capped ends. Section correspondence
shares `blend`'s polar-angle resampling (now exported from forms.ts), so:
- a **2-section loft is volume-identical to `blend`** (1e-9, tested),
- identical sections give the exact prism volume area × span,
- `levels` places sections at explicit z-levels (strictly increasing,
  validated) — `height` is ignored when levels are given.

## 4. UI wiring (every function has a button)

Edit ▸ **Solid Forms** ribbon group gains four buttons:

| Button | Dialog | Engine functions |
|--------|--------|------------------|
| **Bool (Any)** | operation select (union/intersect/subtract) + box vs two-leg L inputs; report shows kernel volume vs closed-form expectation and watertightness | `generalBoolean`, `fuseAll` |
| **Shell** | profile + depth + thickness; report shows outer/inner areas, kernel vs closed-form volume | `hollowExtrusion`, `hollowMetrics` |
| **Loft N** | 2–3 sections + height or explicit levels | `loftSections` |
| **Fuse** | three overlapping cubes; kernel vs closed-form volume | `fuseAll` |

`window.__obsSolids` exposes the full general kernel
(`generalBoolean`, `generalUnion`, `generalIntersect`, `generalSubtract`,
`fuseAll`, `weldMesh`, `hollowExtrusion`, `hollowMetrics`,
`offsetClosedRing`, `loftSections`) next to the v0.68 API, so console,
automation and AI tools reach the same functions the buttons do.
`validateLastSolid` now welds before counting (boolean outputs are
polygon soups; form outputs are unaffected).

## 5. Registers (spec §2 discipline)

**Evidence classification.** Everything in v0.70 is **level E** (proposed
engine behavior, verified against closed forms by automated tests). No
claim in this repository is "verified against Revit" — no Revit
installation is attached (inherited from the v0.68 registers).

**Deviation register additions:**

- **D-8 — tangential contact.** Edge/point touching without crossing is
  resolved at the classification tolerance (1e-6 m probe), not exactly.
  Geometrically exact for the BIM configurations tested; documented.
- **D-9 — sliver cells.** Cells below 1e-12 m² are dropped as
  measure-zero noise (they carry no volume and no topology).
- **D-10 — A-owned coplanar overlap skins.** union(A,B) and union(B,A)
  produce the same shape with different triangulations of the overlap
  band (A owns it). Shape, volume and watertightness are identical.
- **D-11 — cost.** The kernel is O(T_A·T_B) fragment splits plus one
  robust inside test per fragment — intended for BIM-scale solids
  (hundreds to low thousands of triangles), not meshing-scale work.
- **D-12 — compound results.** Disjoint inputs produce a valid compound
  mesh (two shells in one buffer); `validateMeshDiagnostics` accepts it,
  consumers that need single shells should filter by connectivity.

**Assumption register additions:**

- **A-8** — operand meshes are outward-wound watertight solids (the
  platform's form generators guarantee this; inputs are trusted at
  kernel level, `validateMeshDiagnostics` remains the gate).
- **A-9** — shell offsets stay in the miter-valid regime (no
  self-intersection, no edge collapse); violations throw instead of
  producing self-intersecting geometry.

## 6. CI

- `tests/v70-deep-modeling.test.cjs` (23 closed-form tests) wired as
  `npm run test:v70` in the Unit tests workflow.
- `scripts/verify-v70.mjs` (32 shape checks) wired as
  `npm run verify:v70` in the Unit tests workflow.
- Version 0.70.0; `package-lock.json` re-synced.
