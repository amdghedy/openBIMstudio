/**
 * Floating viewport toolbar (Navisworks/Blender class).
 *
 * Placed top-center of the 3D view. Contains, left to right:
 *   - Selection filter dropdown
 *   - Select all / Clear / Invert / Select similar
 *   - Snap toggle + grid size
 *   - Gizmo mode (Move | Rotate | Scale | None)
 *   - Undo / Redo
 *   - Selection count pill
 */
import { ctx } from "../core/context";
import { history } from "../features/history";
import { selection } from "../features/selection";
import { snapping } from "../features/snapping";
import { gizmo, type GizmoMode } from "../features/gizmo";

const T_BAR = "display:flex;align-items:center;gap:2px;padding:4px";
const T_BTN = "display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:6px;background:transparent;color:var(--text-secondary);border:1px solid transparent;cursor:pointer;font-size:15px;transition:background .12s,border-color .12s,color .12s";
const T_BTN_ON = T_BTN + ";background:var(--accent-dim);color:var(--accent);border-color:var(--accent)";
const T_SEP = "width:1px;height:22px;background:var(--border-default);margin:0 4px";
const T_SELECT = "height:28px;padding:0 8px;background:var(--bg-inset);border:1px solid var(--border-default);border-radius:6px;color:var(--text-primary);font:500 11px system-ui;cursor:pointer;max-width:190px";

let snapOn = false;

