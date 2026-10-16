/**
 * Model Tree floating panel.
 *
 * Layout (left, floating):
 *   ┌──────────────────────────────┐
 *   │ 🌲 Model Tree   ⤢ ⤡  ⟲  ✕   │
 *   ├──────────────────────────────┤
 *   │ 🔍 Search…                    │
 *   ├──────────────────────────────┤
 *   │ ▼ Schependomlaan.ifc   2341  │
 *   │   ▼ Site                     │
 *   │     ▼ Building               │
 *   │       ▼ Level 0        892   │
 *   │         ▸ Walls (156)        │
 *   │         ▸ Doors (43)         │
 *   │ …                             │
 *   └──────────────────────────────┘
 *
 * Sync:
 *   - Clicking a row selects elements (Ctrl adds, Shift toggles, Alt removes)
 *   - selection.onChange refreshes row highlights
 *   - Eye icon toggles visibility via ctx.hider
 *   - Right-click shows a per-node context menu (focus / isolate / hide / select)
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { selection } from "./selection";
import {
  getTrees,
  getTree,
  buildAllTrees,
  searchTree,
  collectLocalIds,
  prettyCategoryName,
  onModelTreeChanged,
  type TreeItem,
  type ModelTree,
} from "../modules/model-tree/tree";
import { fitToMap } from "./camera-tools";

// ═══════════════════════════════════════════════════════════════════════════
// Panel shell
// ═══════════════════════════════════════════════════════════════════════════
const panel = document.createElement("div");
panel.style.cssText =
  "position:absolute;left:400px;top:14px;bottom:14px;width:340px;z-index:35;display:none;flex-direction:column;" +
  "background:var(--bg-floating,#1c1e28);border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
  "box-shadow:var(--shadow-lg,0 12px 32px rgba(0,0,0,.45));font:12px system-ui,sans-serif;color:var(--text-primary,#e8eaf0);overflow:hidden";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border-subtle,#1e2029);background:var(--bg-elevated,#181a23)";

const searchRow = document.createElement("div");
searchRow.style.cssText =
  "padding:6px 8px;border-bottom:1px solid var(--border-subtle,#1e2029)";

const searchInput = document.createElement("input");
searchInput.type = "text";
searchInput.placeholder = "Search elements…";
searchInput.style.cssText =
  "width:100%;box-sizing:border-box;padding:6px 9px;background:var(--bg-inset,#0e1017);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:6px;color:var(--text-primary,#e8eaf0);font:12px system-ui;outline:none";
searchRow.appendChild(searchInput);

const body = document.createElement("div");
body.style.cssText = "flex:1;overflow:auto;padding:4px 0;font-size:12px";

panel.append(header, searchRow, body);

const expandedSet = new Set<string>();
const visibilityMemo = new Map<number, boolean>(); // not used yet — placeholder
let searchQuery = "";
let searchHits: { item: TreeItem; path: string[] }[] = [];

// ═══════════════════════════════════════════════════════════════════════════
// Icons
// ═══════════════════════════════════════════════════════════════════════════
function iconForCategory(cat: string): string {
  const c = cat.toUpperCase();
  if (c.includes("WALL")) return "🧱";
  if (c.includes("DOOR")) return "🚪";
  if (c.includes("WINDOW")) return "🪟";
  if (c.includes("SLAB") || c.includes("COVERING")) return "▭";
  if (c.includes("BEAM")) return "▬";
  if (c.includes("COLUMN")) return "▮";
  if (c.includes("FOOTING") || c.includes("PILE")) return "▤";
  if (c.includes("RAILING")) return "〰";
  if (c.includes("STAIR")) return "🪜";
  if (c.includes("ROOF")) return "⌂";
  if (c.includes("SPACE")) return "◌";
  if (c.includes("PIPE")) return "○";
  if (c.includes("DUCT")) return "⬚";
  if (c.includes("CABLE") || c.includes("CONDUIT")) return "⚡";
  if (c.includes("FURNITURE")) return "🪑";
  if (c.includes("SITE")) return "🌍";
  if (c.includes("BUILDING")) return "🏢";
  if (c.includes("LEVEL") || c.includes("STOREY")) return "═";
  return "◾";
}

// ═══════════════════════════════════════════════════════════════════════════
// Header render
// ═══════════════════════════════════════════════════════════════════════════
const BTN = "display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;" +
  "border-radius:5px;background:transparent;color:var(--text-secondary,#a0a6b5);border:1px solid transparent;" +
  "cursor:pointer;font-size:14px";

function miniBtn(icon: string, title: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.style.cssText = BTN;
  b.title = title;
  b.textContent = icon;
  b.onclick = (e) => {
    e.stopPropagation();
    onclick();
  };
  b.onmouseenter = () => (b.style.background = "var(--bg-hover,#232633)");
  b.onmouseleave = () => (b.style.background = "transparent");
  return b;
}

function renderHeader() {
  header.innerHTML = "";
  const title = document.createElement("div");
  title.textContent = "🌲 Model Tree";
  title.style.cssText = "font-weight:700;flex:1";
  header.appendChild(title);

  const expandBtn = miniBtn("⊞", "Expand all", () => {
    for (const t of getTrees()) expandAll(t.root);
    renderBody();
  });
  const collapseBtn = miniBtn("⊟", "Collapse all", () => {
    expandedSet.clear();
    renderBody();
  });
  const refreshBtn = miniBtn("⟲", "Rebuild tree", () => {
    void buildAllTrees().then(() => renderBody());
  });
  const closeBtn = miniBtn("✕", "Close", () => toggleModelTreePanel());

  header.append(expandBtn, collapseBtn, refreshBtn, closeBtn);
}

function expandAll(node: TreeItem) {
  if (node.children.length) {
    expandedSet.add(node.id);
    for (const c of node.children) expandAll(c);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Row rendering
// ═══════════════════════════════════════════════════════════════════════════
function renderRow(
  item: TreeItem,
  depth: number,
  container: HTMLElement,
): void {
  const row = document.createElement("div");
  row.dataset.nodeId = item.id;
  row.style.cssText =
    `display:flex;align-items:center;gap:4px;padding:3px 6px 3px ${6 + depth * 14}px;` +
    "cursor:pointer;user-select:none;white-space:nowrap;min-height:22px;font-size:12px";

  // Expand toggle
  const toggle = document.createElement("span");
  toggle.style.cssText =
    "width:14px;text-align:center;font-size:10px;color:var(--text-tertiary,#6b7280);flex:none";
  if (item.children.length) {
    toggle.textContent = expandedSet.has(item.id) ? "▼" : "▶";
    toggle.onclick = (e) => {
      e.stopPropagation();
      if (expandedSet.has(item.id)) expandedSet.delete(item.id);
      else expandedSet.add(item.id);
      renderBody();
    };
  } else {
    toggle.textContent = "·";
    toggle.style.opacity = "0.3";
  }

  // Visibility eye (only meaningful for element / category / spatial with geometry)
  const eye = document.createElement("span");
  eye.style.cssText =
    "width:16px;text-align:center;font-size:11px;flex:none;color:var(--text-tertiary,#6b7280);cursor:pointer";
  eye.textContent = "◉";
  eye.title = "Hide / show";
  eye.onclick = (e) => {
    e.stopPropagation();
    void toggleVisibility(item);
  };

  // Icon
  const icon = document.createElement("span");
  icon.style.cssText = "width:16px;text-align:center;font-size:12px;flex:none";
  icon.textContent =
    item.kind === "model"
      ? "📄"
      : item.kind === "category"
        ? "📁"
        : iconForCategory(item.category);

  // Name + optional category suffix
  const label = document.createElement("span");
  label.style.cssText =
    "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  if (item.kind === "element") {
    label.textContent = item.name;
    const cat = document.createElement("span");
    cat.style.cssText =
      "opacity:.5;font-size:10px;margin-left:6px;font-family:var(--font-mono,monospace)";
    cat.textContent = prettyCategoryName(item.category);
    label.appendChild(cat);
  } else {
    label.textContent = item.name;
  }

  // Element count badge
  const count = document.createElement("span");
  count.style.cssText =
    "flex:none;font:500 10px var(--font-mono,monospace);color:var(--text-tertiary,#6b7280);padding:0 6px";
  if (item.elementCount > 0 && item.kind !== "element") {
    count.textContent = String(item.elementCount);
  }

  // Selection marker
  const marker = document.createElement("span");
  marker.style.cssText = "width:6px;flex:none;border-radius:3px;background:transparent;height:6px";
  if (isSelected(item)) {
    marker.style.background = "var(--accent,#38bdf8)";
    marker.style.boxShadow = "0 0 6px var(--accent,#38bdf8)";
  }

  row.append(toggle, eye, icon, label, count, marker);

  row.onclick = (e) => {
    handleRowClick(item, e);
  };
  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openNodeContextMenu(item, e);
  };
  row.onmouseenter = () => (row.style.background = "var(--bg-hover,#232633)");
  row.onmouseleave = () => (row.style.background = "transparent");

  container.appendChild(row);

  // Children if expanded
  if (expandedSet.has(item.id) && item.children.length) {
    for (const c of item.children) renderRow(c, depth + 1, container);
  }
}

function isSelected(item: TreeItem): boolean {
  if (item.kind === "element") {
    return selection.has(item.modelId, item.localId);
  }
  // For containers, check any descendant
  for (const [, s] of Object.entries(selection.snapshot())) {
    // selection.snapshot() returns new objects each call, so just look at byLocalId
    const tree = getTree(item.modelId);
    if (!tree) continue;
    for (const id of s) {
      const it = tree.byLocalId.get(id);
      if (it && isDescendant(it, item)) return true;
    }
  }
  return false;
}

function isDescendant(needle: TreeItem, hay: TreeItem): boolean {
  if (needle.id === hay.id) return true;
  let p: TreeItem | undefined = undefined;
  // We didn't store parent pointers; walk by searching the hay subtree
  const walk = (it: TreeItem): boolean => {
    if (it.id === needle.id) return true;
    for (const c of it.children) if (walk(c)) return true;
    return false;
  };
  return walk(hay);
}

// ═══════════════════════════════════════════════════════════════════════════
// Body render
// ═══════════════════════════════════════════════════════════════════════════
function renderBody() {
  body.innerHTML = "";

  const trees = getTrees();
  if (!trees.length) {
    body.innerHTML =
      '<div style="opacity:.55;text-align:center;padding:24px;border:1px dashed var(--border-default,#2a2e3a);margin:10px;border-radius:8px">' +
      "No models loaded.</div>";
    return;
  }

  // Search mode — flat list of hits
  if (searchQuery.trim()) {
    searchHits = [];
    for (const t of trees) {
      const hits = searchTree(t, searchQuery, 200);
      for (const h of hits) searchHits.push(h);
    }
    if (!searchHits.length) {
      body.innerHTML =
        '<div style="opacity:.55;text-align:center;padding:20px">No matching elements.</div>';
      return;
    }
    const hint = document.createElement("div");
    hint.style.cssText = "padding:4px 12px;font-size:10px;opacity:.6;text-transform:uppercase;letter-spacing:.5px";
    hint.textContent = `${searchHits.length} match${searchHits.length === 1 ? "" : "es"}`;
    body.appendChild(hint);

    for (const hit of searchHits) {
      const row = document.createElement("div");
      row.style.cssText =
        "padding:5px 12px;cursor:pointer;border-bottom:1px solid var(--border-subtle,#1e2029)";
      row.onclick = (e) => handleRowClick(hit.item, e);
      row.onmouseenter = () => (row.style.background = "var(--bg-hover,#232633)");
      row.onmouseleave = () => (row.style.background = "transparent");
      const pathStr = hit.path.slice(-3).join(" › ");
      row.innerHTML =
        `<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">` +
        `<span style="opacity:.5;font-family:var(--font-mono,monospace);font-size:10px">${iconForCategory(hit.item.category)}</span> ` +
        `${escapeHtml(hit.item.name)}</div>` +
        `<div style="font-size:10px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(pathStr)}</div>`;
      body.appendChild(row);
    }
    return;
  }

  // Tree mode
  for (const t of trees) {
    // Auto-expand top-level for readability
    if (expandedSet.size === 0) {
      expandedSet.add(t.root.id);
    }
    renderRow(t.root, 0, body);
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c],
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Interactions
// ═══════════════════════════════════════════════════════════════════════════
function handleRowClick(item: TreeItem, e: MouseEvent) {
  if (item.kind === "model" || item.kind === "spatial") {
    // Toggle expand on container click
    if (item.children.length) {
      if (expandedSet.has(item.id)) expandedSet.delete(item.id);
      else expandedSet.add(item.id);
      renderBody();
    }
    return;
  }

  const ids = collectLocalIds(item);
  if (!ids.length) return;

  const ctrl = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  const alt = e.altKey;

  if (alt) {
    selection.removeMany(item.modelId, ids);
  } else if (shift) {
    for (const id of ids) selection.toggle(item.modelId, id);
  } else if (ctrl) {
    selection.addMany(item.modelId, ids);
  } else {
    selection.replace({ [item.modelId]: new Set(ids) });
  }
  void selection.applyToHighlighter();
  renderBody();
}

async function toggleVisibility(item: TreeItem) {
  const ids = collectLocalIds(item);
  if (!ids.length) return;
  try {
    const hider: any = ctx.hider;
    // Best-effort: hide this subtree
    const map = { [item.modelId]: new Set(ids) };
    if (typeof hider.hide === "function") await hider.hide(map);
    else if (typeof hider.set === "function") await hider.set(false, map);
  } catch (e) {
    console.warn("[model-tree] toggle visibility failed", e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Node context menu
// ═══════════════════════════════════════════════════════════════════════════
const ctxMenu = document.createElement("div");
ctxMenu.style.cssText =
  "position:fixed;z-index:200;min-width:180px;background:var(--bg-floating,#1c1e28);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:8px;box-shadow:var(--shadow-lg,0 12px 32px rgba(0,0,0,.45));" +
  "padding:4px 0;font:12px system-ui;color:var(--text-primary,#e8eaf0);display:none";
document.body.appendChild(ctxMenu);

function ctxItem(label: string, icon: string, onclick: () => void, disabled = false) {
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;white-space:nowrap" +
    (disabled ? ";opacity:.4;pointer-events:none" : "");
  row.innerHTML = `<span style="width:14px;text-align:center">${icon}</span><span>${escapeHtml(label)}</span>`;
  row.onmouseenter = () => (row.style.background = "var(--bg-hover,#232633)");
  row.onmouseleave = () => (row.style.background = "transparent");
  row.onclick = () => {
    ctxMenu.style.display = "none";
    onclick();
  };
  return row;
}

function openNodeContextMenu(item: TreeItem, e: MouseEvent) {
  ctxMenu.innerHTML = "";
  const ids = collectLocalIds(item);
  const map = { [item.modelId]: new Set(ids) };
  const hasIds = ids.length > 0;

  ctxMenu.appendChild(
    ctxItem("Zoom to node", "🎯", () => {
      void fitToMap(map as any);
    }, !hasIds),
  );
  ctxMenu.appendChild(
    ctxItem("Select subtree", "⬛", () => {
      selection.replace(map as any);
      void selection.applyToHighlighter();
      renderBody();
    }, !hasIds),
  );
  const sep = document.createElement("div");
  sep.style.cssText = "height:1px;background:var(--border-subtle,#1e2029);margin:4px 8px";
  ctxMenu.appendChild(sep);

  ctxMenu.appendChild(
    ctxItem("Hide", "🙈", async () => {
      try {
        const hider: any = ctx.hider;
        if (typeof hider.hide === "function") await hider.hide(map);
        else if (typeof hider.set === "function") await hider.set(false, map);
      } catch { /* */ }
    }, !hasIds),
  );
  ctxMenu.appendChild(
    ctxItem("Isolate", "🚧", async () => {
      try {
        const hider: any = ctx.hider;
        if (typeof hider.isolate === "function") await hider.isolate(map);
        else if (typeof hider.set === "function") {
          await hider.set(false);
          await hider.set(true, map);
        }
      } catch { /* */ }
    }, !hasIds),
  );
  ctxMenu.appendChild(
    ctxItem("Show all", "👁", async () => {
      try {
        const hider: any = ctx.hider;
        if (typeof hider.show === "function") await hider.show();
        else if (typeof hider.set === "function") await hider.set(true);
      } catch { /* */ }
    }),
  );

  ctxMenu.style.left = `${e.clientX}px`;
  ctxMenu.style.top = `${e.clientY}px`;
  ctxMenu.style.display = "block";
}

