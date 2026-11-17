/**
 * Critical workflow pack 2 — production QA / exchange / modify gaps:
 *  1. MODELCHECK       validation report
 *  2. SOFTCLASH        AABB soft clashes between authored categories
 *  3. IFCEXPORT        download authored model as IFC4
 *  4. JSONDUMP         project elements dump
 *  5. ORTHOWALLS       straighten near-axis walls
 *  6. ALIGNX / ALIGNZ  axis-align selection
 *  7. SPLITMID         split selected walls at midpoint
 *  8. MIRRORXZ         mirror selection about X or Z through centroid
 *  9. SELECTSIMILAR    select same type as first selected
 * 10. PURGEUNUSED      remove zero-length / degenerate elements
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { exportAuthoredToIfc } from "./authored-ifc";
import { validateNativeModel } from "../native-bim/model-validation";

type Any = Record<string, any>;

function authoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}

function elements(): Any[] {
  return authoring()?.getElements?.() ?? [];
}

function downloadText(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ── 1. Model quality check ──────────────────────────────────────── */

export function modelQualityCheck(): { errors: number; warnings: number; issues: Any[] } {
  const a = authoring();
  const els = elements();
  const levels = a?.getLevels?.() ?? [];
  const grids = a?.getGrids?.() ?? [];
  let issues: Any[] = [];
  try {
    issues = validateNativeModel({ elements: els, levels, grids }) ?? [];
  } catch (e) {
    console.warn("[modelcheck]", e);
  }
  // Extra heuristics
  for (const el of els) {
    if ((el.type === "wall" || el.type === "beam") && el.params?.start && el.params?.end) {
      const L = Math.hypot(el.params.end[0] - el.params.start[0], el.params.end[1] - el.params.start[1]);
      if (L < 0.02) {
        issues.push({ severity: "error", code: "ZERO_LENGTH", message: `${el.type} ${el.name || el.id} has near-zero length`, elementId: el.id });
      }
    }
    if (el.type === "door" || el.type === "window") {
      if (!el.hostId) {
        issues.push({ severity: "warning", code: "UNHOSTED", message: `${el.type} ${el.name || el.id} has no host wall`, elementId: el.id });
      }
    }
  }
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  (window as Any).__obsModelCheck = { issues, errors, warnings, at: Date.now() };
  console.table(issues.slice(0, 50));
  notify(
    errors ? "warn" : "success",
    `Model check: ${errors} error(s), ${warnings} warning(s) — see console / __obsModelCheck`,
  );
  return { errors, warnings, issues };
}

/* ── 2. Soft clash (AABB) ────────────────────────────────────────── */

function elBox(el: Any): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
  const p = el.params ?? {};
  const elev = Number(p.elevation) || 0;
  const h = Number(p.height) || 0.3;
  if (p.start && p.end) {
    const th = Number(p.thickness ?? p.width ?? 0.2) / 2;
    const minX = Math.min(p.start[0], p.end[0]) - th;
    const maxX = Math.max(p.start[0], p.end[0]) + th;
    const minZ = Math.min(p.start[1], p.end[1]) - th;
    const maxZ = Math.max(p.start[1], p.end[1]) + th;
    return { minX, maxX, minY: elev, maxY: elev + h, minZ, maxZ };
  }
  if (p.point) {
    const w = Number(p.width ?? p.thickness ?? 0.3) / 2;
    const d = Number(p.depth ?? p.thickness ?? 0.3) / 2;
    return {
      minX: p.point[0] - w, maxX: p.point[0] + w,
      minY: elev, maxY: elev + h,
      minZ: p.point[1] - d, maxZ: p.point[1] + d,
    };
  }
  if (Array.isArray(p.polygon) && p.polygon.length >= 3) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const v of p.polygon) {
      minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
      minZ = Math.min(minZ, v[1]); maxZ = Math.max(maxZ, v[1]);
    }
    return { minX, maxX, minY: elev, maxY: elev + Math.max(h, Number(p.thickness) || 0.2), minZ, maxZ };
  }
  return null;
}

function boxesOverlap(a: ReturnType<typeof elBox>, b: ReturnType<typeof elBox>, gap = 0.02): boolean {
  if (!a || !b) return false;
  return (
    a.minX <= b.maxX + gap && a.maxX >= b.minX - gap &&
    a.minY <= b.maxY + gap && a.maxY >= b.minY - gap &&
    a.minZ <= b.maxZ + gap && a.maxZ >= b.minZ - gap
  );
}

