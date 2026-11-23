# CAD performance baseline (Phase 5)

Measured with `bench/cad-perf-suite.cjs` (seeded, repeatable) on Intel(R) Xeon(R) Processor @ 2.30GHz, Node v22.23.5, one run, sandbox VM — **indicative, not a CI gate**. Latencies are p50 / p95 in ms.

Mix: 60% LINE, 20% CIRCLE, 10% ARC, 10% LWPOLYLINE, uniform in a 10 000 × 10 000 area, 20 layers. Pick/snap tolerance 8 units, so most random probes miss (sparse drawing); window selects are 1% and 0.01% of the area.

| entities | bbox pass (ms) | index build (ms) | heap (MB) | window 1% | window 0.01% | pick | snap | 1 edit: full rebuild | 1 add: incremental | 20 undo snapshots (MB) |
|---|---|---|---|---|---|---|---|---|---|---|
| 10,000 | 8.2 | 8.4 | 5 | 0.047 / 0.116 | 0.001 / 0.002 | 0.001 / 0.003 | 0.001 / 0.004 | 3.163 | 0.001 / 0.012 | 2 |
| 100,000 | 13.2 | 51 | 44 | 0.401 / 0.603 | 0.007 / 0.011 | 0.003 / 0.007 | 0.003 / 0.008 | 65.17 | 0.001 / 0.002 | 15 |
| 1,000,000 | 108.4 | 1051.7 | 291 | 5.894 / 9.5 | 0.084 / 0.133 | 0.023 / 0.041 | 0.029 / 0.054 | 829.05 | 0.001 / 0.001 | 153 |

DXF text round trip (writer → reader), where run:

| entities | write (ms) | parse (ms) | DXF size (MB) |
|---|---|---|---|
| 10,000 | 29 | 70 | 1.3 |
| 100,000 | 260 | 607 | 13.4 |

## What this shows

- Window selection, pick and snap are cell-index lookups and stay sub-millisecond up to 1 M entities for typical (small) windows; a 1%-area window at 1 M costs ≈5 ms.
- **Finding (fixed here):** every `addEntities` call rebuilt the whole index — ≈0.83 s per drawn object at 1 M entities (65 ms at 100 k). Appends now go through `indexAppend` (O(added), p50 ≈ 0.001 ms; the 33 ms max at 1 M is a one-off GC pause) and fall back to a rebuild only when an entity leaves the index frame. Deletes and modifications still rebuild (indices shift) — that remains the next incremental-index gap.
- Undo stores whole-array snapshots in this proxy: 20 steps cost ≈153 MB at 1 M entities. The editor's real undo stack stores per-action deltas, so this is an upper bound for a snapshot design, not a measurement of the editor.

## Not measured (honest)

- Redraw / frame time and viewport interaction (needs a browser; not run here).
- Real editor undo/redo memory and DXF/DWG open/save at 1 M entities (string/heap limits; 10 k and 100 k DXF only).
- DWG open/save and export formats.
- 20 000 block references: see `bench/block-refs-bench.cjs` on the native-blocks branch (single run, results in CAD2D-GAP-AUDIT §6).
- These are single runs on a shared VM; p95 values over few samples (rebuild: 1–3 samples) are not statistically meaningful.
