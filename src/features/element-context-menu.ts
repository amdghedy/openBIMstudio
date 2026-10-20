/**
 * Element Context Menu — right-click any natively created model element
 * and get the full set of available actions (Revit-style).
 *
 * Priority 20 on the input router (after gizmo 100, box-select 50).
 * Works on elements authored in OpenBIMStudio (ctx.elements / authoring
 * store) and on selected fragment items when a native id can be resolved.
 *
 * UI: modern flat Fluent card — Segoe UI, rounded corners, subtle border
 * and shadow, ~18 px spacing. Tokens match the rest of the shell.
 */

import * as THREE from "three";
import { ctx } from "../core/context";
import { tryUse } from "../core/services";
import {
  getElementById,
  getSelectedIds,
  setSelectedAuthored,
  selectAllAuthored,
  removeElementById,
  deleteSelectedElement,
  setElementVisibility,
  createSimilarFromSelection,
  getElements,
} from "./authoring";

/* ── Design tokens (Fluent-inspired light) ─────────────────────────── */
const TOKENS = {
  bg: "#ffffff",
  surface: "#f8f9fa",
  accent: "#0078d4",
  accentHover: "#106ebe",
  text: "#1a1a1a",
  textMuted: "#605e5c",
  border: "#e1dfdd",
  success: "#107c10",
  warning: "#ffb900",
  error: "#d13438",
  shadow: "0 4px 16px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08)",
  radius: "8px",
  font: '"Segoe UI", system-ui, -apple-system, sans-serif',
  itemH: 32,
  pad: 6,
  width: 240,
};

/* ── Menu item model ───────────────────────────────────────────────── */
export interface CtxMenuItem {
  id: string;
  label: string;
  icon?: string;          // emoji or short text glyph
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  submenu?: CtxMenuItem[];
  action?: () => void | Promise<void>;
}

type Any = Record<string, any>;

/* ── State ─────────────────────────────────────────────────────────── */
let menuEl: HTMLDivElement | null = null;
let open = false;
let lastHit: { elementId: string | null; worldPoint: THREE.Vector3 | null } = {
  elementId: null,
  worldPoint: null,
};
let unsub: (() => void) | null = null;
let installed = false;

/* ── Helpers ───────────────────────────────────────────────────────── */
function toast(message: string, kind: "info" | "success" | "warn" | "error" = "info") {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
}

function getNativeElements(): Any[] {
  try {
    return getElements() as Any[];
  } catch {
    return ((ctx as Any).elements as Any[]) ?? (window as Any).__obsElements ?? [];
  }
}

function resolveElementUnderCursor(
  clientX: number,
  clientY: number,
): { elementId: string | null; worldPoint: THREE.Vector3 | null } {
  const host =
    (ctx as Any).rightHost ??
    document.getElementById("viewport") ??
    document.querySelector(".obs-viewport") ??
    document.querySelector("canvas")?.parentElement;
  if (!host) return { elementId: null, worldPoint: null };

  const canvas = host.querySelector("canvas") as HTMLCanvasElement | null;
  if (!canvas) return { elementId: null, worldPoint: null };

  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((clientY - rect.top) / rect.height) * 2 + 1;

  const camera =
    (ctx as Any).world?.camera?.three ??
    (ctx as Any).world?.camera ??
    (ctx as Any).camera;
  const scene =
    (ctx as Any).world?.scene?.three ??
    (ctx as Any).world?.scene ??
    (ctx as Any).scene;

  if (!camera || !scene) return { elementId: null, worldPoint: null };

  const raycaster = new THREE.Raycaster();
  // Prefer BVH-accelerated path when the performance engine is present
  try {
    const perf = (window as Any).__obsPerfEngine;
    if (perf?.raycast) {
      const hit = perf.raycast(clientX, clientY);
      if (hit?.elementId) {
        return {
          elementId: String(hit.elementId),
          worldPoint: hit.point ? new THREE.Vector3().copy(hit.point) : null,
        };
      }
    }
  } catch { /* fall through */ }

  raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
  const meshes: THREE.Object3D[] = [];
  scene.traverse((o: THREE.Object3D) => {
    if ((o as THREE.Mesh).isMesh && o.visible) meshes.push(o);
  });
  const hits = raycaster.intersectObjects(meshes, true);
  if (!hits.length) return { elementId: null, worldPoint: null };

  // Walk up userData for an authored element id
  for (const h of hits) {
    let obj: THREE.Object3D | null = h.object;
    while (obj) {
      const ud = obj.userData ?? {};
      const id =
        ud.elementId ??
        ud.id ??
        ud.obsId ??
        ud.localId ??
        (obj as Any).elementId;
      if (id != null) {
        return {
          elementId: String(id),
          worldPoint: h.point.clone(),
        };
      }
      obj = obj.parent;
    }
  }
  return { elementId: null, worldPoint: hits[0]?.point?.clone() ?? null };
}

