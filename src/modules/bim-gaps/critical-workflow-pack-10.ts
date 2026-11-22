/**
 * Critical workflow pack 10 — 3D engine:
 *  1. SELECTSIM3D     select all of same type as current selection
 *  2. INVERTSEL3D     invert authored selection
 *  3. GHOSTSEL3D      make selection semi-transparent (review)
 *  4. UNGHOST3D       restore materials opacity
 *  5. WIREFRAME3D     cycle visual preset wireframe / shaded
 *  6. ORTHO3D         toggle orthographic projection
 *  7. TOGGLEGRIDS3D   show/hide grid datums
 *  8. TOGGLELEVELS3D  show/hide level datums
 *  9. MEASURE3D       report bounding size of selection
 * 10. CLEARSEL3D      clear 3D selection (authored + fragments)
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

const ghosted = new Map<string, { opacity: number; transparent: boolean }>();

/* 1 */ export function selectSimilar3d(): number {
  const a = authoring();
  const ids: string[] = a?.getSelectedIds?.() ?? [];
  if (!ids.length) {
    notify("warn", "Select an element first");
    return 0;
  }
  const seed = elements().find((e) => e.id === ids[0]);
  if (!seed) return 0;
  const match = elements().filter((e) => e.type === seed.type).map((e) => e.id);
  // setSelectedIds is the authoring replace-selection primitive. The old
  // call chain (setSelectedIds ?? selectIds, then a clearSelection /
  // addToSelection fallback) named methods the engine never had, so the
  // command reported success while selecting nothing — and, once the
  // method exists, the ?? would have invoked a second setter for free,
  // since the first returns void. Fail closed instead of lying.
  if (typeof a?.setSelectedIds !== "function") {
    notify("warn", "Select Similar is unavailable — the selection engine has no setSelectedIds");
    return 0;
  }
  a.setSelectedIds(match);
  notify("success", `Select similar “${seed.type}”: ${match.length}`);
  return match.length;
}

/* 2 */ export function invertSelection3d(): number {
  const a = authoring();
  const cur = new Set<string>(a?.getSelectedIds?.() ?? []);
  const all = elements().map((e) => e.id);
  const next = all.filter((id) => !cur.has(id));
  // Same missing-method story as selectSimilar3d above: the old chain
  // called setSelectedIds ?? selectIds, neither of which existed.
  if (typeof a?.setSelectedIds !== "function") {
    notify("warn", "Invert Selection is unavailable — the selection engine has no setSelectedIds");
    return 0;
  }
  a.setSelectedIds(next);
  notify("success", `Inverted selection → ${next.length}`);
  return next.length;
}

function applyGhostToObject(obj: THREE.Object3D, key: string, opacity: number): void {
  obj.traverse((n: Any) => {
    if (!n.isMesh || !n.material) return;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    for (const m of mats) {
      if (!m) continue;
      const id = `${key}:${m.uuid}`;
      if (!ghosted.has(id)) {
        ghosted.set(id, { opacity: m.opacity ?? 1, transparent: !!m.transparent });
      }
      m.transparent = true;
      m.opacity = opacity;
      m.needsUpdate = true;
    }
  });
}

/* 3 */ export function ghostSelection3d(opacity = 0.35): number {
  const a = authoring();
  const ids: string[] = a?.getSelectedIds?.() ?? [];
  let n = 0;
  for (const id of ids) {
    try {
      const mesh = a?.getMesh?.(id);
      if (mesh) {
        applyGhostToObject(mesh, id, opacity);
        n++;
      }
    } catch { /* */ }
  }
  // Fragments selection via visibility-bridge keys
  try {
    void import("./visibility-bridge").then((vis) => {
      const keys = vis.getSelectedKeys?.() ?? [];
      for (const k of keys) {
        const p = vis.parseFragKey?.(k);
        if (!p) continue;
        const model = (ctx.fragments?.list as Map<string, Any>)?.get?.(p.modelId);
        // best-effort: whole model ghost if no item mesh API
        if (model?.object) applyGhostToObject(model.object, k, opacity);
      }
    });
  } catch { /* */ }
  notify(n ? "success" : "warn", n ? `Ghosted ${n}` : "Nothing selected to ghost");
  return n;
}

