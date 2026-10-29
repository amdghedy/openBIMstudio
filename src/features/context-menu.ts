/**
 * Viewport context menu (restored minimal shell + full Modify toolkit).
 */
import { ctx } from "../core/context";
import { selection, pickUnderCursor } from "./selection";
import {
  getSelectedIds as getAuthoredSelection,
  setAuthoringTool,
} from "./authoring";
import { beginEdit, beginEditFromSelection, openFragEditPanel } from "./frag-edit";
import { buildContextMenu, type MenuItem } from "./context-menu-model";
import { executeBimCommand, listBimCommands } from "./bim-experience";
import {
  copySelectionToClipboard,
  getModifyClipboardCount,
  listModifyActions,
  runModifyAction,
  isModifyToolActive,
} from "./modify-actions";

const ctxMenu = document.createElement("div");
ctxMenu.style.cssText =
  "position:absolute;z-index:100;display:none;min-width:250px;overflow:visible;" +
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
    const disabled = (it.type === "action" || it.type === "sub") && it.disabled;
    if (it.type === "action" && it.title) row.title = it.title;
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;white-space:nowrap;position:relative" +
      (disabled ? ";opacity:.35;pointer-events:none" : "");
    row.innerHTML =
      `<span style="width:18px;text-align:center">${it.icon ?? ""}</span>` +
      `<span style="flex:1${it.type === "action" && it.danger ? ";color:#f87171" : ""}">${it.text}</span>` +
      (it.type === "action" && it.kbd ? `<span style="opacity:.45;font-size:10px;margin-left:14px">${it.kbd}</span>` : "") +
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
      if (it.items.filter((x) => x.type === "label").length >= 3) {
        // Many groups (Modify): two columns, each group kept together, so it fits any window height.
        sub.style.columnCount = "2"; sub.style.columnGap = "0"; sub.style.minWidth = "470px"; sub.style.maxHeight = "none";
        let g: HTMLElement | null = null;
        for (const x of it.items) {
          if (x.type === "label" || !g) { g = document.createElement("div"); g.style.cssText = "break-inside:avoid;padding-bottom:2px"; sub.appendChild(g); }
          renderMenuItems(g, [x]);
        }
      } else renderMenuItems(sub, it.items);
      const place = () => {
        sub.style.display = "block"; sub.style.left = "calc(100% - 2px)"; sub.style.right = "auto"; sub.style.top = "-5px";
        const r = sub.getBoundingClientRect();
        if (r.right > window.innerWidth - 4) { sub.style.left = "auto"; sub.style.right = "calc(100% - 2px)"; }
        const r2 = sub.getBoundingClientRect();
        if (r2.bottom > window.innerHeight - 4) sub.style.top = `${-5 - (r2.bottom - window.innerHeight + 8)}px`;
      };
      row.onmouseenter = place;
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

/**
 * The linked (IFC/FRAG) elements the menu acts on. Order: the selection manager; else whatever the
 * highlighter shows; else the element under the cursor (right-click on an unselected object acts on it).
 */
async function resolveLinkedSelection(): Promise<Record<string, Set<number>>> {
  let snap = selection.snapshot() as Record<string, Set<number>>;
  const count = (m: Record<string, Set<number>>) => Object.values(m).reduce((a, v) => a + (v?.size ?? 0), 0);
  if (!count(snap)) {
    try { selection.adoptFromHighlighter(); } catch { /* */ }
    snap = selection.snapshot() as Record<string, Set<number>>;
  }
  if (!count(snap) && getAuthoredSelection().length === 0) {
    try {
      const hit = await pickUnderCursor();
      if (hit) {
        selection.replace({ [hit.modelId]: new Set([hit.localId]) });
        await selection.applyToHighlighter();
        snap = selection.snapshot() as Record<string, Set<number>>;
      }
    } catch { /* picking is best-effort */ }
  }
  return snap;
}

async function openCtxMenu(e: MouseEvent) {
  const authoredIds = getAuthoredSelection();
  const snap = await resolveLinkedSelection();
  const actionCount = Object.values(snap).reduce((a, v) => a + (v?.size ?? 0), 0);

  const have = new Set(listBimCommands().map((c) => c.id));
  const items: MenuItem[] = buildContextMenu({
    authoredCount: authoredIds.length,
    linkedCount: actionCount,
    clipboardCount: getModifyClipboardCount(),
    modifyDefs: listModifyActions(),
    activeModifyTool: (id) => isModifyToolActive(id as any),
    runModify: (id) => runModifyAction(id as any),
    command: (id) => executeBimCommand(id),
    hasCommand: (id) => have.has(id),
    openDialog: (k) => {
      void import("./engine-ui").then((m) => {
        const f = { move: m.openModifyMoveDialog, rotate: m.openModifyRotateDialog, array: m.openModifyArrayDialog, mirror: m.openModifyMirrorDialog }[k];
        return f();
      }).catch((err) => console.warn("[context-menu] modify dialog failed", err));
    },
    setTool: (t) => setAuthoringTool(t),
    copyToClipboard: () => {
      const n = copySelectionToClipboard();
      window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: n ? `Copied ${n} element(s)` : "Nothing to copy", kind: n ? "success" : "warn" } }));
    },
    makeNativeTwin: async () => {
      // Work on the selection captured when the menu opened (the click that follows must not change it).
      const target = snap;
      const n = Object.values(target).reduce((acc, v) => acc + (v?.size ?? 0), 0);
      const note = (message: string, kind: string) => window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
      if (!n) { note("Make Editable: select one or more linked elements first.", "warn"); return; }
      note(`Making ${n} element(s) editable…`, "info");
      try {
        const { bulkConvertLinkedToNativeTwin } = await import("./bulk-native-twin");
        const result = await bulkConvertLinkedToNativeTwin({
          selection: target,
          quietPerItem: true, openPanelOnSuccess: false,
          convertOne: async (modelId, localId) => { const twin = await beginEdit(modelId, localId); return twin ? { id: twin.id, name: twin.name } : null; },
        });
        if (result.created > 0) openFragEditPanel();
      } catch (err) {
        console.error("[context-menu] bulk Native Twin conversion failed", err);
        note(`Make Editable failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
    openProperties: () => { try { (ctx.features as any).propertyPalette?.open?.(); } catch { /* */ } },
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
  // keep the whole menu on screen (flip up / left when it would overflow)
  const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
  if (e.clientX + mw > window.innerWidth - 4) x = Math.max(0, x - mw);
  if (e.clientY + mh > window.innerHeight - 4) y = Math.max(0, y - mh);
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
