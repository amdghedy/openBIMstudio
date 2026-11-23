/**
 * Pack 13 — 10 coordination / data gaps:
 * 1. COUNTBYTYPE  2. RENAMESEL  3. LOCKSEL  4. UNLOCKSEL  5. DUPLICATESEL
 * 6. MIRRORINFO  7. ZOOMSEL  8. PROPERTIESJSON  9. MARKREVIEW  10. CLEARREVIEW
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { promptLine } from "../../features/form-modal";

type Any = Record<string, any>;
function auth(): Any | null { return (ctx.features as Any)?.authoring ?? null; }
function els(): Any[] { return auth()?.getElements?.() ?? []; }
function selIds(): string[] { return auth()?.getSelectedIds?.() ?? []; }

export function countByType(): Any {
  const map: Record<string, number> = {};
  for (const e of els()) {
    const t = String(e.type || e.category || "unknown");
    map[t] = (map[t] || 0) + 1;
  }
  const top = Object.entries(map).sort((a, b) => b[1] - a[1]);
  console.log("[count-by-type]", top);
  notify("info", top.slice(0, 5).map(([k, v]) => `${k}:${v}`).join(" · ") || "No elements");
  return map;
}

/** Menu entry: asks for the new name through the form modal, then renames. */
export async function renameSelectionInteractive(): Promise<number> {
  const n = await promptLine("Rename selection", "New name for selected elements", "Element");
  return renameSelection(n ?? undefined);
}

export function renameSelection(name?: string): number {
  const ids = selIds();
  if (!ids.length) { notify("warn", "Select elements first"); return 0; }
  if (name == null || name === "") return 0;
  const n = name;
  let c = 0;
  for (const id of ids) {
    const e = els().find((x) => x.id === id);
    if (!e) continue;
    e.name = n;
    if (e.params) e.params.name = n;
    if (e.properties) e.properties.name = n;
    c++;
  }
  try { auth()?.markDirty?.(); } catch { /* */ }
  notify("success", `Renamed ${c} to “${n}”`);
  return c;
}

export function lockSelection(): number {
  const ids = selIds();
  if (!ids.length) { notify("warn", "Select elements first"); return 0; }
  let c = 0;
  for (const id of ids) {
    const e = els().find((x) => x.id === id);
    if (!e) continue;
    if (!e.properties) e.properties = {};
    e.properties.locked = true;
    c++;
  }
  notify("success", `Locked ${c} element(s)`);
  return c;
}

export function unlockSelection(): number {
  const ids = selIds();
  let c = 0;
  for (const id of ids.length ? ids : els().map((e) => e.id)) {
    const e = els().find((x) => x.id === id);
    if (!e?.properties?.locked) continue;
    e.properties.locked = false;
    c++;
  }
  notify("success", c ? `Unlocked ${c}` : "Nothing locked");
  return c;
}

export function duplicateSelection(): number {
  const a = auth();
  const ids = selIds();
  if (!ids.length) { notify("warn", "Select elements first"); return 0; }
  if (typeof a?.duplicateSelected === "function") {
    try {
      const n = a.duplicateSelected();
      notify("success", `Duplicated via authoring (${n ?? ids.length})`);
      return Number(n) || ids.length;
    } catch { /* fall through */ }
  }
  let c = 0;
  const created: string[] = [];
  for (const id of ids) {
    const e = els().find((x) => x.id === id);
    if (!e) continue;
    const copy = JSON.parse(JSON.stringify(e));
    copy.id = `dup-${Date.now()}-${c}`;
    copy.name = (e.name || e.type || "Element") + " Copy";
    try {
      a?.addElement?.(copy);
      created.push(copy.id);
      c++;
    } catch { /* */ }
  }
  if (created.length && a?.setSelection) a.setSelection(created);
  notify(c ? "success" : "warn", c ? `Duplicated ${c}` : "Duplicate not supported for selection");
  return c;
}

