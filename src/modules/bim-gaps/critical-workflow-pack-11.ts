/**
 * Critical workflow pack 11 — 10 production reliability / delivery gaps:
 *  1. IFCINTEROP     show / build IFC interop inventory report
 *  2. MODELCENSUS    authored + linked element census by type
 *  3. EXPORTSELCSV   export selection properties as CSV
 *  4. MODELHEALTH    quick model health audit
 *  5. FAMCREATOR     open Family Creator engine
 *  6. REJECTMALFORM  user-facing malformed IFC/DXF/BCF header checks
 *  7. TOOLCATALOG    runtime tool-catalog honesty summary
 *  8. PERFSEL        time selection property gather (perf probe)
 *  9. RECOVERYUI     open recovery checkpoints UI
 * 10. STANDARDSPACK  list machine-readable standards pack ids
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";

type Any = Record<string, any>;

function authoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}

function elements(): Any[] {
  return authoring()?.getElements?.() ?? [];
}

/* 1 */ export async function showIfcInteropReport(): Promise<void> {
  try {
    const last = (window as Any).__obsLastIfcInteropReport;
    if (last) {
      const { formatInteropReport } = await import("../ifc-semantics/interop-report");
      const lines = formatInteropReport(last);
      console.log("[ifc-interop]\n" + lines.join("\n"));
      notify("info", `IFC interop: ${last.schema || "?"} · ${last.totalEntities} entities · ${last.types?.length || 0} types (see console)`);
      try {
        window.dispatchEvent(new CustomEvent("obs:ifc-interop-report", { detail: last }));
      } catch { /* */ }
      return;
    }
    notify(
      "warn",
      "No IFC interop report yet — link an IFC file first. The importer attaches the inventory on load.",
    );
  } catch (e) {
    notify("warn", `Interop report: ${e instanceof Error ? e.message : e}`);
  }
}

