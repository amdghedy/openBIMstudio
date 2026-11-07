/**
 * Feature maturity registry (remediation program Phase 2 — product truth).
 *
 * This file is the single machine-readable source for what the platform
 * actually supports, how well, and with which verified boundaries. It mirrors
 * and is drift-tested against `docs/engineering/BASELINE.md` §9 and the
 * honest labels surfaced in `docs/COMPATIBILITY.md`.
 *
 * Rules (BASELINE §11):
 *  - `verified`     = implemented + runtime-verified by the referenced tests.
 *  - `limited`      = implemented with documented boundaries.
 *  - `experimental` = present but not fully hardened; not for production data.
 *  - `unavailable`  = honestly labelled absence (no stubs, no fake success).
 *  - `planned`      = scoped by the remediation program, not yet started.
 *  - `limited` / `experimental` / `unavailable` entries MUST document at
 *    least one limitation; `verified` entries SHOULD document residual ones.
 *  - Every `source` and `evidence` path must exist (drift test).
 *
 * The drift test lives in `tests/feature-registry.test.cjs`.
 */
import { APP_VERSION } from "../version";

export type MaturityStatus =
  | "verified"
  | "limited"
  | "experimental"
  | "unavailable"
  | "planned";

export interface FeatureMaturityEntry {
  id: string;
  area: string;
  status: MaturityStatus;
  /** Code paths that implement the feature (repo-root relative). */
  source: string[];
  /** Test suites / verify scripts that runtime-verify the status. */
  evidence: string[];
  /** Honest, user-visible boundaries. */
  limitations: string[];
  /** App version when this status was last affirmed with evidence. */
  affirmedIn: string;
}

export const MATURITY_STATUSES: readonly MaturityStatus[] = [
  "verified",
  "limited",
  "experimental",
  "unavailable",
  "planned",
] as const;