export function selectionBBoxInfo(): Any | null {
  const ids = new Set(selIds());
  if (!ids.size) { notify("warn", "Select elements first"); return null; }
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let n = 0;
  for (const e of els()) {
    if (!ids.has(e.id)) continue;
    const p = e.params || e.properties || {};
    const x = Number(p.x ?? p.cx ?? 0), y = Number(p.y ?? p.cy ?? 0), z = Number(p.z ?? p.elevation ?? 0);
    const w = Number(p.width ?? p.w ?? 1), d = Number(p.depth ?? p.length ?? 1), h = Number(p.height ?? p.h ?? 1);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x + w);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y + d);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z + h);
    n++;
  }
  const box = { n, min: [minX, minY, minZ], max: [maxX, maxY, maxZ], size: [maxX - minX, maxY - minY, maxZ - minZ] };
  console.log("[sel-bbox]", box);
  notify("info", n ? `BBox size ≈ ${box.size.map((v) => v.toFixed(2)).join(" × ")} m` : "No bbox data");
  return box;
}

export function zoomToSelection(): void {
  const a = auth();
  try {
    if (a?.zoomToSelection) { a.zoomToSelection(); notify("success", "Zoomed to selection"); return; }
  } catch { /* */ }
  try {
    (ctx as Any).camera?.fitToSelection?.();
    notify("success", "Camera fit to selection");
    return;
  } catch { /* */ }
  selectionBBoxInfo();
  notify("info", "Zoom API unavailable — bbox logged to console");
}

export function exportSelectionPropertiesJson(): number {
  const ids = selIds();
  if (!ids.length) { notify("warn", "Select elements first"); return 0; }
  const data = ids.map((id) => els().find((e) => e.id === id)).filter(Boolean);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `selection-props-${Date.now()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  notify("success", `Exported ${data.length} element(s) JSON`);
  return data.length;
}

export function markSelectionForReview(): number {
  const ids = selIds();
  if (!ids.length) { notify("warn", "Select elements first"); return 0; }
  let c = 0;
  for (const id of ids) {
    const e = els().find((x) => x.id === id);
    if (!e) continue;
    if (!e.properties) e.properties = {};
    e.properties.reviewFlag = true;
    e.properties.reviewAt = Date.now();
    c++;
  }
  notify("success", `Marked ${c} for review`);
  return c;
}

export function clearReviewFlags(): number {
  let c = 0;
  for (const e of els()) {
    if (e.properties?.reviewFlag) {
      e.properties.reviewFlag = false;
      c++;
    }
  }
  notify("success", c ? `Cleared ${c} review flags` : "No review flags");
  return c;
}

export function setupCriticalWorkflowPack13(): void {
  const api = {
    countByType, renameSelection, lockSelection, unlockSelection, duplicateSelection,
    selectionBBoxInfo, zoomToSelection, exportSelectionPropertiesJson, markSelectionForReview, clearReviewFlags,
  };
  (ctx.features as Any).workflowPack13 = api;
  const cmds: Array<[string, string, () => void]> = [
    ["gap13-count-type", "Model: Count by type", () => void countByType()],
    ["gap13-rename", "Edit: Rename selection…", () => void renameSelectionInteractive()],
    ["gap13-lock", "Edit: Lock selection", () => void lockSelection()],
    ["gap13-unlock", "Edit: Unlock selection", () => void unlockSelection()],
    ["gap13-duplicate", "Edit: Duplicate selection", () => void duplicateSelection()],
    ["gap13-bbox", "Measure: Selection bbox", () => void selectionBBoxInfo()],
    ["gap13-zoom", "View: Zoom to selection", () => void zoomToSelection()],
    ["gap13-props-json", "Selection: Export properties JSON", () => void exportSelectionPropertiesJson()],
    ["gap13-review", "Review: Mark selection", () => void markSelectionForReview()],
    ["gap13-clear-review", "Review: Clear flags", () => void clearReviewFlags()],
  ];
  void import("../../features/command-palette").then(({ registerCommand }) => {
    for (const [id, label, run] of cmds) registerCommand({ id, label, category: "Critical gaps", run });
  }).catch(() => { /* */ });
  console.log("[workflow-pack-13] 10 edit/review commands ready");
}
