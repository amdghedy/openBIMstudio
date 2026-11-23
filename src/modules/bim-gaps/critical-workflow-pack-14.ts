/**
 * Pack 14 — 10 delivery / QA gaps:
 * 1. PROJECTSUMMARY  2. ELEMENTSEARCH  3. HIDEUNLOCKED  4. SHOWREVIEW
 * 5. GRIDREPORT  6. EXPORTCENSUS  7. RESETVIEW  8. TOGGLEWIRE
 * 9. DIAGNOSTICS  10. CLIPBOARDIDS
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";

type Any = Record<string, any>;
function auth(): Any | null { return (ctx.features as Any)?.authoring ?? null; }
function els(): Any[] { return auth()?.getElements?.() ?? []; }

export function projectSummary(): Any {
  const a = auth();
  const report = {
    elements: els().length,
    selected: a?.getSelectedIds?.()?.length ?? 0,
    levels: a?.getLevels?.()?.length ?? 0,
    grids: a?.getGrids?.()?.length ?? 0,
    tool: a?.getActiveTool?.() ?? null,
    level: a?.getLevel?.() ?? null,
  };
  (window as Any).__obsProjectSummary = report;
  console.log("[project-summary]", report);
  notify("info", `Elements ${report.elements} · sel ${report.selected} · levels ${report.levels} · grids ${report.grids}`);
  return report;
}

export function elementSearch(query?: string): number {
  const q = (query ?? prompt("Search name / type / id", "") ?? "").trim().toLowerCase();
  if (!q) return 0;
  const match = els().filter((e) => {
    const hay = `${e.id} ${e.name || ""} ${e.type || ""} ${e.category || ""}`.toLowerCase();
    return hay.includes(q);
  }).map((e) => e.id);
  try {
    auth()?.setSelection?.(match);
    auth()?.selectIds?.(match);
  } catch { /* */ }
  notify(match.length ? "success" : "warn", `Search “${q}”: ${match.length} hit(s)`);
  return match.length;
}

export function hideUnlocked(): number {
  const a = auth();
  let n = 0;
  for (const e of els()) {
    if (e.properties?.locked) continue;
    try {
      if (a?.setTempHidden) a.setTempHidden(e.id, true);
      else {
        if (!e.properties) e.properties = {};
        e.properties.tempHidden = true;
      }
      n++;
    } catch { /* */ }
  }
  try { a?.refreshVisibility?.(); } catch { /* */ }
  notify("success", `Hid ${n} unlocked element(s)`);
  return n;
}

export function selectReviewFlagged(): number {
  const match = els().filter((e) => e.properties?.reviewFlag).map((e) => e.id);
  try {
    auth()?.setSelection?.(match);
    auth()?.selectIds?.(match);
  } catch { /* */ }
  notify(match.length ? "success" : "info", `Review-flagged: ${match.length}`);
  return match.length;
}

export function gridReport(): Any {
  const grids = auth()?.getGrids?.() ?? [];
  const report = {
    count: grids.length,
    names: grids.map((g: Any) => g.name || g.id || g.label).filter(Boolean),
  };
  (window as Any).__obsGridReport = report;
  console.log("[grids]", report);
  notify("info", report.count ? `Grids: ${report.count} · ${report.names.slice(0, 6).join(", ")}` : "No grids");
  return report;
}

export function exportCensusCsv(): void {
  const map: Record<string, number> = {};
  for (const e of els()) {
    const t = String(e.type || "unknown");
    map[t] = (map[t] || 0) + 1;
  }
  const rows = [["type", "count"], ...Object.entries(map).sort((a, b) => b[1] - a[1])];
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `census-${Date.now()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  notify("success", "Census CSV downloaded");
}

export function resetDefaultView(): void {
  try {
    (window as Any).__obsCameraTools?.recoverView?.();
    notify("success", "View recovered");
    return;
  } catch { /* */ }
  try {
    const cam = (ctx as Any).camera;
    cam?.setPosition?.(50, 50, 50);
    cam?.lookAt?.(0, 0, 0);
    notify("success", "Camera reset");
  } catch {
    notify("warn", "Camera reset unavailable");
  }
}

export function toggleWireframeHint(): void {
  try {
    const vg = (ctx.features as Any)?.viewGraphics || (window as Any).__obsViewGraphics;
    if (vg?.toggleWireframe) {
      vg.toggleWireframe();
      notify("success", "Wireframe toggled");
      return;
    }
    if (vg?.setDisplayStyle) {
      const cur = vg.getDisplayStyle?.() || "shaded";
      vg.setDisplayStyle(cur === "wireframe" ? "shaded" : "wireframe");
      notify("success", "Display style toggled");
      return;
    }
  } catch { /* */ }
  notify("info", "Use Graphic Display Options for wireframe / shaded");
}

export function runDiagnosticsDump(): Any {
  const report = {
    userAgent: navigator.userAgent,
    memory: (performance as Any).memory
      ? {
          usedMB: Math.round((performance as Any).memory.usedJSHeapSize / 1048576),
          totalMB: Math.round((performance as Any).memory.totalJSHeapSize / 1048576),
        }
      : null,
    elements: els().length,
    href: location.href,
    time: new Date().toISOString(),
  };
  (window as Any).__obsDiagnostics = report;
  console.log("[diagnostics]", report);
  notify("info", report.memory
    ? `Heap ~${report.memory.usedMB}/${report.memory.totalMB} MB · ${report.elements} elements`
    : `Diagnostics logged · ${report.elements} elements`);
  return report;
}

export function copySelectedIds(): number {
  const ids = auth()?.getSelectedIds?.() ?? [];
  if (!ids.length) { notify("warn", "Select elements first"); return 0; }
  const text = ids.join("\n");
  try {
    void navigator.clipboard.writeText(text);
    notify("success", `Copied ${ids.length} id(s)`);
  } catch {
    prompt("Copy IDs", text);
  }
  return ids.length;
}

export function setupCriticalWorkflowPack14(): void {
  const api = {
    projectSummary, elementSearch, hideUnlocked, selectReviewFlagged, gridReport,
    exportCensusCsv, resetDefaultView, toggleWireframeHint, runDiagnosticsDump, copySelectedIds,
  };
  (window as Any).__obsWorkflowPack14 = api;
  (ctx.features as Any).workflowPack14 = api;
  const cmds: Array<[string, string, () => void]> = [
    ["gap14-summary", "Project: Summary", () => void projectSummary()],
    ["gap14-search", "Model: Search elements…", () => void elementSearch()],
    ["gap14-hide-unlocked", "View: Hide unlocked", () => void hideUnlocked()],
    ["gap14-sel-review", "Review: Select flagged", () => void selectReviewFlagged()],
    ["gap14-grids", "Model: Grid report", () => void gridReport()],
    ["gap14-census-csv", "Model: Export census CSV", () => void exportCensusCsv()],
    ["gap14-reset-view", "View: Reset default camera", () => void resetDefaultView()],
    ["gap14-wire", "View: Toggle wireframe", () => void toggleWireframeHint()],
    ["gap14-diag", "QA: Diagnostics dump", () => void runDiagnosticsDump()],
    ["gap14-copy-ids", "Selection: Copy IDs", () => void copySelectedIds()],
  ];
  void import("../../features/command-palette").then(({ registerCommand }) => {
    for (const [id, label, run] of cmds) registerCommand({ id, label, category: "Critical gaps", run });
  }).catch(() => { /* */ });
  console.log("[workflow-pack-14] 10 delivery/QA commands ready");
}