/* 4 */ export function unghostAll3d(): number {
  let n = 0;
  const a = authoring();
  for (const el of elements()) {
    try {
      const mesh = a?.getMesh?.(el.id);
      if (!mesh) continue;
      mesh.traverse((node: Any) => {
        if (!node.isMesh || !node.material) return;
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        for (const m of mats) {
          if (!m) continue;
          const id = `${el.id}:${m.uuid}`;
          const prev = ghosted.get(id);
          if (prev) {
            m.opacity = prev.opacity;
            m.transparent = prev.transparent;
            m.needsUpdate = true;
            ghosted.delete(id);
            n++;
          }
        }
      });
    } catch { /* */ }
  }
  // clear remaining map entries generically
  ghosted.clear();
  notify("success", "Ghost mode cleared");
  return n;
}

/* 5 */ export async function cycleWireframe3d(): Promise<string> {
  try {
    const mod = await import("../../features/bim-experience");
    // experience may re-export from graphics module
  } catch { /* */ }
  try {
    const gfx = await import("../../features/view-graphics");
    const get = (gfx as Any).getVisualPreset;
    const set = (gfx as Any).setVisualPreset;
    if (get && set) {
      const cur = get();
      const next = cur === "wireframe" ? "shaded" : "wireframe";
      set(next);
      notify("success", `Visual: ${next}`);
      return next;
    }
  } catch { /* */ }
  try {
    const exp = await import("../../features/bim-experience");
    const get = (exp as Any).getVisualPreset;
    const set = (exp as Any).setVisualPreset;
    if (get && set) {
      const cur = get();
      const next = cur === "wireframe" ? "shaded" : "wireframe";
      set(next);
      notify("success", `Visual: ${next}`);
      return next;
    }
  } catch { /* */ }
  notify("warn", "Visual preset API not available");
  return "unknown";
}

/* 6 */ export async function toggleOrtho3d(): Promise<void> {
  try {
    const exp = await import("../../features/bim-experience");
    const get = (exp as Any).getProjection;
    const set = (exp as Any).setProjection;
    if (set) {
      const cur = get?.() ?? "perspective";
      const next = cur === "orthographic" ? "perspective" : "orthographic";
      await set(next);
      notify("success", `Projection: ${next}`);
      return;
    }
  } catch { /* */ }
  // fallback camera
  try {
    const cam = (ctx as Any).world?.camera?.three ?? (ctx as Any).world?.camera;
    if (cam?.isPerspectiveCamera) {
      notify("info", "Switch to Ortho via View bar (ORTHO button)");
    } else {
      notify("info", "Use View → Perspective / Ortho");
    }
  } catch {
    notify("warn", "Projection toggle unavailable");
  }
}

/* 7 */ export function toggleGrids3d(): boolean {
  const a = authoring();
  const grids = a?.getGrids?.() ?? [];
  let anyVisible = false;
  for (const g of grids) {
    const mesh = a?.getDatumMesh?.("grid", g.id) ?? a?.getGridMesh?.(g.id);
    if (mesh?.visible) anyVisible = true;
  }
  const next = !anyVisible;
  // try group
  try {
    const group = a?.getGridsGroup?.() ?? (ctx as Any).gridsGroup;
    if (group) {
      group.visible = next;
      notify("success", next ? "Grids ON" : "Grids OFF");
      return next;
    }
  } catch { /* */ }
  for (const g of grids) {
    try {
      const mesh = a?.getDatumMesh?.("grid", g.id) ?? a?.getGridMesh?.(g.id);
      if (mesh) mesh.visible = next;
    } catch { /* */ }
  }
  // scene traverse by userData
  try {
    const scene = (ctx as Any).world?.scene?.three ?? (ctx as Any).world?.scene;
    scene?.traverse?.((o: Any) => {
      if (o.userData?.kind === "grid" || o.userData?.type === "grid") o.visible = next;
    });
  } catch { /* */ }
  notify("success", next ? "Grids ON" : "Grids OFF");
  return next;
}

