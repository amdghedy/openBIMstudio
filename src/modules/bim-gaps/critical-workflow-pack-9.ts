/**
 * Critical workflow pack 9 — 3D engine visibility, section, camera, selection:
 *  1. HIDESEL3D       hide selection (authored + fragments)
 *  2. ISOLATESEL3D    isolate selection
 *  3. RESETVIS3D      reset temporary visibility
 *  4. SECTIONBOX      toggle section box
 *  5. SECTIONRESET    reset section box to model
 *  6. SECTIONPLANE    toggle section plane
 *  7. ZOOMEXT3D       fit camera to model / selection
 *  8. HIDECAT3D       hide selected category
 *  9. ORBITHOME       camera home / recover view
 * 10. SELCOUNT3D      report selection counts
 *
 * All registered to Command Center so they appear in UI search + can be bound.
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";

type Any = Record<string, any>;

function authoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}

function elements(): Any[] {
  return authoring()?.getElements?.() ?? [];
}

/* ── 1–3 Visibility ──────────────────────────────────────────────── */

export async function hideSelection3d(): Promise<number> {
  try {
    const vis = await import("./visibility-bridge");
    const n = vis.hideSelection?.() ?? 0;
    notify("success", n ? `Hidden ${n} selected` : "Nothing selected to hide");
    return n;
  } catch (e) {
    notify("warn", `Hide failed: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

export async function isolateSelection3d(): Promise<number> {
  try {
    const vis = await import("./visibility-bridge");
    const n = vis.isolateSelection?.() ?? 0;
    notify("success", n ? `Isolated ${n}` : "Nothing selected to isolate");
    return n;
  } catch (e) {
    notify("warn", `Isolate failed: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

export async function resetVisibility3d(): Promise<void> {
  try {
    const vis = await import("./visibility-bridge");
    vis.resetTemporaryVisibility?.();
    notify("success", "Visibility reset");
  } catch (e) {
    try {
      const vf = await import("../visibility/visibility-filter");
      (vf as Any).visibilityFilter?.resetTemporary?.();
    } catch { /* */ }
    notify("success", "Visibility reset (fallback)");
  }
}

/* ── 4–6 Section ─────────────────────────────────────────────────── */

export async function toggleSectionBox3d(): Promise<void> {
  try {
    const m = await import("../../features/section-box");
    const on = m.toggleSectionBox();
    notify("success", on ? "Section box ON" : "Section box OFF");
  } catch (e) {
    notify("warn", `Section box: ${e instanceof Error ? e.message : e}`);
  }
}

export async function resetSectionBox3d(): Promise<void> {
  try {
    const m = await import("../../features/section-box");
    m.resetSectionBox?.();
    notify("success", "Section box reset to model");
  } catch (e) {
    notify("warn", `Section reset: ${e instanceof Error ? e.message : e}`);
  }
}

export async function toggleSectionPlane3d(): Promise<void> {
  try {
    const m = await import("../../features/section");
    m.toggleSection?.();
    notify("success", "Section plane toggled");
  } catch (e) {
    notify("warn", `Section plane: ${e instanceof Error ? e.message : e}`);
  }
}

/* ── 7 Zoom extents ──────────────────────────────────────────────── */

export function zoomExtents3d(selectionOnly = false): boolean {
  try {
    const a = authoring();
    const ids = selectionOnly ? new Set(a?.getSelectedIds?.() ?? []) : null;
    const box = new THREE.Box3();
    let any = false;

    for (const el of elements()) {
      if (ids && ids.size && !ids.has(el.id)) continue;
      try {
        const b = a?.getElementWorldBox?.(el);
        if (b && !b.isEmpty()) {
          box.union(b);
          any = true;
          continue;
        }
      } catch { /* */ }
      const p = el.params ?? {};
      const elev = Number(p.elevation) || 0;
      const h = Number(p.height) || 1;
      const touch = (x: number, y: number, z: number) => {
        any = true;
        box.expandByPoint(new THREE.Vector3(x, y, z));
      };
      if (p.start) touch(p.start[0], elev, p.start[1]);
      if (p.end) touch(p.end[0], elev + h, p.end[1]);
      if (p.point) touch(p.point[0], elev, p.point[1]);
      if (Array.isArray(p.polygon)) {
        for (const v of p.polygon) touch(v[0], elev, v[1]);
      }
    }

    // Fragments
    try {
      for (const [, m] of (ctx.fragments?.list ?? new Map()) as Map<string, Any>) {
        if (m?.object) {
          const b = new THREE.Box3().setFromObject(m.object);
          if (!b.isEmpty()) {
            box.union(b);
            any = true;
          }
        }
      }
    } catch { /* */ }

    if (!any) {
      notify("warn", "No geometry to fit");
      return false;
    }

    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 10;
    const cam = (ctx as Any).world?.camera?.three ?? (ctx as Any).world?.camera;
    const controls = (ctx as Any).world?.controls ?? (ctx as Any).world?.camera?.controls;
    if (cam) {
      const dist = size * 1.6;
      cam.position.set(c.x + dist * 0.7, c.y + dist * 0.55, c.z + dist * 0.7);
      cam.near = Math.max(0.05, size / 500);
      cam.far = Math.max(size * 40, 100);
      cam.updateProjectionMatrix?.();
      if (controls?.target) {
        controls.target.copy(c);
        controls.update?.();
      } else {
        cam.lookAt?.(c);
      }
    }
    try {
      window.dispatchEvent(
        new CustomEvent("obs-zoom-extents", { detail: { center: c.toArray(), size } }),
      );
    } catch { /* */ }
    notify("success", selectionOnly ? "Zoomed to selection" : `Zoom extents · ${size.toFixed(1)} m`);
    return true;
  } catch (e) {
    notify("warn", `Zoom failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/* ── 8 Hide category ─────────────────────────────────────────────── */

export async function hideSelectedCategory3d(): Promise<number> {
  try {
    const pack3 = await import("./critical-workflow-pack-3");
    if (typeof pack3.hideSelectedCategory === "function") {
      return pack3.hideSelectedCategory();
    }
  } catch { /* */ }

  const a = authoring();
  const ids = a?.getSelectedIds?.() ?? [];
  if (!ids.length) {
    notify("warn", "Select an element first");
    return 0;
  }
  const seed = elements().find((e) => e.id === ids[0]);
  if (!seed) return 0;
  let n = 0;
  for (const el of elements()) {
    if (el.type !== seed.type) continue;
    el.properties = { ...(el.properties ?? {}), tempHidden: true };
    try {
      const mesh = a?.getMesh?.(el.id);
      if (mesh) mesh.visible = false;
    } catch { /* */ }
    n++;
  }
  notify("success", `Hidden category “${seed.type}” (${n})`);
  return n;
}

/* ── 9 Camera home ───────────────────────────────────────────────── */

export function cameraHome3d(): void {
  try {
    const tools = (window as Any).__obsCameraTools;
    if (tools?.recoverView) {
      tools.recoverView();
      notify("success", "Camera recovered");
      return;
    }
  } catch { /* */ }
  zoomExtents3d(false);
}

/* ── 10 Selection report ─────────────────────────────────────────── */

export async function selectionReport3d(): Promise<Any> {
  try {
    const vis = await import("./visibility-bridge");
    const keys = vis.getSelectedKeys?.() ?? authoring()?.getSelectedIds?.() ?? [];
    const byType: Record<string, number> = {};
    let authored = 0;
    let frag = 0;
    for (const k of keys) {
      if (String(k).startsWith("frag:")) {
        frag++;
        byType["fragment"] = (byType["fragment"] || 0) + 1;
      } else {
        authored++;
        const el = elements().find((e) => e.id === k);
        const t = el?.type || "unknown";
        byType[t] = (byType[t] || 0) + 1;
      }
    }
    const report = { total: keys.length, authored, frag, byType };
    (window as Any).__obsSelReport3d = report;
    console.log("[3d-sel]", report);
    notify(
      "info",
      keys.length
        ? `Selection: ${keys.length} (authored ${authored}, linked ${frag})`
        : "Nothing selected",
    );
    return report;
  } catch (e) {
    notify("warn", `Selection report: ${e instanceof Error ? e.message : e}`);
    return { total: 0 };
  }
}

/* ── Boot + UI registration ──────────────────────────────────────── */

export function setupCriticalWorkflowPack9(): void {
  const api = {
    hideSelection3d,
    isolateSelection3d,
    resetVisibility3d,
    toggleSectionBox3d,
    resetSectionBox3d,
    toggleSectionPlane3d,
    zoomExtents3d,
    hideSelectedCategory3d,
    cameraHome3d,
    selectionReport3d,
  };
  (window as Any).__obsWorkflowPack9 = api;
  (ctx.features as Any).workflowPack9 = api;

  const cmds: Array<[string, string, string, () => void]> = [
    ["3d-hide", "3D: Hide selection", "3D View", () => void hideSelection3d()],
    ["3d-isolate", "3D: Isolate selection", "3D View", () => void isolateSelection3d()],
    ["3d-reset-vis", "3D: Reset visibility", "3D View", () => void resetVisibility3d()],
    ["3d-section-box", "3D: Toggle section box", "3D View", () => void toggleSectionBox3d()],
    ["3d-section-reset", "3D: Reset section box", "3D View", () => void resetSectionBox3d()],
    ["3d-section-plane", "3D: Toggle section plane", "3D View", () => void toggleSectionPlane3d()],
    ["3d-zoom-ext", "3D: Zoom extents", "3D View", () => void zoomExtents3d(false)],
    ["3d-zoom-sel", "3D: Zoom to selection", "3D View", () => void zoomExtents3d(true)],
    ["3d-hide-cat", "3D: Hide selected category", "3D View", () => void hideSelectedCategory3d()],
    ["3d-cam-home", "3D: Camera home", "3D View", () => void cameraHome3d()],
    ["3d-sel-report", "3D: Selection report", "3D View", () => void selectionReport3d()],
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

  // Also expose on bim-toolbox style global for UI buttons
  try {
    window.dispatchEvent(
      new CustomEvent("obs-3d-tools-ready", {
        detail: {
          tools: [
            { id: "hide", label: "Hide", run: () => void hideSelection3d() },
            { id: "isolate", label: "Isolate", run: () => void isolateSelection3d() },
            { id: "resetVis", label: "Reset vis", run: () => void resetVisibility3d() },
            { id: "sectionBox", label: "Section box", run: () => void toggleSectionBox3d() },
            { id: "sectionReset", label: "Reset section", run: () => void resetSectionBox3d() },
            { id: "sectionPlane", label: "Section plane", run: () => void toggleSectionPlane3d() },
            { id: "zoomExt", label: "Zoom extents", run: () => void zoomExtents3d(false) },
            { id: "zoomSel", label: "Zoom selection", run: () => void zoomExtents3d(true) },
            { id: "hideCat", label: "Hide category", run: () => void hideSelectedCategory3d() },
            { id: "camHome", label: "Camera home", run: () => void cameraHome3d() },
          ],
        },
      }),
    );
  } catch { /* */ }

  console.log("[workflow-pack-9] 3D view / section / visibility commands ready");
}
