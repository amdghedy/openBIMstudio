/**
 * Right-click context menu (Autodesk-style).
 *
 * Extended in v3.1 with:
 *   - Edit operations for authored selection (Move/Copy/Rotate/Mirror/Array/Offset/Delete)
 *   - Multi-select actions (Select all / Invert / Select similar / Clear)
 *   - Selection sets (save / load / delete)
 *   - Undo / Redo with live labels
 *   - Gizmo mode toggle
 *   - Snapping toggle
 */
import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { ctx } from "../core/context";
import { inputRouter } from "../core/input-router";
import {
  fitToMap, focusOnPoint, focusOnBox, zoomBy, gotoDir, saveHome, goHome, fitAll, handleRightClickFocus,
  setOrbitPivot, pivotOnSelection,
  takeScreenshot, setProjection, getProjection,
} from "./camera-tools";
import { isMeasureEnabled, toggleMeasure } from "./measure";
import { isSectionOn, toggleSection } from "./section";
import { getItemMeta } from "./item-meta";
import { history } from "./history";
import { selection } from "./selection";
import { snapping } from "./snapping";
import { gizmo, type GizmoMode } from "./gizmo";
import {
  getActiveTool as getAuthoringTool,
  getSelectedIds as getAuthoredSelection,
  setAuthoringTool,
  deleteSelectedElement,
} from "./authoring";
import { beginEdit, beginEditFromSelection, openFragEditPanel } from "./frag-edit";
import { toggleBimObjectStudio } from "./bim-object-studio";

type MenuItem =
  | { type: "sep" }
  | { type: "label"; text: string }
  | {
      type: "action";
      text: string;
      icon?: string;
      onclick: () => void;
      disabled?: boolean;
      checked?: boolean;
    }
  | { type: "sub"; text: string; icon?: string; items: MenuItem[] };

type IdMap = Record<string, Set<number>>;

const ctxMenu = document.createElement("div");
ctxMenu.style.cssText =
  "position:absolute;z-index:100;display:none;min-width:260px;max-height:calc(100vh - 24px);overflow-y:auto;overflow-x:visible;overscroll-behavior:contain;background:var(--bg-floating,#1e1f26);border:1px solid var(--border-default,#3a3a4a);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);font:12px system-ui,sans-serif;color:var(--text-primary,#e2e8f0);padding:4px 0";
ctxMenu.addEventListener("mousedown", (e) => e.stopPropagation());

function closeCtxMenu() {
  ctxMenu.style.display = "none";
}
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c],
  );
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

// ════════════════════════════════════════════════════════════════════════
//  Raycast extraction (SDK-version tolerant, unchanged from v3.0)
// ════════════════════════════════════════════════════════════════════════
function isNumericSet(v: any): v is Set<number> {
  if (!(v instanceof Set) || v.size === 0) return false;
  for (const x of v) if (typeof x !== "number") return false;
  return true;
}