function ensureSelected(elementId: string | null) {
  if (!elementId) return;
  const selected = getSelectedIds();
  if (selected.includes(elementId)) return;
  try {
    setSelectedAuthored([elementId], "replace");
  } catch {
    try {
      selectAllAuthored([elementId]);
    } catch {
      try {
        (tryUse("selection") as Any)?.applyClick?.(
          "native",
          Number(elementId) || elementId,
          {},
        );
      } catch { /* */ }
    }
  }
}

/* ── Build menu items for current selection ────────────────────────── */
function buildItems(elementId: string | null): CtxMenuItem[] {
  const selected = getSelectedIds();
  const count = selected.length || (elementId ? 1 : 0);
  const hasSelection = count > 0;
  const el = elementId ? getElementById(elementId) : null;
  const type = (el as Any)?.type ?? (el as Any)?.category ?? "Element";

  const items: CtxMenuItem[] = [];

  // Header
  items.push({
    id: "header",
    label: hasSelection
      ? count === 1
        ? `${type}`
        : `${count} elements selected`
      : "No selection",
    disabled: true,
  });
  items.push({ id: "sep0", label: "", separator: true });

  // ── Selection ──
  items.push({
    id: "properties",
    label: "Properties",
    icon: "ℹ",
    shortcut: "Ctrl+1",
    disabled: !hasSelection,
    action: () => {
      (window as Any).__obsProperties?.open?.(elementId ?? selected[0]);
      (window as Any).__obsBimCommandCenter?.open?.();
      toast("Properties", "info");
    },
  });
  items.push({
    id: "edit-type",
    label: "Edit Type…",
    icon: "✎",
    disabled: !hasSelection,
    action: () => {
      (window as Any).__obsParametricFamilyPanel?.open?.(elementId ?? selected[0]);
      toast("Edit Type", "info");
    },
  });
  items.push({ id: "sep1", label: "", separator: true });

  // ── Visibility ──
  items.push({
    id: "isolate",
    label: "Isolate",
    icon: "◎",
    shortcut: "Ctrl+I",
    disabled: !hasSelection,
    action: () => {
      (window as Any).__obsSelectionBox?.isolate?.() ??
        (window as Any).__obsVisibility?.isolate?.(selected);
      toast("Isolated selection", "success");
    },
  });
  items.push({
    id: "hide",
    label: "Hide",
    icon: "◌",
    disabled: !hasSelection,
    action: () => {
      try {
        (window as Any).__obsVisibility?.hide?.(selected);
      } catch { /* */ }
      for (const id of selected) {
        try {
          setElementVisibility(id, false);
        } catch {
          const e = getElementById(id);
          const mesh = (e as Any)?.mesh ?? (ctx as Any).__obsGetElementMesh?.(id);
          if (mesh) mesh.visible = false;
        }
      }
      toast(`Hidden ${selected.length} element(s)`, "info");
    },
  });
  items.push({
    id: "reset-iso",
    label: "Reset Isolation",
    icon: "◉",
    shortcut: "Ctrl+Shift+I",
    action: () => {
      (window as Any).__obsSelectionBox?.resetIsolation?.() ??
        (window as Any).__obsVisibility?.reset?.();
      toast("Isolation reset", "info");
    },
  });
  items.push({ id: "sep2", label: "", separator: true });

  // ── View / Crop ──
  items.push({
    id: "zoom-sel",
    label: "Zoom to Selection",
    icon: "⊕",
    shortcut: "Ctrl+Shift+Z",
    disabled: !hasSelection,
    action: () => {
      (window as Any).__obsSelectionBox?.zoom?.();
      try {
        (tryUse("selection") as Any)?.focus?.();
      } catch { /* */ }
    },
  });
  items.push({
    id: "sel-box",
    label: "Selection Box",
    icon: "▢",
    shortcut: "Ctrl+Shift+B",
    disabled: !hasSelection,
    action: () => {
      (window as Any).__obsSelectionBox?.show?.({ padding: 0.5 });
    },
  });
  items.push({
    id: "crop-sel",
    label: "Crop to Selection",
    icon: "✂",
    shortcut: "Ctrl+Shift+R",
    disabled: !hasSelection,
    action: () => {
      (window as Any).__obsSelectionBox?.cropTo?.({ padding: 1.0 });
    },
  });
  items.push({ id: "sep3", label: "", separator: true });

  // ── Modify ──
  items.push({
    id: "create-similar",
    label: "Create Similar",
    icon: "⧉",
    disabled: !hasSelection,
    action: () => {
      try {
        createSimilarFromSelection();
      } catch {
        (window as Any).__obsRevitParity?.createSimilar?.(elementId ?? selected[0]);
        (window as Any).__obsBimParity?.createSimilar?.(elementId ?? selected[0]);
      }
      toast("Create Similar — place next instance", "info");
    },
  });
  items.push({
    id: "match-props",
    label: "Match Properties",
    icon: "⇄",
    disabled: !hasSelection,
    action: () => {
      (window as Any).__obsRevitParity?.matchProperties?.(elementId ?? selected[0]);
      (window as Any).__obsBimParity?.matchProperties?.(elementId ?? selected[0]);
      toast("Match Properties — pick target", "info");
    },
  });
  items.push({
    id: "select-similar",
    label: "Select Similar",
    icon: "⊞",
    disabled: !hasSelection,
    action: async () => {
      try {
        const sel = tryUse("selection") as Any;
        if (sel?.selectSimilar && elementId) {
          await sel.selectSimilar("native", Number(elementId) || elementId);
        } else {
          const src = getElementById(elementId ?? selected[0]);
          const cat = (src as Any)?.type ?? (src as Any)?.category;
          if (!cat) return;
          const all = getNativeElements().filter(
            (e) => (e.type ?? e.category) === cat,
          );
          selectAllAuthored(all.map((e) => String(e.id)));
        }
        toast("Select Similar", "success");
      } catch (e) {
        console.warn("[ctx-menu] selectSimilar", e);
      }
    },
  });
  items.push({
    id: "align",
    label: "Align…",
    icon: "↔",
    disabled: count < 2,
    action: () => {
      (window as Any).__obsAlign?.start?.("x");
      toast("Align tool", "info");
    },
  });
  items.push({ id: "sep4", label: "", separator: true });

  // ── Group / Phase ──
  items.push({
    id: "group",
    label: "Create Group",
    icon: "▦",
    disabled: !hasSelection,
    action: () => {
      (window as Any).__obsGroups?.create?.(selected);
      toast("Group created", "success");
    },
  });
  items.push({
    id: "phase",
    label: "Assign Phase…",
    icon: "◷",
    disabled: !hasSelection,
    action: () => {
      (window as Any).__obsPhases?.openPanel?.();
      toast("Phases panel", "info");
    },
  });
  items.push({ id: "sep5", label: "", separator: true });

  // ── Annotation ──
  items.push({
    id: "tag",
    label: "Tag Element",
    icon: "🏷",
    disabled: !hasSelection,
    action: () => {
      (window as Any).__obsTags?.place?.(elementId ?? selected[0]);
      toast("Tag", "info");
    },
  });
  items.push({
    id: "dim",
    label: "Dimension",
    icon: "↔",
    disabled: !hasSelection,
    action: () => {
      (window as Any).__obsTempDims?.start?.();
      toast("Temporary dimensions", "info");
    },
  });
  items.push({ id: "sep6", label: "", separator: true });

  // ── Delete ──
  items.push({
    id: "delete",
    label: count > 1 ? `Delete ${count} Elements` : "Delete",
    icon: "🗑",
    shortcut: "Del",
    disabled: !hasSelection,
    danger: true,
    action: () => {
      const ids = selected.length ? selected : elementId ? [elementId] : [];
      if (!ids.length) return;
      try {
        setSelectedAuthored(ids, "replace");
        deleteSelectedElement();
      } catch {
        for (const id of ids) {
          try {
            removeElementById(id);
          } catch {
            const e = getElementById(id);
            const mesh = (e as Any)?.mesh;
            if (mesh?.parent) mesh.parent.remove(mesh);
          }
        }
      }
      toast(`Deleted ${ids.length} element(s)`, "success");
    },
  });

  return items;
}