/* 8 */ export function toggleLevels3d(): boolean {
  const a = authoring();
  let next = true;
  try {
    const group = a?.getLevelsGroup?.() ?? (ctx as Any).levelsGroup;
    if (group) {
      next = !group.visible;
      group.visible = next;
      notify("success", next ? "Levels ON" : "Levels OFF");
      return next;
    }
  } catch { /* */ }
  const levels = a?.getLevels?.() ?? [];
  let any = false;
  for (const lv of levels) {
    const mesh = a?.getDatumMesh?.("level", lv.id) ?? a?.getLevelMesh?.(lv.id);
    if (mesh?.visible) any = true;
  }
  next = !any;
  for (const lv of levels) {
    try {
      const mesh = a?.getDatumMesh?.("level", lv.id) ?? a?.getLevelMesh?.(lv.id);
      if (mesh) mesh.visible = next;
    } catch { /* */ }
  }
  try {
    const scene = (ctx as Any).world?.scene?.three ?? (ctx as Any).world?.scene;
    scene?.traverse?.((o: Any) => {
      if (o.userData?.kind === "level" || o.userData?.type === "level") o.visible = next;
    });
  } catch { /* */ }
  notify("success", next ? "Levels ON" : "Levels OFF");
  return next;
}

/* 9 */ export function measureSelection3d(): Any | null {
  const a = authoring();
  const ids: string[] = a?.getSelectedIds?.() ?? [];
  const box = new THREE.Box3();
  let any = false;
  for (const id of ids) {
    try {
      const el = elements().find((e) => e.id === id);
      const b = el ? a?.getElementWorldBox?.(el) : null;
      if (b && !b.isEmpty()) {
        box.union(b);
        any = true;
        continue;
      }
      const mesh = a?.getMesh?.(id);
      if (mesh) {
        box.expandByObject(mesh);
        any = true;
      }
    } catch { /* */ }
  }
  if (!any) {
    notify("warn", "Select elements to measure");
    return null;
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const report = {
    width: size.x,
    height: size.y,
    depth: size.z,
    diagonal: size.length(),
    center: center.toArray(),
  };
  notify(
    "info",
    `Size ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m · diag ${size.length().toFixed(2)} m`,
  );
  return report;
}

/* 10 */ export async function clearSelection3d(): Promise<void> {
  // clearSelection never existed on the authoring API either — clear via
  // the replace-selection primitive (empty set), same as items 1–2 above.
  try {
    authoring()?.setSelectedIds?.([]);
  } catch { /* */ }
  try {
    const sel = (ctx.features as Any)?.selection;
    sel?.clear?.();
  } catch { /* */ }
  try {
    const vis = await import("./visibility-bridge");
    // no clear on bridge; selection manager
  } catch { /* */ }
  notify("success", "Selection cleared");
}

export function setupCriticalWorkflowPack10(): void {
  const api = {
    selectSimilar3d,
    invertSelection3d,
    ghostSelection3d,
    unghostAll3d,
    cycleWireframe3d,
    toggleOrtho3d,
    toggleGrids3d,
    toggleLevels3d,
    measureSelection3d,
    clearSelection3d,
  };
  (ctx.features as Any).workflowPack10 = api;

  const cmds: Array<[string, string, () => void]> = [
    ["3d-sel-similar", "3D: Select similar", () => void selectSimilar3d()],
    ["3d-sel-invert", "3D: Invert selection", () => void invertSelection3d()],
    ["3d-ghost", "3D: Ghost selection", () => void ghostSelection3d()],
    ["3d-unghost", "3D: Clear ghost", () => void unghostAll3d()],
    ["3d-wireframe", "3D: Toggle wireframe", () => void cycleWireframe3d()],
    ["3d-ortho", "3D: Toggle ortho", () => void toggleOrtho3d()],
    ["3d-grids", "3D: Toggle grids", () => void toggleGrids3d()],
    ["3d-levels", "3D: Toggle levels", () => void toggleLevels3d()],
    ["3d-measure-sel", "3D: Measure selection", () => void measureSelection3d()],
    ["3d-clear-sel", "3D: Clear selection", () => void clearSelection3d()],
  ];
  for (const [id, label, run] of cmds) {
    try {
      window.dispatchEvent(
        new CustomEvent("obs-register-command", {
          detail: { id, label, category: "3D View", run },
        }),
      );
    } catch { /* */ }
  }
  console.log("[workflow-pack-10] 3D selection / display / datums ready");
}