// Close context menu on any click outside
window.addEventListener("mousedown", (e) => {
  if (!ctxMenu.contains(e.target as Node)) ctxMenu.style.display = "none";
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") ctxMenu.style.display = "none";
});

// ═══════════════════════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════════════════════
searchInput.oninput = () => {
  searchQuery = searchInput.value;
  renderBody();
};
searchInput.onkeydown = (e) => {
  if (e.key === "Escape") {
    searchInput.value = "";
    searchQuery = "";
    searchInput.blur();
    renderBody();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Sync with selection
// ═══════════════════════════════════════════════════════════════════════════
selection.onChange(() => {
  if (panel.style.display !== "flex") return;
  // Refresh row markers (cheap: rerender body)
  renderBody();
});

// ═══════════════════════════════════════════════════════════════════════════
// Public
// ═══════════════════════════════════════════════════════════════════════════
export function toggleModelTreePanel() {
  const visible = panel.style.display === "flex";
  panel.style.display = visible ? "none" : "flex";
  if (!visible) {
    renderHeader();
    renderBody();
    if (!getTrees().length) void buildAllTrees().then(renderBody);
  }
}
export function isModelTreePanelVisible() {
  return panel.style.display === "flex";
}

export function setupModelTreePanel() {
  ctx.rightHost.appendChild(panel);
  onModelTreeChanged(() => {
    if (panel.style.display === "flex") renderBody();
  });
  ctx.features.modelTreePanel = {
    toggle: toggleModelTreePanel,
    isVisible: isModelTreePanelVisible,
  };
}