/* ── DOM menu ──────────────────────────────────────────────────────── */
function ensureMenu(): HTMLDivElement {
  if (menuEl) return menuEl;
  const el = document.createElement("div");
  el.id = "obs-element-ctx-menu";
  el.setAttribute("role", "menu");
  el.style.cssText = `
    position: fixed;
    z-index: 10050;
    min-width: ${TOKENS.width}px;
    max-width: 320px;
    max-height: min(70vh, 520px);
    overflow-y: auto;
    background: ${TOKENS.bg};
    color: ${TOKENS.text};
    font-family: ${TOKENS.font};
    font-size: 13px;
    border: 1px solid ${TOKENS.border};
    border-radius: ${TOKENS.radius};
    box-shadow: ${TOKENS.shadow};
    padding: ${TOKENS.pad}px 0;
    display: none;
    user-select: none;
    -webkit-font-smoothing: antialiased;
  `;
  document.body.appendChild(el);
  menuEl = el;
  return el;
}

function renderItems(items: CtxMenuItem[]) {
  const root = ensureMenu();
  root.innerHTML = "";
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.style.cssText = `
        height: 1px;
        background: ${TOKENS.border};
        margin: 4px 10px;
      `;
      root.appendChild(sep);
      continue;
    }

    const row = document.createElement("button");
    row.type = "button";
    row.setAttribute("role", "menuitem");
    row.disabled = !!item.disabled;
    row.style.cssText = `
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      height: ${TOKENS.itemH}px;
      padding: 0 14px;
      border: none;
      background: transparent;
      color: ${item.danger ? TOKENS.error : item.disabled ? TOKENS.textMuted : TOKENS.text};
      font-family: inherit;
      font-size: 13px;
      text-align: left;
      cursor: ${item.disabled ? "default" : "pointer"};
      opacity: ${item.disabled ? 0.55 : 1};
      transition: background 0.08s ease;
    `;

    const icon = document.createElement("span");
    icon.style.cssText = `width: 18px; text-align: center; flex-shrink: 0; opacity: 0.85;`;
    icon.textContent = item.icon ?? "";
    row.appendChild(icon);

    const label = document.createElement("span");
    label.style.cssText = `flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`;
    label.textContent = item.label;
    row.appendChild(label);

    if (item.shortcut) {
      const kbd = document.createElement("span");
      kbd.style.cssText = `
        font-size: 11px;
        color: ${TOKENS.textMuted};
        margin-left: 8px;
        flex-shrink: 0;
      `;
      kbd.textContent = item.shortcut;
      row.appendChild(kbd);
    }

    if (!item.disabled && item.action) {
      row.addEventListener("mouseenter", () => {
        row.style.background = item.danger ? "rgba(209,52,56,0.08)" : TOKENS.surface;
      });
      row.addEventListener("mouseleave", () => {
        row.style.background = "transparent";
      });
      row.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        hide();
        try {
          await item.action!();
        } catch (err) {
          console.warn("[ctx-menu] action failed", item.id, err);
          toast(`Action failed: ${item.label}`, "error");
        }
      });
    }

    root.appendChild(row);
  }
}