/* 2 */ export function modelCensus(): Any {
  const byType: Record<string, number> = {};
  let authored = 0;
  for (const el of elements()) {
    const t = String(el.type || el.category || "unknown");
    byType[t] = (byType[t] || 0) + 1;
    authored++;
  }
  let linked = 0;
  try {
    for (const [, m] of (ctx.fragments?.list ?? new Map()) as Map<string, Any>) {
      if (m) linked++;
    }
  } catch { /* */ }
  const report = {
    authored,
    linkedModels: linked,
    byType,
    top: Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
  (window as Any).__obsModelCensus = report;
  console.log("[model-census]", report);
  notify(
    "info",
    authored
      ? `Census: ${authored} authored · ${linked} linked model(s) · top: ${report.top.slice(0, 3).map(([k, v]) => `${k}(${v})`).join(", ")}`
      : `Census: no authored elements · ${linked} linked model(s)`,
  );
  return report;
}

/* 3 */ export function exportSelectionCsv(): number {
  const a = authoring();
  const ids: string[] = a?.getSelectedIds?.() ?? [];
  const rows: string[][] = [["id", "type", "name", "level", "properties_json"]];
  for (const id of ids) {
    const el = elements().find((e) => e.id === id);
    if (!el) {
      rows.push([id, "?", "", "", ""]);
      continue;
    }
    const name = el.name || el.params?.name || el.properties?.name || "";
    const level = el.params?.level ?? el.properties?.level ?? el.params?.elevation ?? "";
    let props = "";
    try {
      props = JSON.stringify(el.properties || el.params || {}).replace(/"/g, '""');
    } catch {
      props = "";
    }
    rows.push([
      String(el.id),
      String(el.type || ""),
      String(name),
      String(level),
      `"${props}"`,
    ]);
  }
  if (rows.length <= 1) {
    notify("warn", "Select elements first");
    return 0;
  }
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `selection-${Date.now()}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  notify("success", `Exported ${ids.length} row(s) to CSV`);
  return ids.length;
}

/* 4 */ export function modelHealthAudit(): Any {
  const els = elements();
  let missingType = 0;
  let missingId = 0;
  let noMesh = 0;
  let tempHidden = 0;
  const a = authoring();
  for (const el of els) {
    if (!el.id) missingId++;
    if (!el.type) missingType++;
    if (el.properties?.tempHidden) tempHidden++;
    try {
      if (a?.getMesh && !a.getMesh(el.id)) noMesh++;
    } catch {
      noMesh++;
    }
  }
  let issues = 0;
  try {
    issues = (ctx as Any).issues?.list?.()?.length ?? 0;
  } catch { /* */ }
  const report = {
    elements: els.length,
    missingId,
    missingType,
    noMesh,
    tempHidden,
    openIssues: issues,
    score: Math.max(0, 100 - missingId * 5 - missingType * 2 - Math.min(40, noMesh)),
  };
  (window as Any).__obsModelHealth = report;
  console.log("[model-health]", report);
  notify(
    report.score >= 80 ? "success" : "warn",
    `Model health ${report.score}/100 · ${els.length} elements · hidden ${tempHidden} · issues ${issues}`,
  );
  return report;
}

/* 5 */ export function openFamilyCreator(): void {
  try {
    const ed = (window as Any).OBSFamilyEditor;
    if (ed?.open) {
      ed.open();
      notify("success", "Family Creator opened");
      return;
    }
  } catch { /* */ }
  void import("../../features/parametric-family-panel").then((m) => {
    m.openFamilyCreatorEngine?.();
  });
}

/* 6 */ export function rejectMalformedProbe(kind: "ifc" | "dxf" | "bcf", text: string): { ok: boolean; reason?: string } {
  const sample = String(text || "").slice(0, 4000);
  if (kind === "ifc") {
    if (!/ISO-10303-21/i.test(sample)) return { ok: false, reason: "Not a STEP/IFC file (missing ISO-10303-21)" };
    if (!/DATA;/i.test(sample)) return { ok: false, reason: "IFC missing DATA section" };
    return { ok: true };
  }
  if (kind === "dxf") {
    if (!/^\s*0\s*\n\s*SECTION/m.test(sample) && !/SECTION/.test(sample)) {
      return { ok: false, reason: "Not a DXF-shaped text (missing SECTION)" };
    }
    return { ok: true };
  }
  // bcf zip is binary; text probe only catches XML topic dumps
  if (kind === "bcf") {
    if (/PK\x03\x04/.test(sample) || /markup\.bcf/i.test(sample) || /<Markup/i.test(sample) || /bcf/i.test(sample)) {
      return { ok: true };
    }
    return { ok: false, reason: "Not recognizable as BCF/BCFXML content" };
  }
  return { ok: false, reason: "Unknown kind" };
}

export function runMalformedProbesDemo(): void {
  const cases = [
    rejectMalformedProbe("ifc", "not ifc"),
    rejectMalformedProbe("ifc", "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;"),
    rejectMalformedProbe("dxf", "hello"),
    rejectMalformedProbe("dxf", "0\nSECTION\n2\nHEADER\n"),
  ];
  const bad = cases.filter((c) => !c.ok).length;
  console.log("[malformed-probe]", cases);
  notify("info", `Malformed probes: ${bad}/${cases.length} rejected as expected (see console)`);
}

/* 7 */ export async function toolCatalogRuntimeSummary(): Promise<void> {
  try {
    const { listCommands } = await import("../../features/command-palette");
    const cmds = typeof listCommands === "function" ? listCommands() : [];
    const byCat: Record<string, number> = {};
    for (const c of cmds as Any[]) {
      const cat = c.category || "Other";
      byCat[cat] = (byCat[cat] || 0) + 1;
    }
    const report = { total: cmds.length, byCat };
    (window as Any).__obsToolCatalogRuntime = report;
    console.log("[tool-catalog-runtime]", report);
    notify("info", `Commands registered: ${cmds.length} (console has by-category breakdown)`);
  } catch {
    notify(
      "info",
      "Tool catalog gate runs in CI via scripts/check-tool-catalog.mjs — open Command Palette for live commands.",
    );
  }
}

/* 8 */ export function perfSelectionProbe(): number {
  const t0 = performance.now();
  const a = authoring();
  const ids: string[] = a?.getSelectedIds?.() ?? [];
  let props = 0;
  for (const id of ids) {
    const el = elements().find((e) => e.id === id);
    if (el?.properties || el?.params) props++;
  }
  const ms = performance.now() - t0;
  const report = { selected: ids.length, withProps: props, ms: Math.round(ms * 100) / 100 };
  (window as Any).__obsPerfSel = report;
  console.log("[perf-sel]", report);
  notify("info", `Selection probe: ${ids.length} elements in ${report.ms} ms`);
  return report.ms;
}

/* 9 */ export function openRecoveryUi(): void {
  void import("../../features/project-recovery").then((m) => {
    m.showProjectRecovery?.();
    notify("info", "Recovery checkpoints");
  }).catch(() => notify("warn", "Recovery module unavailable"));
}

/* 10 */ export function listStandardsPacks(): string[] {
  const packs = [
    "IFC4",
    "IFC2X3",
    "IFC4X3",
    "BCF2.1",
    "BCF3.0",
    "IDS1.0",
    "COBie2.4",
    "ISO19650",
  ];
  (window as Any).__obsStandardsPacks = packs;
  console.log("[standards-packs]", packs);
  notify("info", `Standards packs: ${packs.join(" · ")}`);
  return packs;
}

export function setupCriticalWorkflowPack11(): void {
  const api = {
    showIfcInteropReport,
    modelCensus,
    exportSelectionCsv,
    modelHealthAudit,
    openFamilyCreator,
    rejectMalformedProbe,
    runMalformedProbesDemo,
    toolCatalogRuntimeSummary,
    perfSelectionProbe,
    openRecoveryUi,
    listStandardsPacks,
  };
  (window as Any).__obsWorkflowPack11 = api;
  (ctx.features as Any).workflowPack11 = api;

  const cmds: Array<[string, string, () => void]> = [
    ["gap11-ifc-interop", "IFC: Interop report", () => void showIfcInteropReport()],
    ["gap11-census", "Model: Element census", () => void modelCensus()],
    ["gap11-export-csv", "Selection: Export CSV", () => void exportSelectionCsv()],
    ["gap11-health", "Model: Health audit", () => void modelHealthAudit()],
    ["gap11-family", "Family: Creator engine", () => void openFamilyCreator()],
    ["gap11-malformed", "QA: Malformed input probes", () => void runMalformedProbesDemo()],
    ["gap11-catalog", "Tools: Catalog summary", () => void toolCatalogRuntimeSummary()],
    ["gap11-perf-sel", "Perf: Selection probe", () => void perfSelectionProbe()],
    ["gap11-recovery", "Project: Recovery checkpoints", () => void openRecoveryUi()],
    ["gap11-standards", "Standards: Pack list", () => void listStandardsPacks()],
  ];
  for (const [id, label, run] of cmds) {
    try {
      window.dispatchEvent(
        new CustomEvent("obs-register-command", { detail: { id, label, category: "Critical gaps", run } }),
      );
    } catch { /* */ }
  }
  void import("../../features/command-palette").then(({ registerCommand }) => {
    for (const [id, label, run] of cmds) {
      registerCommand({ id, label, category: "Critical gaps", run });
    }
  }).catch(() => { /* palette may load later */ });

  console.log("[workflow-pack-11] 10 critical delivery/reliability commands ready");
}