export function softClashCheck(): Array<{ a: string; b: string; types: string }> {
  const els = elements();
  const boxes = els.map((e) => ({ e, box: elBox(e) })).filter((x) => x.box);
  const hits: Array<{ a: string; b: string; types: string }> = [];
  // Cross-discipline pairs of interest
  const interesting = (t1: string, t2: string) => {
    const set = new Set([t1, t2]);
    if (set.has("duct") && set.has("beam")) return true;
    if (set.has("pipe") && set.has("beam")) return true;
    if (set.has("duct") && set.has("wall")) return true;
    if (set.has("column") && set.has("duct")) return true;
    if (set.has("pipe") && set.has("wall")) return true;
    if (t1 === t2 && (t1 === "wall" || t1 === "beam")) return true;
    return false;
  };
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i], B = boxes[j];
      if (!interesting(A.e.type, B.e.type)) continue;
      if (A.e.hostId === B.e.id || B.e.hostId === A.e.id) continue;
      if (boxesOverlap(A.box, B.box, 0.01)) {
        hits.push({
          a: A.e.name || A.e.id,
          b: B.e.name || B.e.id,
          types: `${A.e.type} × ${B.e.type}`,
        });
      }
    }
  }
  (window as Any).__obsSoftClash = hits;
  console.table(hits.slice(0, 40));
  notify(hits.length ? "warn" : "success", `Soft clash: ${hits.length} pair(s)`);
  return hits;
}

/* ── 3. IFC export ───────────────────────────────────────────────── */