export const FEATURE_MATURITY: readonly FeatureMaturityEntry[] = [
  {
    id: "authoring-tools",
    area: "Modeling",
    status: "verified",
    source: ["src/features/authoring.ts"],
    evidence: ["tests/", "npm run verify:v68", "npm run verify:v73"],
    limitations: [
      "Doors/windows host only on walls authored in-app (not arbitrary linked-geometry hosts)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "modeling-panel",
    area: "Modeling",
    status: "verified",
    source: [
      "src/features/tool-panels.ts",
      "src/features/property-palette.ts",
      "src/modules/justification/index.ts",
      "src/modules/snapping/magnetic.ts",
    ],
    evidence: ["tests/", "npm run verify:v73"],
    limitations: [
      "Tangent snap not applicable (no arc-based elements yet)",
      "Rotation propagation reports registry updates rather than re-solving all dependents",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "modify-engine",
    area: "Modeling",
    status: "verified",
    source: ["src/modules/modify/"],
    evidence: ["tests/", "npm run verify:v71"],
    limitations: [
      "Covers move/copy/rotate/mirror/array/offset and modify Group 1; remaining modify groups are separate deliveries",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "viewcube-navigation",
    area: "Navigation",
    status: "verified",
    source: ["src/modules/navigation/", "src/features/viewcube.ts"],
    evidence: ["tests/", "npm run verify:v72"],
    limitations: [
      "Home views are per-browser (localStorage), not synced through collaboration",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "solid-kernel",
    area: "Modeling",
    status: "verified",
    source: ["src/modules/solid-kernel/"],
    evidence: ["tests/"],
    limitations: [
      "Boolean robustness documented for the v70 test corpus; pathological inputs may still require verification per case",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "ifc-import-export",
    area: "Interoperability",
    status: "limited",
    source: ["src/features/importer.ts", "src/modules/export/native-twin-ifc.ts"],
    evidence: ["tests/", "docs/CSP.md (end-to-end import verified under CSP, v0.74.0)"],
    limitations: [
      "Schema coverage per web-ifc 0.0.77 (IFC2x3/IFC4); no per-entity interop report yet (Phase 4)",
      "Round-trip fidelity measured only for the native-twin path, not arbitrary third-party IFC",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "dxf-import-export",
    area: "Interoperability",
    status: "limited",
    source: ["src/modules/drawings/dxf-reader.ts", "src/modules/drawings/dxf-writer.ts"],
    evidence: ["tests/"],
    limitations: ["2D drawing scope; unsupported entities are reported, not silently dropped"],
    affirmedIn: APP_VERSION,
  },
  {
    id: "dwg-import",
    area: "Interoperability",
    status: "limited",
    source: ["src/modules/drawings/dwg-engine.ts", "src/modules/cad-link/index.ts", "src/modules/cad-link/dwg-reader-worker.ts"],
    evidence: ["tests/dwg-reader-isolation.test.cjs", "tests/cad-dwg-roundtrip.test.cjs"],
    limitations: [
      "DWG version coverage per LibreDWG WASM (@mlightcad/libredwg-web); fixtures verified AC1009/AC1015/AC1024/AC1032",
      "Reader runs in an isolated worker: LibreDWG embind needs dynamic invoker generation, forbidden by the main-document CSP (no 'unsafe-eval')",
      "Entity types the reader cannot map (for example SHAPE and ATTDEF in old R11 files) are counted and reported as skipped, not imported; see the DWG export entry for the write side",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "dwg-export",
    area: "Interoperability",
    status: "limited",
    source: [
      "src/features/cad-viewer.ts",
      "src/modules/drawings/acad-engine.ts",
      "src/modules/drawings/dxf-writer.ts",
      "cad-engine-rust/src/lib.rs",
    ],
    evidence: ["tests/cad-dwg-roundtrip.test.cjs", "tests/cad-dwg-export.test.cjs", "tests/cad-acad-engine.test.cjs"],
    limitations: [
      "Local DXF-to-DWG conversion through acadrust (MPL-2.0); no paid SDK, remote service or API key",
      "Verified by reading the written DWG back with the same engine (hatch fills, linetypes, lineweights, true colour, layer state, text styles, the first paper-space sheet with its viewports, all six offered versions, and the repo's DWG fixtures). No file has been opened in AutoCAD, so Autodesk compatibility is unverified; the round-trip test passes in CI",
      "Version choice (DWGVERSION): AutoCAD 2000 to 2018 and later; 2000 converts true colour to the nearest AutoCAD colour index",
      "Blocks are written exploded and wipeouts as outlines; every paper-space sheet is written (with its viewports) but sheet names are not kept in DWG, and plain DXF still saves only the first sheet; dimension styles may be simplified",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "aps-conversion",
    area: "Interoperability",
    status: "experimental",
    source: ["server/index.mjs", "src/services/rfaImport.ts", "src/services/bimRoundTrip.ts"],
    evidence: ["tests/server-hardening.test.cjs"],
    limitations: [
      "Requires user-configured Autodesk Platform Services credentials; model files are uploaded to APS by explicit user action only",
      "UX flow and failure states still being completed (Phase 3)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "bcf-21",
    area: "Interoperability",
    status: "limited",
    source: ["src/modules/issues/bcf.ts", "src/modules/export/bcf21.ts"],
    evidence: ["tests/"],
    limitations: ["Two-application round-trip validation pending (Phase 4 fixtures)"],
    affirmedIn: APP_VERSION,
  },
  {
    id: "ids-audit",
    area: "Interoperability",
    status: "limited",
    source: ["src/features/ids.ts", "src/features/ids-panel.ts"],
    evidence: ["tests/"],
    limitations: ["Unsupported IDS facets are not yet itemised per spec (Phase 4)"],
    affirmedIn: APP_VERSION,
  },
  {
    id: "sheets-views-pdf",
    area: "Documentation",
    status: "limited",
    source: ["src/modules/views/", "src/modules/export/pdf.ts", "src/modules/export/sheet-pdf.ts"],
    evidence: ["tests/"],
    limitations: ["Sheet composition covers the v M3 scope; not a full CAD sheet editor"],
    affirmedIn: APP_VERSION,
  },
  {
    id: "schedules-cost",
    area: "Documentation",
    status: "limited",
    source: ["src/modules/schedules/", "src/modules/cost/"],
    evidence: ["tests/"],
    limitations: ["Quantity take-off relies on element parameters, not true 5D rules engine"],
    affirmedIn: APP_VERSION,
  },
  {
    id: "p6-4d-5d-6d",
    area: "Analysis",
    status: "experimental",
    source: ["src/modules/schedule-4d/", "src/modules/timeline/", "src/features/timeline-panel.ts"],
    evidence: ["tests/schedule-4d.test.cjs"],
    limitations: [
      "P6 import covers XER and PMXML activities, WBS, relationships and resource-assigned cost; calendars, resource loading and baselines are not read",
      "Activity-to-element links use element properties (activityId, wbs) or name/level vocabulary; only authored elements are linked, imported IFC objects are not yet",
      "6D carbon uses generic indicative factors (editable) - not project EPDs",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "clash-detection",
    area: "Analysis",
    status: "limited",
    source: [
      "src/features/clash-engine.ts",
      "src/features/clash-authored.ts",
      "src/modules/clash/clash-core.ts",
      "src/modules/clash/mesh-queries.ts",
      "src/modules/clash/selection-plan.ts",
      "src/workers/clash.worker.ts",
    ],
    evidence: ["tests/clash-engine.test.cjs", "tests/clash-selection-plan.test.cjs", "tests/clash-review-dock.test.cjs"],
    limitations: [
      "Pair maths (surface crossing, element fully inside another, touching within tolerance, clearance, A-vs-B selection inside one model, across models and linked models) is tested on real triangle meshes in Node; the panel, IFC loading and linked-model placement have not been run in a browser against real files",
      "Containment and inside tests assume closed solids; open or badly modelled meshes can be mis-judged",
      "Elements with no usable geometry, or more than 120,000 triangles, are tested by bounding box only (may over-report); the status line counts them",
      "Hard clash ignores contact up to the tolerance (default 5 mm): a wall resting on a slab is 'touching', not a clash",
      "Native (authored) elements are tested from their render meshes; hidden ones are still included",
      "Clashes cannot be guaranteed 100% complete: the report states how many elements were tested and which were not",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "collaboration",
    area: "Platform",
    status: "limited",
    source: ["server/index.mjs", "src/modules/collaboration/realtime-client.ts"],
    evidence: ["tests/server-hardening.test.cjs", "tests/server-security.test.cjs"],
    limitations: [
      "Persistence is whole-file JSON, not transactional (Phase 5)",
      "Conflict semantics are last-writer-wins via Yjs updates; no formal CRDT guarantee audit",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "ai-assistant",
    area: "Platform",
    status: "limited",
    source: ["src/features/ai-providers.ts", "src/features/ai-privacy.ts", "src/features/anthropic-messages.ts", "src/features/ai-presets.ts"],
    evidence: ["tests/ai-privacy.test.cjs", "tests/anthropic-messages.test.cjs", "tests/ai-presets.test.cjs"],
    limitations: [
      "Cloud providers receive redacted prompts by design; local providers (Ollama) use a separate path",
      "Claude uses the user's own Anthropic API key (billed to their account); a Claude.ai free/Pro login is not an API credential and cannot be used. Request/stream mapping is unit-tested but has not been run against the live Anthropic API",
      "Custom endpoint URLs require deployment-side CSP extension (docs/CSP.md)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "plugin-system",
    area: "Platform",
    status: "limited",
    source: ["src/plugins/loader.ts", "src/plugins/api.ts", "src/plugins/types.ts"],
    evidence: ["tests/plugins-api.test.cjs"],
    limitations: [
      "Plugins are same-origin trusted code — no sandbox (documented trust model, docs/PLUGIN_SDK.md)",
      "Manifest integrity pins are optional and enforced only when declared",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "encrypted-projects",
    area: "Platform",
    status: "verified",
    source: ["src/modules/projects/project-crypto.ts"],
    evidence: ["tests/"],
    limitations: [],
    affirmedIn: APP_VERSION,
  },
  {
    id: "web-security",
    area: "Platform",
    status: "verified",
    source: ["index.html", "docs/CSP.md", "server/security.mjs"],
    evidence: ["tests/dependency-safety.test.cjs", "docs/engineering/BASELINE.md §12 (v0.74.0 boot verification)"],
    limitations: [
      "Static CSP cannot enumerate user-supplied custom endpoint hosts (documented workaround)",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "pwa-offline",
    area: "Platform",
    status: "limited",
    source: ["public/sw.js", "vite.config.ts"],
    evidence: ["tests/"],
    limitations: [
      "Offline precache covers built assets; no automated browser E2E of offline flows yet (Phase 7)",
      "Runtime-fetched wasm assets (web-ifc) require a full cache refresh on re-pin — see BASELINE §12 v0.74.0",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "performance-budgets",
    area: "Platform",
    status: "planned",
    source: [],
    evidence: ["docs/engineering/BASELINE.md §5"],
    limitations: ["Large-model performance budgets and benchmarks are Phase 6 scope"],
    affirmedIn: APP_VERSION,
  },
  {
    id: "native-joins",
    area: "Modeling",
    status: "limited",
    source: ["src/modules/native-bim/linear-follow.ts", "src/features/authoring.ts"],
    evidence: ["tests/magnet.test.cjs"],
    limitations: [
      "Join/follow planning is unit-tested as pure logic; interactive behaviour has not been browser-tested",
      "Applies to straight linear elements (walls, beams, strips, ducts, pipes, trays, conduits); arcs are not joined",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "wall-sweeps",
    area: "Modeling",
    status: "limited",
    source: ["src/modules/wall-sweeps/geometry.ts", "src/features/authoring.ts"],
    evidence: ["tests/ui-honesty.test.cjs", "tests/wall-sweep-ifc.test.cjs", "tests/wall-reveal-cutter.test.cjs"],
    limitations: [
      "Built-in profiles only (baseboard, cornice, wainscot, reveal); no custom profile editor",
      "Baseboards, cornices and wainscots export to IFC as IfcCovering (tessellated); the IFC export has not been opened in a third-party viewer",
      "Reveals are cut into straight walls with the same CSG used for door openings and export to IFC as IfcOpeningElement (RECESS); curved walls do not get reveals, and the cut has not been checked on screen or in a third-party viewer",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "shortcut-editor",
    area: "Interface",
    status: "limited",
    source: ["src/features/shortcut-editor.ts", "src/modules/shortcuts/shortcut-keys.ts", "src/features/shortcuts.ts"],
    evidence: ["tests/shortcut-keys.test.cjs", "tests/shortcut-sequences.test.cjs"],
    limitations: [
      "Key matching is unit-tested; the editor window itself has not been browser-tested",
      "Sequences of up to three letters; typing speed window is fixed",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "cad-wall-detection",
    area: "Linking",
    status: "experimental",
    source: ["src/modules/cad-link/wall-detect.ts", "src/features/ai-tools.ts"],
    evidence: ["tests/wall-detect.test.cjs"],
    limitations: [
      "Works from line geometry on wall-like layers; hatches, blocks and xrefs are not interpreted",
      "Curved walls are not detected; results need review before use",
      "Capped at 3000 walls per run; tested on synthetic drawings only",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "point-cloud-linking",
    area: "Linking",
    status: "limited",
    source: ["src/modules/point-cloud/parsers.ts", "src/features/link-tools.ts"],
    evidence: ["tests/point-cloud-parsers.test.cjs"],
    limitations: [
      "Reads PLY, XYZ, PTS, PCD, LAS (1.0-1.4) and PTX",
      "LAZ, E57, RCP/RCS, RWCX and FLS cannot be decoded in a browser; export to LAS or E57-to-LAS first",
      "Whole cloud is loaded in memory; no level-of-detail streaming for very large scans",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "cad-insert-tab",
    area: "Drawings",
    status: "experimental",
    source: [
      "src/modules/drawings/cad-blocks.ts",
      "src/modules/drawings/svg-import.ts",
      "src/modules/drawings/cad-fields.ts",
      "src/features/cad-viewer.ts",
    ],
    evidence: ["tests/cad-insert.test.cjs"],
    limitations: [
      "Block, insert, scale/rotation, write-block, SVG flattening and field maths are unit-tested; the dialogs, ghost placement and ribbon have not been run in a browser",
      "Inserted blocks are ordinary editable copies (like INSERT then EXPLODE): there is no block-reference identity, redefinition, attributes, dynamic blocks or non-uniform scale",
      "The block library is shared by all drawings in this browser and is not written into saved DWG / DXF files",
      "SVG import flattens curves to polylines; text, images, gradients, clip paths and <use> are skipped and reported",
      "Fields are evaluated once when inserted and do not update afterwards",
      "Not available: raster image attach, XREF / underlays, PDF import, point clouds, hyperlinks, data links, OLE",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "cad-editor-styles",
    area: "Drawings",
    status: "limited",
    source: [
      "src/modules/drawings/cad-styles.ts",
      "src/features/cad-style-ui.ts",
      "src/modules/drawings/dxf-writer.ts",
      "src/features/cad-viewer.ts",
    ],
    evidence: ["tests/cad-styles.test.cjs", "tests/cad-save.test.cjs", "tests/cad-hatch-save.test.cjs", "tests/cad-layout-save.test.cjs"],
    limitations: [
      "DXF write/read round trip (linetypes, lineweights, true colour, text font/style/anchor, layer lock/off) is tested; the editing dialogs have not been browser-tested",
      "Fonts are system fonts; SHX stroke fonts are drawn with a similar-looking font on screen and keep their names in saved DXF files",
      "Linetypes are dash/dot patterns only; complex linetypes with embedded text or shapes are not supported",
      "Saved DXF keeps solid and patterned hatches (pattern lines are written only when the file provided them, so a pattern known only by name may need the receiving program to supply it); blocks are saved exploded, wipeouts as outlines, and only the first paper-space layout (with its viewports) is saved, with a notice for the rest; plot/PDF output has not been verified to honour per-object lineweights",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "plan-command-line",
    area: "Drawings",
    status: "limited",
    source: [
      "src/modules/plan/plan-commands.ts",
      "src/features/plan-command-line.ts",
      "src/features/plan-view-panel.ts",
    ],
    evidence: ["tests/plan-commands.test.cjs"],
    limitations: [
      "Command table, aliases and coordinate parsing (x,z  @dx,dz  d<angle  length) are unit-tested; the command line and Esc cancel-all have not been tried in a browser",
      "Direct coordinates are metres and only drive Place tools (linear paths and point elements), not dimensions, tags or Move",
      "Esc no longer closes the plan view; use the Close button or the CLOSE command",
      "SELECTALL and box selection pick authored elements on every level, not only the level shown in the plan",
    ],
    affirmedIn: APP_VERSION,
  },
] as const;

/** Look up a feature's maturity by id. */
export function getFeatureMaturity(id: string): FeatureMaturityEntry | undefined {
  return FEATURE_MATURITY.find((f) => f.id === id);
}

/** Features grouped by their area label (order of first appearance). */
export function featureAreas(): { area: string; features: FeatureMaturityEntry[] }[] {
  const areas: { area: string; features: FeatureMaturityEntry[] }[] = [];
  for (const f of FEATURE_MATURITY) {
    let bucket = areas.find((a) => a.area === f.area);
    if (!bucket) {
      bucket = { area: f.area, features: [] };
      areas.push(bucket);
    }
    bucket.features.push(f);
  }
  return areas;
}