export function setupViewportToolbar() {
  // Removed from platform UI (selection filter / top floating bar).
  // Snaps, gizmo, undo remain available via ribbon / shortcuts / context menu.
  console.log("[viewport-toolbar] disabled");
  return;
  const host = ctx.rightHost; // VIEWPORT_TOOLBAR_DISABLED


  const bar = document.createElement("div");
  bar.style.cssText =
    "position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:55;display:flex;align-items:center;background:var(--bg-floating);border:1px solid var(--border-default);border-radius:10px;box-shadow:var(--shadow-lg);user-select:none;backdrop-filter:blur(8px)";
  bar.addEventListener("mousedown", (e) => e.stopPropagation());

  // ── Selection filter ──
  const filterSel = document.createElement("select");
  filterSel.style.cssText = T_SELECT;
  filterSel.title = "Selection filter (by category)";
  filterSel.innerHTML = `<option value="">All categories</option>`;
  filterSel.onchange = () => {
    const v = filterSel.value;
    selection.setFilter(v ? [v] : null);
  };

  async function refreshFilterOptions() {
    const cats = new Set<string>();
    for (const [, model] of ctx.fragments.list) {
      try {
        const c = await (model as any).getItemsOfCategories([/.+/]);
        for (const k of Object.keys(c ?? {})) cats.add(k);
      } catch {
        /* */
      }
    }
    const cur = filterSel.value;
    filterSel.innerHTML =
      `<option value="">All categories</option>` +
      [...cats]
        .sort()
        .map((c) => {
          const nice = c.replace(/^IFC/i, "");
          return `<option value="${c}">${nice}</option>`;
        })
        .join("");
    filterSel.value = cur;
  }
  ctx.fragments.list.onItemSet.add(() => {
    void refreshFilterOptions();
  });

  // ── Selection ops ──
  const btnSelectAll = mkIconBtn("⬛", "Select all", () => void selection.selectAll());
  const btnInvert = mkIconBtn("⇄", "Invert selection", () => void selection.invert());
  const btnClear = mkIconBtn("✕", "Clear selection", async () => {
    selection.clear();
    await selection.applyToHighlighter();
  });

  // ── Snap ──
  const btnSnap = mkIconBtn("⌖", "Toggle object snap", () => {
    snapOn = !snapOn;
    snapping.setEnabled(snapOn);
    updateSnapVisual();
  });
  function updateSnapVisual() {
    btnSnap.style.cssText = snapOn ? T_BTN_ON : T_BTN;
  }

  const gridSel = document.createElement("select");
  gridSel.style.cssText = T_SELECT + ";max-width:78px;font-size:10.5px";
  gridSel.title = "Snap grid size";
  gridSel.innerHTML = `
    <option value="1">1 m</option>
    <option value="0.5">500 mm</option>
    <option value="0.25">250 mm</option>
    <option value="0.1" selected>100 mm</option>
    <option value="0.05">50 mm</option>
    <option value="0.01">10 mm</option>`;
  gridSel.onchange = () => snapping.setGridSize(Number(gridSel.value) || 0.1);

  // ── Gizmo mode ──
  const btnMove = mkIconBtn("↔", "Move (G)", () => setGizmo("move"));
  const btnRotate = mkIconBtn("⟳", "Rotate (R)", () => setGizmo("rotate"));
  const btnScale = mkIconBtn("⤢", "Scale (S)", () => setGizmo("scale"));
  const btnNone = mkIconBtn("▣", "Selection mode (Q)", () => setGizmo("none"));

  function setGizmo(mode: GizmoMode) {
    gizmo.setMode(mode);
    btnMove.style.cssText = mode === "move" ? T_BTN_ON : T_BTN;
    btnRotate.style.cssText = mode === "rotate" ? T_BTN_ON : T_BTN;
    btnScale.style.cssText = mode === "scale" ? T_BTN_ON : T_BTN;
    btnNone.style.cssText = mode === "none" ? T_BTN_ON : T_BTN;
  }
  setGizmo("none");

  // ── Undo / Redo ──
  const btnUndo = mkIconBtn("↶", "Undo (Ctrl+Z)", () => void history.undo());
  const btnRedo = mkIconBtn("↷", "Redo (Ctrl+Shift+Z)", () => void history.redo());
  history.onChange(() => {
    btnUndo.style.opacity = history.canUndo() ? "1" : "0.35";
    btnRedo.style.opacity = history.canRedo() ? "1" : "0.35";
    const ul = history.undoLabel();
    const rl = history.redoLabel();
    btnUndo.title = ul ? `Undo ${ul} (Ctrl+Z)` : "Undo (Ctrl+Z)";
    btnRedo.title = rl ? `Redo ${rl} (Ctrl+Shift+Z)` : "Redo (Ctrl+Shift+Z)";
  });

  // ── Selection count ──
  const count = document.createElement("div");
  count.style.cssText =
    "display:inline-flex;align-items:center;padding:0 10px;height:30px;background:var(--bg-inset);border:1px solid var(--border-default);border-radius:6px;font:600 11px var(--font-mono);color:var(--text-secondary);min-width:44px;justify-content:center";
  count.title = "Selection size";
  selection.onChange(() => {
    const n = selection.size();
    count.textContent = n === 0 ? "0" : n.toLocaleString();
    count.style.color = n ? "var(--accent)" : "var(--text-tertiary)";
    count.style.borderColor = n ? "var(--accent)" : "var(--border-default)";
  });

  // ── Assemble ──
  bar.append(
    filterSel,
    sep(),
    btnSelectAll,
    btnInvert,
    btnClear,
    sep(),
    btnSnap,
    gridSel,
    sep(),
    btnMove,
    btnRotate,
    btnScale,
    btnNone,
    sep(),
    btnUndo,
    btnRedo,
    sep(),
    count,
  );

  host.appendChild(bar);
  void refreshFilterOptions();
  history.onChange(() => {}); // primes initial button state

  // Expose for external shortcuts
  (window as any).__obs_setGizmo = setGizmo;
}

function mkIconBtn(icon: string, title: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.style.cssText = T_BTN;
  b.title = title;
  b.textContent = icon;
  b.onclick = (e) => {
    e.stopPropagation();
    onclick();
  };
  b.onmouseenter = () => {
    if (!b.style.cssText.includes("accent")) b.style.background = "var(--bg-hover)";
  };
  b.onmouseleave = () => {
    if (!b.style.cssText.includes("accent")) b.style.background = "transparent";
  };
  return b;
}
function sep(): HTMLDivElement {
  const d = document.createElement("div");
  d.style.cssText = "width:1px;height:22px;background:var(--border-default);margin:0 4px";
  return d;
}