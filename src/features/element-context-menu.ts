/**
 * Element Context Menu — simplified restore with full Modify toolkit.
 * Full-featured UI lives alongside expand-modify-menu + modify-actions.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import {
  getSelectedIds,
  setSelectedAuthored,
  deleteSelectedElement,
  getElementById,
} from "./authoring";
import {
  listModifyActions,
  runModifyAction,
  isModifyActionEnabled,
} from "./modify-actions";
import { expandElementContextModifyMenu } from "./expand-modify-menu";

type Any = Record<string, any>;

export interface CtxMenuItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  action?: () => void | Promise<void>;
}

let menuEl: HTMLDivElement | null = null;
let open = false;
let installed = false;
let unsub: (() => void) | null = null;

function toast(message: string, kind: "info" | "success" | "warn" | "error" = "info") {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
}

function ensureSelected(elementId: string | null) {
  if (!elementId) return;
  try {
    const cur = getSelectedIds() as string[];
    if (!cur?.includes(elementId)) setSelectedAuthored([elementId], "replace");
  } catch { /* */ }
}

export function buildItems(elementId: string | null): CtxMenuItem[] {
  ensureSelected(elementId);
  let count = 0;
  try { count = (getSelectedIds() as string[])?.length ?? 0; } catch { count = elementId ? 1 : 0; }
  if (!count && elementId) count = 1;

  const items: CtxMenuItem[] = [];
  items.push({
    id: "hdr",
    label: count ? `${count} selected` : "No selection",
    disabled: true,
  });
  items.push({ id: "sep0", label: "", separator: true });

  // Full Modify toolkit — left-click placement tools via setAuthoringTool / onModifyClick
  for (const def of listModifyActions()) {
    if (def.separatorBefore) items.push({ id: `sep-${def.id}`, label: "", separator: true });
    items.push({
      id: `mod-${def.id}`,
      label: def.label,
      icon: def.icon,
      shortcut: def.shortcut,
      disabled: !isModifyActionEnabled(def, count),
      danger: !!def.danger,
      action: () => runModifyAction(def.id),
    });
  }

  items.push({ id: "sep-end", label: "", separator: true });
  items.push({
    id: "properties",
    label: "Properties",
    icon: "ℹ",
    disabled: count < 1,
    action: () => {
      try { (ctx.features as Any).propertyPalette?.open?.(); } catch { /* */ }
    },
  });
  return items;
}

function render(items: CtxMenuItem[]) {
  if (!menuEl) {
    menuEl = document.createElement("div");
    menuEl.id = "obs-element-ctx-menu";
    menuEl.style.cssText =
      "position:fixed;z-index:10000;display:none;min-width:240px;max-height:70vh;overflow:auto;" +
      "background:#fff;border:1px solid #e1dfdd;border-radius:8px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.12);font:12px 'Segoe UI',system-ui,sans-serif;padding:6px 0;color:#1a1a1a";
    document.body.appendChild(menuEl);
  }
  menuEl.innerHTML = "";
  for (const it of items) {
    if (it.separator) {
      const s = document.createElement("div");
      s.style.cssText = "height:1px;background:#e1dfdd;margin:4px 8px";
      menuEl.appendChild(s);
      continue;
    }
    const row = document.createElement("button");
    row.type = "button";
    row.disabled = !!it.disabled;
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;" +
      "padding:7px 12px;text-align:left;cursor:pointer;font:inherit;color:inherit" +
      (it.disabled ? ";opacity:.4;cursor:default" : "") +
      (it.danger ? ";color:#d13438" : "");
    row.innerHTML = `<span style="width:18px;text-align:center">${it.icon ?? ""}</span><span style="flex:1">${it.label}</span>` +
      (it.shortcut ? `<span style="opacity:.5;font-size:10px">${it.shortcut}</span>` : "");
    if (!it.disabled && it.action) {
      row.onclick = () => { hide(); void it.action!(); };
      row.onmouseenter = () => { row.style.background = "#f3f2f1"; };
      row.onmouseleave = () => { row.style.background = "transparent"; };
    }
    menuEl.appendChild(row);
  }
}

export function show(clientX: number, clientY: number, elementId: string | null) {
  try { (ctx.features as Any).contextMenu?.close?.(); } catch { /* */ }
  render(buildItems(elementId));
  if (!menuEl) return;
  menuEl.style.display = "block";
  const rect = menuEl.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + rect.width > window.innerWidth - 8) left = Math.max(8, clientX - rect.width);
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, clientY - rect.height);
  menuEl.style.left = `${Math.round(left)}px`;
  menuEl.style.top = `${Math.round(top)}px`;
  open = true;
}

export function hide() {
  if (menuEl) menuEl.style.display = "none";
  open = false;
}

export function setupElementContextMenu(): void {
  if (installed) return;
  installed = true;

  const host =
    (ctx as Any).rightHost ??
    document.getElementById("viewport") ??
    document.querySelector(".obs-viewport") ??
    document.body;

  const handler = (e: Event) => {
    const me = e as MouseEvent;
    const t = me.target as HTMLElement | null;
    if (t?.closest?.("#obs-element-ctx-menu, .obs-ribbon, .obs-panel, .obs-modal, [data-obs-ui]")) return;
    // Prefer main context-menu when installed
    if ((ctx.features as Any).contextMenu) {
      me.preventDefault();
      return;
    }
    me.preventDefault();
    me.stopPropagation();
    let elementId: string | null = null;
    try {
      const ids = getSelectedIds() as string[];
      elementId = ids?.[0] ?? null;
    } catch { /* */ }
    show(me.clientX, me.clientY, elementId);
  };

  host?.addEventListener("contextmenu", handler, { capture: true });
  const onDoc = (e: Event) => {
    if (!open || !menuEl) return;
    if (menuEl.contains(e.target as Node)) return;
    hide();
  };
  document.addEventListener("pointerdown", onDoc, true);

  unsub = () => {
    host?.removeEventListener("contextmenu", handler, true);
    document.removeEventListener("pointerdown", onDoc, true);
    hide();
    menuEl?.remove();
    menuEl = null;
    installed = false;
  };

  (window as Any).__obsElementCtxMenu = { show, hide, buildItems };
  try { expandElementContextModifyMenu(); } catch { /* */ }
  console.info("[element-context-menu] ready — full Modify toolkit");
}

export function disposeElementContextMenu(): void {
  unsub?.();
  unsub = null;
}