export function exportModelIfc(): void {
  const a = authoring();
  const els = elements();
  if (!els.length) {
    notify("warn", "No elements to export");
    return;
  }
  try {
    const result = exportAuthoredToIfc(els as any, {
      schema: "IFC4",
      projectName: "OpenBIMStudio Project",
      levels: (a?.getLevels?.() ?? []).map((l: Any) => ({
        id: l.id,
        name: l.name,
        elevation: Number(l.elevation) || 0,
      })),
    });
    const text = result?.text ?? "";
    if (!text) {
      console.log("[ifc-export] result", result);
      notify("warn", "IFC export returned empty");
      return;
    }
    downloadText("model.ifc", text, "application/x-step");
    const n = result.stats?.elements ?? els.length;
    notify("success", `IFC4 exported · ${n} element(s)`);
  } catch (e) {
    console.error("[ifc-export]", e);
    notify("warn", `IFC export failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ── 4. JSON dump ────────────────────────────────────────────────── */

export function exportModelJson(): void {
  const a = authoring();
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    levels: a?.getLevels?.() ?? [],
    grids: a?.getGrids?.() ?? [],
    elements: elements(),
  };
  downloadText("model.json", JSON.stringify(payload, null, 2), "application/json");
  notify("success", `JSON dump · ${payload.elements.length} elements`);
}

/* ── 5. Ortho walls ──────────────────────────────────────────────── */

export function orthoWalls(toleranceDeg = 8): number {
  const els = elements();
  let n = 0;
  for (const el of els) {
    if (el.type !== "wall" && el.type !== "curtain-wall" && el.type !== "beam") continue;
    if (!el.params?.start || !el.params?.end) continue;
    const [x1, z1] = el.params.start;
    const [x2, z2] = el.params.end;
    const ang = (Math.atan2(z2 - z1, x2 - x1) * 180) / Math.PI;
    const snapped = Math.round(ang / 90) * 90;
    let d = Math.abs(ang - snapped);
    if (d > 180) d = 360 - d;
    if (d > toleranceDeg || d < 0.05) continue;
    const L = Math.hypot(x2 - x1, z2 - z1);
    const rad = (snapped * Math.PI) / 180;
    el.params.end = [x1 + Math.cos(rad) * L, z1 + Math.sin(rad) * L];
    n++;
  }
  if (n) {
    try { authoring()?.rebuildAuthored?.() ?? authoring()?.rebuild?.(); } catch { /* */ }
  }
  notify("success", `Ortho-aligned ${n} linear element(s)`);
  return n;
}

/* ── 6–7. Align / split via authoring API ────────────────────────── */

export function alignSelection(axis: "x" | "z"): number {
  const a = authoring();
  if (typeof a?.alignSelectedAxis === "function") {
    const n = a.alignSelectedAxis(axis);
    notify("success", `Aligned selection to ${axis.toUpperCase()}`);
    return Number(n) || 0;
  }
  notify("warn", "Align API not available");
  return 0;
}

export function splitSelectionMid(): number {
  const a = authoring();
  if (typeof a?.splitSelectedAtMidpoint === "function") {
    const n = a.splitSelectedAtMidpoint();
    notify("success", `Split ${n} wall(s) at midpoint`);
    return Number(n) || 0;
  }
  notify("warn", "Split API not available");
  return 0;
}

/* ── 8. Mirror selection about centroid axis ─────────────────────── */

export function mirrorSelection(axis: "x" | "z"): number {
  const a = authoring();
  const ids: string[] = a?.getSelectedIds?.() ?? [];
  const els = elements().filter((e) => ids.includes(e.id));
  if (!els.length) {
    notify("warn", "Select elements to mirror");
    return 0;
  }
  let cx = 0, cz = 0, c = 0;
  for (const el of els) {
    const p = el.params;
    if (p?.point) { cx += p.point[0]; cz += p.point[1]; c++; }
    else if (p?.start && p?.end) {
      cx += (p.start[0] + p.end[0]) / 2;
      cz += (p.start[1] + p.end[1]) / 2;
      c++;
    }
  }
  if (!c) return 0;
  cx /= c; cz /= c;
  const flip = (x: number, z: number): [number, number] =>
    axis === "x" ? [x, 2 * cz - z] : [2 * cx - x, z];
  for (const el of els) {
    const p = el.params;
    if (p.point) p.point = flip(p.point[0], p.point[1]);
    if (p.start) p.start = flip(p.start[0], p.start[1]);
    if (p.end) p.end = flip(p.end[0], p.end[1]);
    if (p.polygon) p.polygon = p.polygon.map((v: number[]) => flip(v[0], v[1])).reverse();
  }
  try { a?.rebuildAuthored?.() ?? a?.rebuild?.(); } catch { /* */ }
  notify("success", `Mirrored ${els.length} element(s) about ${axis.toUpperCase()}`);
  return els.length;
}

/* ── 9. Select similar ───────────────────────────────────────────── */

export function selectSimilar(): number {
  const a = authoring();
  const ids: string[] = a?.getSelectedIds?.() ?? [];
  if (!ids.length) {
    notify("warn", "Select one element first");
    return 0;
  }
  const src = elements().find((e) => e.id === ids[0]);
  if (!src) return 0;
  const same = elements().filter((e) => e.type === src.type).map((e) => e.id);
  try {
    if (typeof a?.setSelectedAuthored === "function") a.setSelectedAuthored(same);
    else if (typeof a?.selectAllAuthored === "function") {
      /* fallback: store */
      (window as Any).__obsSelection = same;
    }
  } catch { /* */ }
  notify("success", `Selected ${same.length} × ${src.type}`);
  return same.length;
}

/* ── 10. Purge degenerate ────────────────────────────────────────── */

export function purgeUnused(): number {
  const a = authoring();
  const els = elements();
  const remove: string[] = [];
  for (const el of els) {
    if ((el.type === "wall" || el.type === "beam" || el.type === "strip") && el.params?.start && el.params?.end) {
      const L = Math.hypot(el.params.end[0] - el.params.start[0], el.params.end[1] - el.params.start[1]);
      if (L < 0.02) remove.push(el.id);
    }
    if ((el.type === "slab" || el.type === "roof" || el.type === "ceiling") && Array.isArray(el.params?.polygon) && el.params.polygon.length < 3) {
      remove.push(el.id);
    }
  }
  if (!remove.length) {
    notify("success", "Nothing to purge");
    return 0;
  }
  const set = new Set(remove);
  for (let i = els.length - 1; i >= 0; i--) {
    if (set.has(els[i].id)) els.splice(i, 1);
  }
  try { a?.rebuildAuthored?.() ?? a?.rebuild?.(); } catch { /* */ }
  notify("success", `Purged ${remove.length} degenerate element(s)`);
  return remove.length;
}

/* ── Boot ────────────────────────────────────────────────────────── */

export function setupCriticalWorkflowPack2(): void {
  const api = {
    modelQualityCheck,
    softClashCheck,
    exportModelIfc,
    exportModelJson,
    orthoWalls,
    alignSelection,
    splitSelectionMid,
    mirrorSelection,
    selectSimilar,
    purgeUnused,
  };
  (window as Any).__obsWorkflowPack2 = api;
  (ctx.features as Any).workflowPack2 = api;

  const cmds: Array<[string, string, string, () => void]> = [
    ["rg-modelcheck", "Model quality check", "QA", () => void modelQualityCheck()],
    ["rg-softclash", "Soft clash detection", "QA", () => void softClashCheck()],
    ["rg-ifc-export", "Export model IFC4", "Exchange", () => void exportModelIfc()],
    ["rg-json-dump", "Export model JSON", "Exchange", () => void exportModelJson()],
    ["rg-ortho-walls", "Ortho-align walls/beams", "Modify", () => void orthoWalls()],
    ["rg-align-x", "Align selection to X", "Modify", () => void alignSelection("x")],
    ["rg-align-z", "Align selection to Z", "Modify", () => void alignSelection("z")],
    ["rg-split-mid", "Split walls at midpoint", "Modify", () => void splitSelectionMid()],
    ["rg-mirror-x", "Mirror selection (X axis)", "Modify", () => void mirrorSelection("x")],
    ["rg-select-sim", "Select similar", "Modify", () => void selectSimilar()],
    ["rg-purge", "Purge zero-length elements", "QA", () => void purgeUnused()],
  ];

  for (const [id, label, category, run] of cmds) {
    try {
      window.dispatchEvent(
        new CustomEvent("obs-register-command", {
          detail: { id, label, category, run },
        }),
      );
    } catch { /* */ }
  }
  console.log("[workflow-pack-2] QA / exchange / modify commands ready");
}
