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
    evidence: ["tests/dwg-reader-isolation.test.cjs"],
    limitations: [
      "DWG version coverage per LibreDWG WASM (@mlightcad/libredwg-web); fixtures verified AC1009/AC1015/AC1024/AC1032",
      "Reader runs in an isolated worker: LibreDWG embind needs dynamic invoker generation, forbidden by the main-document CSP (no 'unsafe-eval')",
      "Model-level DWG export unavailable; import-only",
    ],
    affirmedIn: APP_VERSION,
  },
  {
    id: "dwg-export",
    area: "Interoperability",
    status: "unavailable",
    source: [],
    evidence: ["tests/dependency-safety.test.cjs"],
    limitations: [
      "The former fake ExportDWGCommand stub was removed (remediation Stage 1); DWG export is not implemented and must not be advertised — the drawing export command offers DXF",
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
    source: ["src/features/clash-engine.ts", "src/workers/clash.worker.ts"],
    evidence: ["tests/"],
    limitations: ["Worker cancellation not yet implemented (Phase 6)"],
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
    source: ["src/features/ai-providers.ts", "src/features/ai-privacy.ts"],
    evidence: ["tests/"],
    limitations: [
      "Cloud providers receive redacted prompts by design; local providers (Ollama) use a separate path",
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
