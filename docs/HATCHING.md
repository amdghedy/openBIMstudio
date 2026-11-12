# HATCH 2.0 — pattern hatching and pick-point boundary detection

The 2D Drawing Editor hatches like a production CAD tool: pick a point inside
any enclosed area and the boundary is found for you, filled with real
ANSI/ISO-style pattern definitions that survive DXF/DWG round trips.

## Commands

| Command | Aliases | What it does |
|---------|---------|--------------|
| `HATCH` | `H`, `BHATCH` | Opens the Hatch & Boundaries panel and starts the pick. Click inside a fully enclosed area (boundary detected) or pick a closed polyline directly. Pick a hatched object again to remove its hatch. |
| `HATCH <pattern> [scale] [angle]` | | Presets the pattern from the command line and starts the pick — the agent-friendly form (`HATCH ANSI31 2 45`). |
| `HATCH PANEL` | | Opens the pattern panel only. |
| `BOUNDARY` | `BPOLY` | Same detection, no fill: the outline becomes a closed polyline on the current layer (area + perimeter are logged). |
| `HATCHEDIT` | `HE` | Applies the current panel pattern/scale/angle to the selected hatches. |
| `HATCHEDIT <pattern> [scale] [angle]` | | Presets and restyles in one step. |
| `HATCHEDIT REMOVE` | | Strips the hatch from the selected objects. |

## How boundary detection works

Two tiers, both pure functions in `src/modules/drawings/hatch-boundary.ts`:

1. **Enclosing entity (tier 1).** Every closed object (closed polyline,
   circle, …) whose polygon contains the seed point is a candidate; the
   smallest by area wins. Instant and exact — a circle is used as its own
   true shape (polygonised to 72 segments only when it must share the
   segment machinery).
2. **Traced region (tier 2).** When no closed object contains the point, the
   region is formed by *open* entities (four loose wall lines, a crossing
   partition). Every visible LINE / polyline edge / arc is a segment; the
   segments are split at every crossing into atomic edges, endpoints are
   quantised on a gap grid so nearly-touching corners close, and the face
   containing the seed is walked with the standard planar rule — the next
   edge is the first neighbour CCW after the reverse edge. Both orientations
   of the first hit edge (found by casting 16 rays) are walked, only loops
   that really contain the seed are kept, and the smallest wins.

Text, MTEXT, POINT and infinite RAY/XLINE entities never bound a hatch —
like native CAD.

## The pattern library

`src/modules/drawings/hatch-patterns.ts` defines SOLID + 12 patterns as real
DXF pattern-line families (angle, base, offset, dash motif) — the same codes
the DXF HATCH entity writes (53/43/44/45/46/49, with the hatch's own angle 52
and scale 41 applied on top):

| Pattern | Look | Families |
|---------|------|----------|
| ANSI31 | iron / brick — single 45° | 1 × 45° @ 3.175 |
| ANSI32 | steel — 45° pairs + 135° | 3 |
| ANSI33 | bronze — 45° dash-dot | dashes 3.175/1.5875/0.79/1.5875 |
| ANSI34 | rubber — tight 45° pairs | 2 |
| ANSI35 | insulation — long-dash two-dot | 1 |
| ANSI36 | refractory — dense dashed 45° | 1 |
| ANSI37 | glass / stone — 45°+135° cross | 2 @ 4.7625 |
| ANSI38 | zinc — dashed cross | 2 |
| NET | 0°/90° square grid | 2 @ 6.35 |
| CROSS | sparse diagonal cross | 2 @ 12.7 |
| DOTS | dot grid (zero-length dashes) | 2 |
| EARTH | soil — heavy dash + dots | 2 |

Spacings follow the classic ANSI inch grid expressed in millimetres
(0.125" = 3.175 mm). Predefined pattern names (group 76 = 1) are resolved by
native CAD from its own acad.pat, so these definitions drive our renderer and
our exported files look right everywhere; they approximate the standard look
and are not byte-identical copies of AutoCAD's definitions.

## Panel, picking, editing

- The **Hatch & Boundaries panel** (draggable dock, `obs-hatch-panel`) shows
  one tile per pattern whose preview is drawn by the same
  `hatchPatternLineSegments` generator the canvas uses — what you see in the
  tile is what the drawing gets. Scale / angle fields, *Pick inside an
  area*, *Boundary only*, *Edit hatch*, *Remove hatch*. Settings persist in
  `localStorage["obs.cad.hatchDefaults"]`.
- **Hatches pick on their fill**: a click inside a closed hatch's loops is a
  hit at 0.75·tol (`hatchFillHit` in viewer-math) — a line under the cursor
  still wins, an edge hit beats the fill.
- The panel, the ribbon (Home › Draw II: Hatch / Boundary / HatchEdit /
  Hatch Panel), the command palette and the command line all share one
  dispatcher flow, so AI agents (Agent Bridge) drive hatching with the same
  `HATCH ANSI31 2 45` strings a human types.

## Honest limits (v1)

- **Islands / holes**: a traced region fills over anything inside it (the
  face walk returns the outer loop only). Hatching with a hole: hatch the
  outer object and the island object separately, or BOUNDARY + edit.
- **Face tracing caps at 2,500 open segments** — larger drawings get an
  explicit message and should hatch from closed objects instead.
- **Boundary gaps** tighter than the quantisation grid (≈ 10⁻⁶ × scene size)
  close automatically; wider gaps keep the region open, like native CAD's
  default gap tolerance of 0.
- Patterns approximate the ANSI/ISO look (see above); gradient fills are not
  part of v1.
- The detected/traced boundary polyline is a real entity — it participates in
  selection, DATAEXTRACT and layers like any polyline (native "retain
  boundaries" behaviour).

## Verification

`tests/hatch-engine.test.cjs` (`npm run test:hatch-engine`, 23 checks): pattern
library + transform math; tier-1 nested rectangles and circle area; tier-2
room tracing, wall-to-wall split, shared-wall rooms, open-floor rejection and
the complexity cap; the DXF patternSpace round trip through the real
writer/reader; the drawing-space export at angle 0 / scale 1; inside-fill
picking; and the full wiring (catalog, dispatcher, tool flow, panel, ribbon,
act map, command palette, package.json script).