function scanForIdMaps(root: any, maxDepth = 4): IdMap {
  const out: IdMap = {};
  const visit = (node: any, depth: number) => {
    if (!node || depth > maxDepth) return;
    if (node instanceof Map) {
      for (const [k, v] of node) {
        if (isNumericSet(v)) out[String(k)] = v;
        else visit(v, depth + 1);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) visit(v, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (isNumericSet(v)) out[k] = v as Set<number>;
      else if (v && typeof v === "object") visit(v, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

function extractSelection(): { map: IdMap; debug: string } {
  const hl: any = ctx.highlighter;
  if (!hl) return { map: {}, debug: "no highlighter" };
  let map = scanForIdMaps(hl.selection, 4);
  if (Object.keys(map).length) return { map, debug: "from hl.selection" };
  for (const k of Object.keys(hl)) {
    if (/select|highlight|current/i.test(k)) {
      map = { ...map, ...scanForIdMaps(hl[k], 4) };
    }
  }
  if (Object.keys(map).length) return { map, debug: "from hl scan" };
  return {
    map: {},
    debug: `selection empty (hl keys: ${Object.keys(hl).slice(0, 12).join(",")})`,
  };
}

function extractFromRay(r: any): {
  localId?: number;
  modelId?: string;
  model?: any;
  debug: string;
} {
  if (!r) return { debug: "castRay returned null" };
  let localId: number | undefined;
  let modelId: string | undefined;
  let model: any;

  const tryModel = (m: any) => {
    if (!m || typeof m !== "object") return;
    if (!model) model = m;
    if (modelId === undefined) {
      if (typeof m.modelId === "string") modelId = m.modelId;
      else if (typeof m.id === "string") modelId = m.id;
    }
  };

  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 3) return;
    if (node instanceof Map) {
      for (const v of node.values()) visit(v, depth + 1);
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) visit(v, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (localId === undefined && typeof v === "number" && /localid|local_id|itemid|expressid/i.test(k))
        localId = v;
      if (modelId === undefined && typeof v === "string" && /modelid|model_id/i.test(k))
        modelId = v;
      if (/model|fragment/i.test(k) && v && typeof v === "object") {
        if (Array.isArray(v)) v.forEach(tryModel);
        else {
          tryModel(v);
          visit(v, depth + 1);
        }
      } else if (v && typeof v === "object") {
        visit(v, depth + 1);
      }
    }
  };
  visit(r, 0);

  // ThatOpen Raycasters expose the selected model through fragments.modelId.
  // Prefer that canonical field before walking the object graph.
  if (modelId === undefined) {
    const direct = r?.fragments?.modelId ?? r?.fragments?.[0]?.modelId ?? r?.modelId;
    if (typeof direct === "string") modelId = direct;
  }

  if (model && (modelId === undefined || !ctx.fragments.list.has(modelId))) {
    for (const [id, m] of ctx.fragments.list as any) {
      if (m === model || m?.object === model || model.model === m) {
        modelId = id;
        break;
      }
    }
  }

  const debug =
    `keys: [${Object.keys(r).join(", ")}]` +
    ` · localId=${localId ?? "?"} · modelId=${modelId ?? "?"}`;
  return { localId, modelId, model, debug };
}

// ════════════════════════════════════════════════════════════════════════
//  Hider (SDK fallbacks preserved)
// ════════════════════════════════════════════════════════════════════════
async function hideMap(map: IdMap) {
  const h: any = ctx.hider;
  if (!h) {
    alert("Hider component not available.");
    return;
  }
  if (typeof h.hide === "function") {
    try {
      await h.hide(map);
      return;
    } catch (e) {
      console.warn("[hider.hide]", e);
    }
  }
  if (typeof h.set === "function") {
    try {
      await h.set(false, map);
      return;
    } catch (e) {
      console.warn("[hider.set]", e);
    }
  }
  alert("Hide is not supported by this SDK version — see console.");
}

async function isolateMap(map: IdMap) {
  const h: any = ctx.hider;
  if (!h) {
    alert("Hider component not available.");
    return;
  }
  if (typeof h.isolate === "function") {
    try {
      await h.isolate(map);
      return;
    } catch (e) {
      console.warn("[hider.isolate]", e);
    }
  }
  if (typeof h.set === "function") {
    try {
      await h.set(false);
      await h.set(true, map);
      return;
    } catch (e) {
      console.warn("[hider.set isolate]", e);
    }
  }
  alert("Isolate is not supported by this SDK version — see console.");
}

async function showAllElements() {
  const h: any = ctx.hider;
  if (!h) return;
  if (typeof h.show === "function") {
    try {
      await h.show();
      return;
    } catch (e) {
      console.warn("[hider.show]", e);
    }
  }
  if (typeof h.set === "function") {
    try {
      await h.set(true);
      return;
    } catch (e) {
      console.warn("[hider.set show]", e);
    }
  }
  if (typeof h.reset === "function") {
    try {
      await h.reset();
      return;
    } catch (e) {
      console.warn("[hider.reset]", e);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
//  Menu rendering
// ════════════════════════════════════════════════════════════════════════
function renderMenuItems(container: HTMLElement, items: MenuItem[]) {
  for (const it of items) {
    if (it.type === "sep") {
      const d = document.createElement("div");
      d.style.cssText = "height:1px;background:var(--border-default,#3a3a4a);margin:4px 8px";
      container.appendChild(d);
      continue;
    }
    if (it.type === "label") {
      const d = document.createElement("div");
      d.style.cssText =
        "padding:4px 12px 2px;font-size:10px;letter-spacing:.5px;opacity:.55;white-space:nowrap";
      d.textContent = it.text;
      container.appendChild(d);
      continue;
    }
    const row = document.createElement("div");
    const disabled = it.type === "action" && it.disabled;
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;white-space:nowrap;position:relative" +
      (disabled ? ";opacity:.35;pointer-events:none" : "");
    row.innerHTML =
      `<span style="width:18px;text-align:center">${it.type === "sub" ? (it.icon ?? "▸") : (it.icon ?? "")}</span>` +
      `<span style="flex:1">${escapeHtml(it.text)}</span>` +
      (it.type === "sub" ? `<span style="opacity:.6">▸</span>` : "") +
      (it.type === "action" && it.checked ? `<span style="color:#22c55e;font-weight:700">✓</span>` : "");

    if (it.type === "action") {
      row.onclick = () => {
        closeCtxMenu();
        it.onclick();
      };
    } else if (it.type === "sub") {
      const sub = document.createElement("div");
      sub.style.cssText =
        "display:none;position:absolute;top:-5px;min-width:220px;max-height:calc(100vh - 36px);overflow-y:auto;overflow-x:visible;background:var(--bg-floating,#1e1f26);border:1px solid var(--border-default,#3a3a4a);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);padding:4px 0;z-index:101";
      renderMenuItems(sub, it.items);
      let hideTimer = 0;
      row.onmouseenter = () => {
        clearTimeout(hideTimer);
        const hostRect = ctx.rightHost.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const openLeft = rowRect.right + 220 > hostRect.right;
        sub.style.left = openLeft ? "auto" : "calc(100% - 2px)";
        sub.style.right = openLeft ? "calc(100% - 2px)" : "auto";
        sub.style.display = "block";
      };
      row.onmouseleave = () => {
        hideTimer = window.setTimeout(() => { sub.style.display = "none"; }, 120);
      };
      sub.onmouseenter = () => clearTimeout(hideTimer);
      sub.onmouseleave = () => { sub.style.display = "none"; };
      row.appendChild(sub);
    }
    row.addEventListener("mouseenter", () => {
      row.style.background = "var(--bg-hover,#2c2d38)";
    });
    row.addEventListener("mouseleave", () => {
      row.style.background = "transparent";
    });
    container.appendChild(row);
  }
}

// ════════════════════════════════════════════════════════════════════════
//  Picking
// ════════════════════════════════════════════════════════════════════════
type PickResult = {
  map?: IdMap;
  name?: string;
  point?: THREE.Vector3;
  debug: string;
  selDebug: string;
};

async function pickElementAt(): Promise<PickResult> {
  const selRes = extractSelection();
  let r: any = null;
  try {
    const caster = ctx.components.get(OBC.Raycasters).get(ctx.world);
    r = await caster.castRay();
  } catch (err) {
    return { debug: `castRay threw: ${String(err)}`, selDebug: selRes.debug };
  }
  if (!r) return { debug: "castRay: no hit", selDebug: selRes.debug };

  const point = r.point ? new THREE.Vector3().copy(r.point) : undefined;
  const ex = extractFromRay(r);

  if (ex.localId != null && ex.modelId != null && ctx.fragments.list.has(ex.modelId)) {
    try {
      const model = ctx.fragments.list.get(ex.modelId)!;
      const meta = await getItemMeta(model as any, ex.localId);
      return {
        map: { [ex.modelId]: new Set([ex.localId]) },
        name: meta.name,
        point,
        debug: `OK: ${meta.name}`,
        selDebug: selRes.debug,
      };
    } catch {
      /* fall through */
    }
  }
  return { point, debug: ex.debug, selDebug: selRes.debug };
}

let lastPickDebug: PickResult | null = null;

// ════════════════════════════════════════════════════════════════════════
//  Menu content
// ════════════════════════════════════════════════════════════════════════
function buildSelectionSetSubmenu(): MenuItem[] {
  const sets = selection.listSets();
  if (!sets.length) {
    return [{ type: "action", text: "No saved sets", onclick: () => {}, disabled: true }];
  }
  return sets.slice(0, 20).map<MenuItem>((s) => ({
    type: "action",
    text: `${truncate(s.name, 32)} (${Object.values(s.snapshot).reduce((a, arr) => a + arr.length, 0)})`,
    onclick: () => void selection.loadSet(s.id),
  }));
}

function buildGizmoSubmenu(): MenuItem[] {
  const m = gizmo.getMode();
  const set = (mode: GizmoMode) => {
    gizmo.setMode(mode);
    (window as any).__obs_setGizmo?.(mode);
  };
  return [
    { type: "action", text: "Move (G)", icon: "", checked: m === "move", onclick: () => set("move") },
    { type: "action", text: "Rotate (R)", icon: "", checked: m === "rotate", onclick: () => set("rotate") },
    { type: "action", text: "Scale (S)", icon: "", checked: m === "scale", onclick: () => set("scale") },
    { type: "sep" },
    { type: "action", text: "Off (Q)", icon: "", checked: m === "none", onclick: () => set("none") },
  ];
}

async function openCtxMenu(e: MouseEvent) {
  (window as any).__obsLastCtxEvent = e;
  const picked = await pickElementAt();
  lastPickDebug = picked;
  const sel = extractSelection().map;
  const managerSel = selection.snapshot();
  const selCount = Object.values(sel).reduce((a, v) => a + (v?.size ?? 0), 0);
  const managerCount = Object.values(managerSel).reduce((a, v) => a + (v?.size ?? 0), 0);
  const actionMap: IdMap = selCount > 0 ? sel : managerCount > 0 ? managerSel : (picked.map ?? {});
  const actionCount = Object.values(actionMap).reduce((a, v) => a + (v?.size ?? 0), 0);
  const editMap: IdMap = picked.map && Object.keys(picked.map).length ? picked.map : actionMap;
  const canHide = !!ctx.hider;

  const authoredIds = getAuthoredSelection();
  const hasAuthored = authoredIds.length > 0;
  const canFocus = actionCount > 0 || !!picked.point || hasAuthored;

  const items: MenuItem[] = [];

  // ── Header ──
  if (hasAuthored) {
    items.push({ type: "label", text: `Authored: ${authoredIds.length} element(s)` });
  } else if (picked.name) {
    items.push({ type: "label", text: `Element: ${truncate(picked.name, 30)}` });
  } else if (selCount > 0) {
    items.push({ type: "label", text: `Selection: ${selCount} item(s)` });
  }

  // ── Camera ──
  items.push({
            type: "action",
            text: "Focus",
            icon: "",
            onclick: () => {
              void (async () => {
                try {
                  const m: any = await import("./focus-service");
                  const ev: any = (window as any).__obsLastCtxEvent ?? null;
                  const ok = await m.focusSelected(ev);

                  if (!ok) {
                    try {
                      const n: any = await import("../core/notify");
                      n.toast?.("Nothing selected to focus.", "warn");
                    } catch {
                      /* notify optional */
                    }
                  }
                } catch (err) {
                  console.warn("[context-menu] Focus selected object failed", err);
                }
              })();
            },
          });
    items.push({ type: "action", text: "Zoom In", icon: "+", onclick: () => zoomBy(0.8) });
  items.push({ type: "action", text: "Zoom Out", icon: "", onclick: () => zoomBy(1.25) });
  items.push({ type: "action", text: "Zoom to Fit", icon: "", onclick: () => fitAll() });
  items.push({
    type: "sub",
    text: "Visibility",
    icon: "",
    items: [
      { type: "action", text: "Hide in View", icon: "", onclick: () => { void ctxHide(); } },
      { type: "action", text: "Isolate in View", icon: "", onclick: () => { void ctxIsolate(); } },
      { type: "sep" },
      { type: "action", text: "Show All / Reset", icon: "", onclick: () => { void ctxShowAll(); } },
    ],
  });
  // ── Selection Box + Crop to Selection (BIM right-click parity) ──
  items.push({
    type: "sub",
    text: "Selection Box",
    icon: "",
    items: [
      { type: "action", text: "Show Selection Box", icon: "", onclick: () => {
        (window as any).__obsSelectionBox?.show?.({ padding: 0.5 });
      } },
      { type: "action", text: "Crop to Selection", icon: "", onclick: () => {
        (window as any).__obsSelectionBox?.cropTo?.({ padding: 1.0 });
      } },
      { type: "action", text: "Zoom to Selection", icon: "", onclick: () => {
        (window as any).__obsSelectionBox?.zoom?.();
      } },
      { type: "sep" },
      { type: "action", text: "Isolate", icon: "", onclick: () => {
        (window as any).__obsSelectionBox?.isolate?.();
      } },
      { type: "action", text: "Reset Isolation", icon: "", onclick: () => {
        (window as any).__obsSelectionBox?.resetIsolation?.();
      } },
    ],
  });
  items.push({ type: "sep" });

  // ── Authored edit operations ──
  if (hasAuthored) {
    const setTool = (t: string) => setAuthoringTool(t as any);
    const curTool = getAuthoringTool();
    items.push({
      type: "sub",
      text: "Modify",
      icon: "",
      items: [
        { type: "action", text: "Move", icon: "", checked: curTool === "move", onclick: () => setTool("move") },
        { type: "action", text: "Copy", icon: "", checked: curTool === "copy", onclick: () => setTool("copy") },
        { type: "action", text: "Rotate", icon: "", checked: curTool === "rotate", onclick: () => setTool("rotate") },
        { type: "action", text: "Mirror", icon: "", checked: curTool === "mirror", onclick: () => setTool("mirror") },
        { type: "action", text: "Array", icon: "", checked: curTool === "array", onclick: () => setTool("array") },
        { type: "action", text: "Offset", icon: "", checked: curTool === "offset", onclick: () => setTool("offset") },
        { type: "sep" },
        {
          type: "action",
          text: "Delete",
          icon: "",
          onclick: () => deleteSelectedElement(),
        },
      ],
    });
    items.push({ type: "sep" });
  }

  // ── OpenBIM authoring / Native Twin ──
  items.push({
    type: "action",
    text: "Make Editable Native Twin",
    icon: "",
    disabled: actionCount === 0,
    onclick: async () => {
      let created = 0;
      const source = Object.keys(editMap).length ? editMap : selection.snapshot();
      for (const [modelId, ids] of Object.entries(source)) {
        for (const id of ids) {
          const twin = await beginEdit(modelId, id);
          if (twin) created++;
          else {
            try {
              window.dispatchEvent(new CustomEvent("obs-toast", {
                detail: {
                  message: `Native Twin could not be created for ${modelId} / ${id}. The loaded source model returned no usable per-item geometry; no approximate object was created.`,
                  kind: "error",
                },
              }));
            } catch { /* */ }
          }
        }
      }
      if (!created) {
        const fallback = await beginEditFromSelection();
        created = fallback;
      }
      if (created) openFragEditPanel();
    },
  });
  items.push({
    type: "action",
    text: "Properties",
    icon: "",
    disabled: actionCount === 0 && !picked.map && !hasAuthored,
    onclick: async () => {
      try {
        const pp: any = (ctx.features as any).propertyPalette;
        if (pp?.open) pp.open();
        if (picked.map) await (ctx.props.update as any)?.(picked.map);
      } catch { /* property palette is optional */ }
    },
  });
  items.push({
    type: "action",
    text: "BIM Object Studio",
    icon: "",
    onclick: () => toggleBimObjectStudio(),
  });
  items.push({ type: "sep" });

  // ── Selection ops ──
  items.push({
    type: "action",
    text: "Select Similar",
    icon: "",
    disabled: !picked.map || !picked.name,
    onclick: async () => {
      if (!picked.map) return;
      const first = Object.entries(picked.map)[0];
      if (!first) return;
      const [modelId, ids] = first;
      const localId = [...ids][0];
      await selection.selectSimilar(modelId, localId);
    },
  });
  items.push({
    type: "action",
    text: "Select All",
    icon: "",
    onclick: () => void selection.selectAll(),
  });
  items.push({
    type: "action",
    text: "Invert Selection",
    icon: "",
    onclick: () => void selection.invert(),
  });
  items.push({
    type: "action",
    text: "Clear Selection",
    icon: "",
    disabled: selection.isEmpty() && !hasAuthored,
    onclick: async () => {
      selection.clear();
      await selection.applyToHighlighter();
    },
  });
  items.push({
    type: "sub",
    text: "Selection Sets",
    icon: "",
    items: [
      {
        type: "action",
        text: "Save current as set",
        icon: "",
        disabled: selection.isEmpty(),
        onclick: () => {
          const name = prompt("Name for selection set:", `Set ${selection.listSets().length + 1}`);
          if (!name) return;
          selection.saveSet(name);
        },
      },
      { type: "sep" },
      ...buildSelectionSetSubmenu(),
    ],
  });
  items.push({ type: "sep" });

  // ── Hide / Isolate ──
  items.push({
    type: "action",
    text: picked.name ? `Hide Element (${truncate(picked.name, 22)})` : "Hide Element",
    icon: "",
    disabled: !(picked.map && canHide),
    onclick: () => hideMap(picked.map!),
  });
  items.push({
    type: "action",
    text: "Hide Selected",
    icon: "",
    disabled: selCount === 0 || !canHide,
    onclick: () => hideMap(sel),
  });
  items.push({
    type: "action",
    text: picked.name ? `Isolate Element (${truncate(picked.name, 22)})` : "Isolate Element",
    icon: "",
    disabled: !(picked.map && canHide),
    onclick: () => isolateMap(picked.map!),
  });
  items.push({
    type: "action",
    text: "Isolate Selection",
    icon: "",
    disabled: selCount === 0 || !canHide,
    onclick: () => isolateMap(sel),
  });
  items.push({
    type: "action",
    text: "Show All Elements",
    icon: "",
    disabled: !canHide,
    onclick: () => showAllElements(),
  });
  items.push({ type: "sep" });

  // ── Undo / Redo ──
  const ul = history.undoLabel();
  const rl = history.redoLabel();
  items.push({
    type: "action",
    text: ul ? `Undo ${truncate(ul, 28)}` : "Undo",
    icon: "",
    disabled: !history.canUndo(),
    onclick: () => void history.undo(),
  });
  items.push({
    type: "action",
    text: rl ? `Redo ${truncate(rl, 28)}` : "Redo",
    icon: "",
    disabled: !history.canRedo(),
    onclick: () => void history.redo(),
  });
  items.push({ type: "sep" });

  // ── Views ──
  items.push({ type: "action", text: "Set as Home View", icon: "+", onclick: () => saveHome() });
  items.push({ type: "action", text: "Go to Home View", icon: "", onclick: () => goHome() });
  items.push({ type: "action", text: "Fit to View", icon: "", onclick: () => fitAll() });
  items.push({
    type: "sub",
    text: "Standard Views",
    icon: "",
    items: [
      { type: "action", text: "Top", onclick: () => gotoDir(new THREE.Vector3(0, 1, 0)) },
      { type: "action", text: "Bottom", onclick: () => gotoDir(new THREE.Vector3(0, -1, 0)) },
      { type: "action", text: "Front", onclick: () => gotoDir(new THREE.Vector3(0, 0, 1)) },
      { type: "action", text: "Back", onclick: () => gotoDir(new THREE.Vector3(0, 0, -1)) },
      { type: "action", text: "Right", onclick: () => gotoDir(new THREE.Vector3(1, 0, 0)) },
      { type: "action", text: "Left", onclick: () => gotoDir(new THREE.Vector3(-1, 0, 0)) },
      { type: "sep" },
      { type: "action", text: "Iso SE", onclick: () => gotoDir(new THREE.Vector3(1, 0.7, 1)) },
      { type: "action", text: "Iso SW", onclick: () => gotoDir(new THREE.Vector3(-1, 0.7, 1)) },
      { type: "action", text: "Iso NE", onclick: () => gotoDir(new THREE.Vector3(1, 0.7, -1)) },
      { type: "action", text: "Iso NW", onclick: () => gotoDir(new THREE.Vector3(-1, 0.7, -1)) },
    ],
  });
  const proj = getProjection();
  items.push({
    type: "sub",
    text: "Projection",
    icon: "",
    items: [
      {
        type: "action",
        text: "Perspective",
        checked: proj === "perspective",
        onclick: () => setProjection("perspective"),
      },
      {
        type: "action",
        text: "Orthographic",
        checked: proj === "orthographic",
        onclick: () => setProjection("orthographic"),
      },
    ],
  });
  items.push({ type: "sep" });

  // ── Tools ──
  items.push({
    type: "action",
    text: "Measure",
    icon: "",
    checked: isMeasureEnabled(),
    onclick: () => toggleMeasure(),
  });
  items.push({
    type: "action",
    text: "Section Plane",
    icon: "",
    checked: isSectionOn(),
    onclick: () => toggleSection(),
  });
  items.push({
    type: "sub",
    text: "Transform Gizmo",
    icon: "",
    items: buildGizmoSubmenu(),
  });
  items.push({
    type: "action",
    text: "Object Snapping",
    icon: "",
    checked: snapping.isEnabled(),
    onclick: () => snapping.setEnabled(!snapping.isEnabled()),
  });
  items.push({ type: "sep" });

  // ── Footer ──
  items.push({
    type: "action",
    text: "Screenshot",
    icon: "",
    onclick: () => takeScreenshot(),
  });

  // ── Debug (unchanged) ──
  if (!picked.name && !picked.map) {
    items.push({ type: "sep" });
    items.push({ type: "label", text: `⚠ pick → ${truncate(picked.debug, 44)}` });
    items.push({ type: "label", text: `⚠ sel → ${truncate(picked.selDebug, 44)}` });
    items.push({
      type: "action",
      text: "Debug: dump raw data",
      icon: "",
      onclick: () => {
        console.log("[TOC debug] last right-click:", lastPickDebug);
        const caster = ctx.components.get(OBC.Raycasters).get(ctx.world);
        caster
          .castRay()
          .then((r: any) => console.log("[TOC debug] fresh castRay:", r))
          .catch(() => {});
        console.log("[TOC debug] highlighter:", ctx.highlighter);
        console.log("[TOC debug] highlighter.selection:", (ctx.highlighter as any)?.selection);
        console.log("[TOC debug] hider:", ctx.hider);
      },
    });
  }

  // ── Layout ──
  ctxMenu.innerHTML = "";
  renderMenuItems(ctxMenu, items);
  ctxMenu.style.visibility = "hidden";
  ctxMenu.style.display = "block";
  const hostRect = ctx.rightHost.getBoundingClientRect();
  let x = e.clientX - hostRect.left;
  let y = e.clientY - hostRect.top;
  if (x + ctxMenu.offsetWidth > hostRect.width - 8)
    x = Math.max(4, hostRect.width - ctxMenu.offsetWidth - 8);
  if (y + ctxMenu.offsetHeight > hostRect.height - 8)
    y = Math.max(4, hostRect.height - ctxMenu.offsetHeight - 8);
  ctxMenu.style.left = `${x}px`;
  ctxMenu.style.top = `${y}px`;
  ctxMenu.style.visibility = "visible";
}

// ════════════════════════════════════════════════════════════════════════
//  Setup
// ════════════════════════════════════════════════════════════════════════
// ─── Context-menu visibility helpers ──────────────────────────────────
async function ctxHide(): Promise<void> {
  try {
    const m: any = await import("../modules/bim-gaps/visibility-bridge");
    if (typeof m.hideSelection === "function") { m.hideSelection(); return; }
  } catch { /* fall back below */ }
  try {
    const vf: any = await import("../modules/visibility/visibility-filter");
    const ids = getAuthoredSelection();
    if (ids.length && vf.visibilityFilter?.hideElements) vf.visibilityFilter.hideElements(ids);
  } catch (e) { console.warn("[context-menu] hide failed", e); }
}

async function ctxIsolate(): Promise<void> {
  try {
    const m: any = await import("../modules/bim-gaps/visibility-bridge");
    if (typeof m.isolateSelection === "function") { m.isolateSelection(); return; }
  } catch { /* */ }
  try {
    const vf: any = await import("../modules/visibility/visibility-filter");
    const ids = getAuthoredSelection();
    if (ids.length && vf.visibilityFilter?.isolateElements) vf.visibilityFilter.isolateElements(ids);
  } catch (e) { console.warn("[context-menu] isolate failed", e); }
}

async function ctxShowAll(): Promise<void> {
  try {
    const m: any = await import("../modules/bim-gaps/visibility-bridge");
    if (typeof m.resetTemporaryVisibility === "function") { m.resetTemporaryVisibility(); return; }
  } catch { /* */ }
  try {
    const vf: any = await import("../modules/visibility/visibility-filter");
    vf.visibilityFilter?.resetTemporary?.();
  } catch (e) { console.warn("[context-menu] show all failed", e); }
}
export function setupContextMenu() {
  ctx.rightHost.appendChild(ctxMenu);

  // Priority 20 — lower than gizmo and box-select, higher than authoring.
  const unsub = inputRouter.subscribe((g) => {
    if (g.kind !== "rmb-click") return false;
void (async () => {
  try {
    const selMod: any = await import("./selection");
    const auth: any = (ctx as any).features?.authoring;

    const authIdsRaw = auth?.getSelectedIds?.() ?? [];
    const authIds: string[] = Array.from(authIdsRaw as any).map((x: any) => String(x));

    const snap = selMod.selection?.snapshot?.() ?? {};
    const fragSelected: Record<string, Set<number>> = {};
    let fragCount = 0;

    for (const [modelId, ids] of Object.entries(snap)) {
      if (ids instanceof Set && ids.size) {
        fragSelected[String(modelId)] = ids;
        fragCount += ids.size;
      }
    }

    const authoredIdRaw = auth?.pickAuthoredElementAt?.(g.event as MouseEvent) ?? null;
    const hit = authoredIdRaw ? null : await selMod.pickFragmentAtPointer?.();

    if (authoredIdRaw) {
      const id = String(authoredIdRaw);

      if (!authIds.includes(id) && fragCount === 0) {
        auth?.setSelectedAuthored?.([...authIds, id], "replace");
      }
    } else if (hit) {
      const modelKey = String(hit.modelId);
      const set = fragSelected[modelKey];
      const already = !!set && set.has(hit.localId);

      if (!already && authIds.length === 0) {
        selMod.selection.applyClick(hit.modelId, hit.localId, { ctrl: true });
        await selMod.selection.applyToHighlighter?.();
      }
    }
  } catch (err) {
    console.warn("[context-menu] right-click preserve selection failed", err);
  }

  await openCtxMenu(g.event);
})();
return true;
  }, 20);

  window.addEventListener(
    "mousedown",
    (e) => {
      if (e.button === 0 && !ctxMenu.contains(e.target as Node)) closeCtxMenu();
    },
    true,
  );
  window.addEventListener("wheel", () => closeCtxMenu(), { passive: true });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCtxMenu();
  });

  ctx.features.contextMenu = { close: closeCtxMenu, dispose: unsub };
}