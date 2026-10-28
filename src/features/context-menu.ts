/**
 * Viewport context menu (restored minimal shell + full Modify toolkit).
 */
import { ctx } from "../core/context";
import { selection } from "./selection";
import {
  getActiveTool as getAuthoringTool,
  getSelectedIds as getAuthoredSelection,
  setAuthoringTool,
  deleteSelectedElement,
} from "./authoring";
import { beginEdit, beginEditFromSelection, openFragEditPanel } from "./frag-edit";
import {
  listModifyActions,
  runModifyAction,
  isModifyActionEnabled,
  isModifyToolActive,
} from "./modify-actions";

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

const ctxMenu = document.createElement("div");
ctxMenu.style.cssText =
  "position:absolute;z-index:100;display:none;min-width:260px;max-height:calc(100vh - 24px);overflow-y:auto;" +
  "background:var(--bg-floating,#1e1f26);border:1px solid var(--border-default,#3a3a4a);border-radius:8px;" +
  "box-shadow:0 10px 30px rgba(0,0,0,.55);font:12px system-ui,sans-serif;color:var(--text-primary,#e2e8f0);padding:4px 0";
ctxMenu.addEventListener("mousedown", (e) => e.stopPropagation());

function closeCtxMenu() {
  ctxMenu.style.display = "none";
}

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
      d.style.cssText = "padding:4px 12px 2px;font-size:10px;letter-spacing:.5px;opacity:.55";
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
      `<span style="width:18px;text-align:center">${it.icon ?? ""}</span>` +
      `<span style="flex:1">${it.text}</span>` +
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
        "display:none;position:absolute;top:-5px;left:calc(100% - 2px);min-width:220px;max-height:calc(100vh - 36px);" +
        "overflow-y:auto;background:var(--bg-floating,#1e1f26);border:1px solid var(--border-default,#3a3a4a);" +
        "border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);padding:4px 0;z-index:101";
      renderMenuItems(sub, it.items);
      row.onmouseenter = () => { sub.style.display = "block"; };
      row.onmouseleave = () => { sub.style.display = "none"; };
      sub.onmouseenter = () => { sub.style.display = "block"; };
      sub.onmouseleave = () => { sub.style.display = "none"; };
      row.appendChild(sub);
    }
    row.addEventListener("mouseenter", () => { row.style.background = "var(--bg-hover,#2c2d38)"; });
    row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
    container.appendChild(row);
  }
}

async function openCtxMenu(e: MouseEvent) {
  const authoredIds = getAuthoredSelection();
  const hasAuthored = authoredIds.length > 0;
  const snap = selection.snapshot();
  const actionCount = Object.values(snap).reduce((a, v) => a + (v?.size ?? 0), 0);

  const items: MenuItem[] = [];
  if (hasAuthored) {
    items.push({ type: "label", text: `Authored: ${authoredIds.length} element(s)` });
  } else if (actionCount > 0) {
    items.push({ type: "label", text: `Selection: ${actionCount} item(s)` });
  }

  // Full Modify submenu — tools complete on subsequent left-clicks (onModifyClick)
  if (hasAuthored) {
    const modItems: MenuItem[] = [];
    for (const def of listModifyActions()) {
      if (def.separatorBefore) modItems.push({ type: "sep" });
      modItems.push({
        type: "action",
        text: def.label,
        icon: def.icon ?? "",
        disabled: !isModifyActionEnabled(def, authoredIds.length),
        checked: isModifyToolActive(def.id),
        onclick: () => runModifyAction(def.id),
      });
    }
    items.push({ type: "sub", text: "Modify", icon: "", items: modItems });
    items.push({ type: "sep" });
  }

  items.push({
    type: "action",
    text: "Make Editable Native Twin",
    disabled: actionCount === 0,
    onclick: async () => {
      try {
        const { bulkConvertLinkedToNativeTwin } = await import("./bulk-native-twin");
        const result = await bulkConvertLinkedToNativeTwin({
          quietPerItem: true,
          openPanelOnSuccess: true,
          convertOne: async (modelId, localId) => {
            const twin = await beginEdit(modelId, localId);
            return twin ? { id: twin.id, name: twin.name } : null;
          },
        });
        if (result.created > 0) openFragEditPanel();
      } catch {
        const n = await beginEditFromSelection();
        if (n) openFragEditPanel();
      }
    },
  });
  items.push({
    type: "action",
    text: "Properties",
    disabled: actionCount === 0 && !hasAuthored,
    onclick: async () => {
      try {
        (ctx.features as any).propertyPalette?.open?.();
      } catch { /* */ }
    },
  });
  items.push({ type: "sep" });
  items.push({
    type: "action",
    text: "Clear Selection",
    disabled: selection.isEmpty() && !hasAuthored,
    onclick: async () => {
      selection.clear();
      await selection.applyToHighlighter();
    },
  });

  if (!ctxMenu.isConnected) {
    (ctx.rightHost ?? document.body).appendChild(ctxMenu);
  }
  ctxMenu.innerHTML = "";
  renderMenuItems(ctxMenu, items);
  ctxMenu.style.display = "block";
  const host = ctx.rightHost ?? document.body;
  const hr = host.getBoundingClientRect();
  let x = e.clientX - hr.left;
  let y = e.clientY - hr.top;
  ctxMenu.style.left = `${Math.max(0, x)}px`;
  ctxMenu.style.top = `${Math.max(0, y)}px`;
}

export function setupContextMenu() {
  const host = ctx.rightHost ?? document.body;
  const onCtx = (e: Event) => {
    const me = e as MouseEvent;
    const t = me.target as HTMLElement | null;
    if (t?.closest?.(".obs-ribbon, .obs-panel, .obs-modal, [data-obs-ui]")) return;
    me.preventDefault();
    me.stopPropagation();
    void openCtxMenu(me);
  };
  host.addEventListener("contextmenu", onCtx, true);
  window.addEventListener("mousedown", (e) => {
    if (e.button === 0 && !ctxMenu.contains(e.target as Node)) closeCtxMenu();
  }, true);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCtxMenu();
  });
  ctx.features.contextMenu = { close: closeCtxMenu, dispose: () => host.removeEventListener("contextmenu", onCtx, true) };
  console.info("[context-menu] ready — full Modify toolkit");
}