function positionMenu(clientX: number, clientY: number) {
  const el = ensureMenu();
  el.style.display = "block";
  // Measure after display
  const rect = el.getBoundingClientRect();
  const pad = 8;
  let left = clientX;
  let top = clientY;
  if (left + rect.width > window.innerWidth - pad) {
    left = Math.max(pad, clientX - rect.width);
  }
  if (top + rect.height > window.innerHeight - pad) {
    top = Math.max(pad, window.innerHeight - rect.height - pad);
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

export function show(clientX: number, clientY: number, elementId: string | null) {
  ensureSelected(elementId);
  const items = buildItems(elementId);
  renderItems(items);
  positionMenu(clientX, clientY);
  open = true;
}

export function hide() {
  if (!menuEl) return;
  menuEl.style.display = "none";
  open = false;
}

function onDocPointerDown(e: Event) {
  if (!open || !menuEl) return;
  if (menuEl.contains(e.target as Node)) return;
  hide();
}

function onKeyDown(e: KeyboardEvent) {
  if (!open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    hide();
  }
}

/* ── Input-router integration ──────────────────────────────────────── */
function onContextMenuGesture(e: MouseEvent) {
  // Already prevented by input-router; we own the menu.
  const hit = resolveElementUnderCursor(e.clientX, e.clientY);
  lastHit = hit;
  show(e.clientX, e.clientY, hit.elementId);
}

/**
 * Install the element context menu.
 * Safe to call multiple times (idempotent).
 */
export function setupElementContextMenu(): void {
  if (installed) return;
  installed = true;

  // Capture-phase on the viewport host so we still receive the event after
  // input-router preventDefault.
  const attach = () => {
    const host =
      (ctx as Any).rightHost ??
      document.getElementById("viewport") ??
      document.querySelector(".obs-viewport") ??
      document.body;
    if (!host) return false;

    const handler = (e: Event) => {
      const me = e as MouseEvent;
      // Ignore right-clicks that originate on UI chrome (ribbon, panels, etc.)
      const t = me.target as HTMLElement | null;
      if (t?.closest?.("#obs-element-ctx-menu, .obs-ribbon, .obs-panel, .obs-modal, [data-obs-ui]")) {
        return;
      }
      me.preventDefault();
      me.stopPropagation();
      onContextMenuGesture(me);
    };

    host.addEventListener("contextmenu", handler, { capture: true });
    document.addEventListener("pointerdown", onDocPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);

    unsub = () => {
      host.removeEventListener("contextmenu", handler, true);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      hide();
      menuEl?.remove();
      menuEl = null;
      installed = false;
    };
    return true;
  };

  if (!attach()) {
    // Retry until viewport exists
    const t = window.setInterval(() => {
      if (attach()) clearInterval(t);
    }, 200);
    window.setTimeout(() => clearInterval(t), 15000);
  }

  // Expose for console / tests
  (window as Any).__obsElementCtxMenu = {
    show,
    hide,
    buildItems,
    lastHit: () => lastHit,
  };

  console.info("[element-context-menu] ready — right-click any native element");
}

export function disposeElementContextMenu(): void {
  unsub?.();
  unsub = null;
}
