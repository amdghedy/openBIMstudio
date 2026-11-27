/**
 * Project Browser — Industry-standard project organization panel.
 *
 * Hierarchy (Revit order, audit G11):
 *   Views (all)          → Floor Plans / Ceiling Plans / Elevations /
 *                           Sections / 3D Views / … / Saved Views
 *   Sheets (all)         → production sheets
 *   Schedules/Quantities → schedule templates (+ schedule-kind views)
 *   Families             → family types + Materials
 *   Groups               → selection sets
 *   Models & Links       → federated IFC / FRAG / aux
 *   4D Phases            → construction phases
 *
 * The tree itself lives in ./project-browser-tree (pure, DOM-free, node
 * tested); this file gathers the data and owns the panel DOM, including
 * the as-you-type filter textbox.
 *
 * Professional dark UI, expandable tree, double-click to open,
 * right-click actions. Competes with BIM Project Browser presentation.
 */
import { ctx } from "../core/context";
import {
  listSheets,
  createSheet,
  updateSheet,
  deleteSheet,
  duplicateSheet,
  createDefaultSheetSet,
} from "../modules/sheets/sheets";
import { listMaterials, ensureDefaultMaterials, addMaterial } from "../modules/materials/materials";
import {
  listPhases,
  addPhase,
  updatePhase,
  removePhase,
  assignSelectionToPhase,
  createDefaultPhases,
} from "../modules/timeline/timeline";
import {
  listSavedViews,
  restoreView,
  saveCurrentView,
  renameView as renameSavedView,
  duplicateView as duplicateSavedView,
  deleteView as deleteSavedView,
} from "./saved-views";
import {
  bootViewsStore,
  listViews,
  createView,
  updateView,
  deleteView as deleteStoredView,
  duplicateView as duplicateStoredView,
} from "../modules/views/store";
import type { ViewKind } from "../modules/views/types";
import {
  buildProjectBrowserTree,
  filterProjectBrowserTree,
  type ProjectBrowserNode,
  type ProjectBrowserTreeInput,
} from "./project-browser-tree";
import {
  menuItemsForNode,
  newViewLabel,
  type ProjectBrowserMenuActionId,
} from "./project-browser-menu";
import { promptLine, confirmDialog } from "./form-modal";
import { selection } from "./selection";
import { togglePlanView } from "./plan-view-panel";
import { toggleSchedules } from "./schedules-panel";
import { toggleSheetsPanel } from "./sheets-panel";
import { toggleTimelinePanel } from "./timeline-panel";
import { togglePropertyPalette, isPropertyPaletteVisible } from "./property-palette";
import { toggleModelTreePanel } from "./model-tree-panel";
import { openViewInPanel } from "./views-panel";
import { fitAll, goHome } from "./camera-tools";
import { registerEscapeScope } from "../core/escape-all";

type BrowserNode = ProjectBrowserNode;

let panel: HTMLElement | null = null;
let visible = false;
let expanded = new Set<string>(["views", "views-plan", "views-3d", "sheets", "schedules"]);
/** Guard: the G11 escape scope is registered once, at setup. */
let escapeScopeRegistered = false;
let selectedNodeId: string | null = null;
/** As-you-type filter text; empty means no filtering. */
let filterQuery = "";

function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}

function buildTree(): BrowserNode[] {
  // Models / links
  const links: { id: string; label: string }[] = [];
  try {
    if (ctx.fragments?.list) {
      for (const [id, model] of ctx.fragments.list) {
        const name = (model as any)?.object?.name || (model as any)?.name || id;
        links.push({ id, label: String(name).split("/").pop() || id });
      }
    }
  } catch { /* */ }

  // Stored views (views module) — subgrouped by kind in the tree model.
  // bootViewsStore() is idempotent: it seeds the default plan / elevation /
  // section views on first run and re-reads persistence afterwards.
  try { bootViewsStore(); } catch { /* */ }
  let views: { id: string; kind: string; name: string }[] = [];
  try {
    views = listViews().map((v) => ({ id: v.id, kind: v.kind, name: v.name }));
  } catch { /* */ }

  // Family definitions + their types, via the family service installed at
  // boot (main.ts step "families"). If the service is not ready the
  // Families node still lists materials below.
  let families: ProjectBrowserTreeInput["families"] = [];
  try {
    const svc = (ctx.features as any)?.family;
    const defs = svc?.list?.() ?? [];
    families = defs.map((f: any) => ({
      id: String(f.id),
      name: String(f.name),
      // The right-click menu needs this: built-in families cannot be deleted.
      builtIn: f.builtIn === true,
      types: (f.types ?? []).map((t: any) => ({ id: String(t.id), name: String(t.name) })),
    }));
  } catch { /* */ }

  // Materials / families
  ensureDefaultMaterials();
  const mats = listMaterials().map((m) => ({ id: m.id, name: m.name }));

  // Selection sets as groups
  const groups: { id: string; name: string }[] = [];
  try {
    const sets = selection.listSets() ?? [];
    for (const s of sets) groups.push({ id: s.id, name: s.name });
  } catch { /* */ }

  // 4D phases
  const phases = listPhases().map((p) => ({
    id: p.id,
    name: p.name,
    elementCount: p.elementIds.length,
  }));

  return buildProjectBrowserTree({
    links,
    savedViews: listSavedViews().map((v) => ({ id: v.id, name: v.name })),
    sheets: listSheets().map((s) => ({ id: s.id, number: s.number, name: s.name })),
    materials: mats,
    families,
    groups,
    phases,
    views,
  });
}

function onActivate(node: BrowserNode) {
  selectedNodeId = node.id;
  try {
    switch (node.kind) {
      case "view-3d":
        goHome();
        fitAll();
        break;
      case "view-plan":
        togglePlanView();
        break;
      case "view-def":
        // Stored view (plan / section / elevation / …): open it in the
        // Views panel, selected and rendered.
        if (node.meta?.viewId) openViewInPanel(String(node.meta.viewId));
        break;
      case "view-group":
        // Intermediate subgroup: single click expands / collapses.
        if (expanded.has(node.id)) expanded.delete(node.id);
        else expanded.add(node.id);
        break;
      case "view-saved":
        if (node.meta?.viewId) restoreView(String(node.meta.viewId));
        break;
      case "schedule":
        if (node.id === "sch-cost") {
          import("./cost-panel").then((m) => m.toggleCostPanel()).catch(() => {});
        } else {
          toggleSchedules();
        }
        break;
      case "schedules":
        toggleSchedules();
        break;
      case "sheets":
      case "sheet":
        if (node.id === "sheet-empty") {
          createDefaultSheetSet();
          render();
        }
        toggleSheetsPanel();
        break;
      case "families":
      case "material":
        ensureDefaultMaterials();
        if (!isPropertyPaletteVisible()) togglePropertyPalette();
        break;
      case "family":
        // A family with types expands / collapses; a typeless family
        // behaves like the old Families node and opens Properties.
        if (node.children?.length) {
          if (expanded.has(node.id)) expanded.delete(node.id);
          else expanded.add(node.id);
        } else {
          ensureDefaultMaterials();
          if (!isPropertyPaletteVisible()) togglePropertyPalette();
        }
        break;
      case "family-type":
        ensureDefaultMaterials();
        if (!isPropertyPaletteVisible()) togglePropertyPalette();
        break;
      case "materials":
        // Materials subgroup: single click expands / collapses.
        if (expanded.has(node.id)) expanded.delete(node.id);
        else expanded.add(node.id);
        break;
      case "links":
      case "link":
        toggleModelTreePanel();
        break;
      case "groups":
      case "group":
        if (node.meta?.setId) {
          void selection.loadSet(String(node.meta.setId));
        }
        break;
      case "phases":
      case "phase":
        if (node.id === "phase-empty") {
          createDefaultPhases();
          render();
        }
        toggleTimelinePanel();
        break;
      default:
        break;
    }
  } catch (e) {
    console.warn("[project-browser] activate", e);
  }
  render();
}

function findNode(nodes: BrowserNode[], id: string): BrowserNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

function notifyBrowser(message: string, kind: "success" | "warn" | "error" | "info" = "success") {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
}

/* ── Right-click menu (G11) ──────────────────────────────────────────────
 * The items come from the pure model (./project-browser-menu); this layer
 * only renders them and executes them against the stores. The menu is a
 * separate body-level element (like the model-tree panel's), so re-rendering
 * the tree never destroys it mid-click. */

let menuEl: HTMLDivElement | null = null;

function closeBrowserMenu() {
  if (menuEl) menuEl.style.display = "none";
}

function ensureMenuEl(): HTMLDivElement {
  if (menuEl) return menuEl;
  menuEl = document.createElement("div");
  menuEl.id = "obs-project-browser-menu";
  menuEl.setAttribute("data-obs-ui", "1");
  menuEl.style.cssText =
    "position:fixed;z-index:10000;display:none;min-width:220px;max-width:300px;" +
    "background:var(--bg-floating,#1e1f26);border:1px solid var(--border-default,#3a3a4a);border-radius:8px;" +
    "box-shadow:0 10px 30px rgba(0,0,0,.55);font:12px system-ui,sans-serif;color:var(--text-primary,#e2e8f0);padding:4px 0";
  document.body.appendChild(menuEl);
  // Close on any click outside — same pattern as the model-tree panel's
  // menu. A click on an item is inside the menu, so it runs before this
  // handler can close it. Escape is NOT handled here: the global
  // escape-all orchestrator consumes bare Escape (stopImmediatePropagation)
  // whenever any scope cancels something, so a private window keydown
  // listener would never fire; the menu registers as an escape scope in
  // setupProjectBrowser instead.
  window.addEventListener("mousedown", (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeBrowserMenu();
  });
  return menuEl;
}

function openBrowserMenu(node: BrowserNode, x: number, y: number) {
  const items = menuItemsForNode(node, { hasSelection: !selection.isEmpty() });
  if (!items || !items.length) return;
  const el = ensureMenuEl();
  el.innerHTML = "";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "pb-menu-item";
    row.dataset.action = it.id;
    if (it.disabled) {
      row.dataset.disabled = "true";
      row.setAttribute("aria-disabled", "true");
      if (it.disabledReason) row.title = it.disabledReason;
    }
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;white-space:nowrap" +
      (it.disabled ? ";opacity:.45;cursor:default" : "") +
      (it.danger ? ";color:#f87171" : "");
    row.innerHTML =
      `<span style="width:18px;text-align:center;flex-shrink:0">${it.icon ?? ""}</span>` +
      `<span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(it.label)}</span>`;
    if (!it.disabled) {
      row.addEventListener("mouseenter", () => { row.style.background = "var(--bg-hover,#2c2d38)"; });
      row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
      row.addEventListener("click", () => {
        closeBrowserMenu();
        void runMenuAction(node, it.id);
      });
    }
    el.appendChild(row);
  }
  el.style.display = "block";
  // Keep the whole menu on screen (flip up / left when it would overflow).
  const mw = el.offsetWidth, mh = el.offsetHeight;
  let mx = x, my = y;
  if (x + mw > window.innerWidth - 4) mx = Math.max(0, x - mw);
  if (y + mh > window.innerHeight - 4) my = Math.max(0, y - mh);
  el.style.left = `${Math.max(0, mx)}px`;
  el.style.top = `${Math.max(0, my)}px`;
}

/** Ask for a new name through the app dialog; null when cancelled/empty. */
async function promptName(title: string, label: string, current: string): Promise<string | null> {
  const name = await promptLine(title, label, current);
  if (name == null) return null;
  const trimmed = name.trim();
  if (!trimmed) {
    notifyBrowser("Name cannot be empty.", "warn");
    return null;
  }
  return trimmed;
}

function familyService(): any {
  return (ctx.features as any)?.family;
}

/**
 * Execute one menu action for real. Rename prompts through the app
 * form-modal, delete confirms through the app dialog, and every mutation
 * goes through the store that owns the data; the tree re-renders after.
 */
async function runMenuAction(node: BrowserNode, action: ProjectBrowserMenuActionId): Promise<void> {
  try {
    switch (action) {
      case "open":
        onActivate(node);
        return;

      case "expand-all": {
        const walk = (nodes: BrowserNode[]) => {
          for (const n of nodes) {
            expanded.add(n.id);
            if (n.children) walk(n.children);
          }
        };
        walk(buildTree());
        render();
        return;
      }

      case "open-sheets":
        toggleSheetsPanel();
        return;
      case "open-schedules":
        toggleSchedules();
        return;
      case "open-cost":
        import("./cost-panel").then((m) => m.toggleCostPanel()).catch(() => {});
        return;
      case "open-timeline":
        toggleTimelinePanel();
        return;
      case "open-model-tree":
        toggleModelTreePanel();
        return;
      case "open-properties":
        ensureDefaultMaterials();
        if (!isPropertyPaletteVisible()) togglePropertyPalette();
        return;

      case "new-view": {
        if (node.kind === "view-group") {
          // A kind subgroup creates a stored view of that kind.
          const kind = node.id.replace(/^views-/, "") as ViewKind;
          const label = newViewLabel(node.label);
          const name = await promptName(label, "View name", `${label.replace(/^New /, "")} ${listViews().length + 1}`);
          if (name == null) return;
          createView(kind, name);
          notifyBrowser(`Created view "${name}".`);
          expanded.add("views");
          expanded.add(node.id);
        } else {
          const name = await promptName("Save view", "View name", `View ${listSavedViews().length + 1}`);
          if (name == null) return;
          saveCurrentView(name);
          notifyBrowser(`Saved view "${name}".`);
          expanded.add("views");
          expanded.add("views-saved");
        }
        render();
        return;
      }

      case "save-view": {
        const name = await promptName("Save view", "View name", `View ${listSavedViews().length + 1}`);
        if (name == null) return;
        saveCurrentView(name);
        notifyBrowser(`Saved view "${name}".`);
        expanded.add("views");
        expanded.add("views-saved");
        render();
        return;
      }

      case "new-sheet": {
        const sheet = createSheet();
        notifyBrowser(`Created sheet "${sheet.number} — ${sheet.name}".`);
        expanded.add("sheets");
        render();
        return;
      }

      case "new-phase": {
        const name = await promptName("New phase", "Phase name", `Phase ${listPhases().length + 1}`);
        if (name == null) return;
        addPhase(name);
        notifyBrowser(`Created phase "${name}".`);
        expanded.add("phases");
        render();
        return;
      }

      case "new-material": {
        const name = await promptName("New material", "Material name", "New Material");
        if (name == null) return;
        addMaterial({ name });
        notifyBrowser(`Created material "${name}".`);
        expanded.add("families");
        expanded.add("families-materials");
        render();
        return;
      }

      case "new-set": {
        const name = await promptName("New selection set", "Set name", `Set ${selection.listSets().length + 1}`);
        if (name == null) return;
        selection.saveSet(name);
        notifyBrowser(`Saved selection set "${name}".`);
        expanded.add("groups");
        render();
        return;
      }

      case "create-default-sheets":
        createDefaultSheetSet();
        notifyBrowser("Created the default sheet set.");
        expanded.add("sheets");
        render();
        return;

      case "create-default-phases":
        createDefaultPhases();
        notifyBrowser("Created the default phases.");
        expanded.add("phases");
        render();
        return;

      case "rename": {
        const name = await promptName("Rename", "Name", node.label);
        if (name == null) return;
        switch (node.kind) {
          case "sheet": {
            updateSheet(String(node.meta?.sheetId ?? ""), { name });
            break;
          }
          case "view-def":
            updateView(String(node.meta?.viewId ?? ""), { name });
            break;
          case "view-saved":
            renameSavedView(String(node.meta?.viewId ?? ""), name);
            break;
          case "family":
            familyService()?.update?.(String(node.meta?.familyId ?? node.id.replace(/^fam-/, "")), { name });
            break;
          case "family-type":
            familyService()?.updateType?.(
              String(node.meta?.familyId ?? ""),
              String(node.meta?.typeId ?? ""),
              { name },
            );
            break;
          case "group":
            selection.renameSet(String(node.meta?.setId ?? ""), name);
            break;
          case "phase":
            updatePhase(String(node.meta?.phaseId ?? ""), { name });
            break;
          default:
            return;
        }
        notifyBrowser(`Renamed to "${name}".`);
        render();
        return;
      }

      case "duplicate": {
        switch (node.kind) {
          case "sheet": {
            const copy = duplicateSheet(String(node.meta?.sheetId ?? ""));
            if (copy) notifyBrowser(`Duplicated sheet as "${copy.number} — ${copy.name}".`);
            break;
          }
          case "view-def": {
            const copy = duplicateStoredView(String(node.meta?.viewId ?? ""));
            if (copy) notifyBrowser(`Duplicated view as "${copy.name}".`);
            break;
          }
          case "view-saved": {
            const copy = duplicateSavedView(String(node.meta?.viewId ?? ""));
            if (copy) notifyBrowser(`Duplicated view as "${copy.name}".`);
            break;
          }
          case "family": {
            const id = String(node.meta?.familyId ?? node.id.replace(/^fam-/, ""));
            const copy = familyService()?.duplicate?.(id, `${node.label} (copy)`);
            if (copy) notifyBrowser(`Duplicated family as "${copy.name}".`);
            break;
          }
          case "family-type": {
            const fid = String(node.meta?.familyId ?? "");
            const tid = String(node.meta?.typeId ?? "");
            const fam = familyService()?.get?.(fid);
            const type = fam?.types?.find((t: any) => String(t.id) === tid);
            const copy = familyService()?.createType?.(fid, `${node.label} (copy)`, { ...(type?.values ?? {}) });
            if (copy) notifyBrowser(`Duplicated type as "${copy.name}".`);
            break;
          }
          case "group": {
            const copy = selection.duplicateSet(String(node.meta?.setId ?? ""));
            if (copy) notifyBrowser(`Duplicated set as "${copy.name}".`);
            break;
          }
          case "phase": {
            const src = listPhases().find((p) => p.id === String(node.meta?.phaseId ?? ""));
            const np = addPhase(`${src?.name ?? node.label} (copy)`);
            if (src) assignSelectionToPhase(np.id, [...src.elementIds]);
            notifyBrowser(`Duplicated phase as "${np.name}".`);
            break;
          }
          default:
            return;
        }
        render();
        return;
      }

      case "delete": {
        const ok = await confirmDialog(`Delete ${node.label}?`, `Delete "${node.label}"?`);
        if (!ok) return;
        switch (node.kind) {
          case "sheet":
            deleteSheet(String(node.meta?.sheetId ?? ""));
            break;
          case "view-def":
            deleteStoredView(String(node.meta?.viewId ?? ""));
            break;
          case "view-saved":
            deleteSavedView(String(node.meta?.viewId ?? ""));
            break;
          case "family": {
            const id = String(node.meta?.familyId ?? node.id.replace(/^fam-/, ""));
            if (!familyService()?.remove?.(id)) {
              notifyBrowser("Built-in families cannot be deleted.", "warn");
              return;
            }
            break;
          }
          case "family-type":
            familyService()?.removeType?.(String(node.meta?.familyId ?? ""), String(node.meta?.typeId ?? ""));
            break;
          case "group":
            selection.deleteSet(String(node.meta?.setId ?? ""));
            break;
          case "phase":
            removePhase(String(node.meta?.phaseId ?? ""));
            break;
          default:
            return;
        }
        if (selectedNodeId === node.id) selectedNodeId = null;
        notifyBrowser(`Deleted "${node.label}".`);
        render();
        return;
      }

      default:
        return;
    }
  } catch (e) {
    console.warn("[project-browser] menu action", action, e);
    notifyBrowser(`Could not run "${action}": ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

function renderNode(node: BrowserNode, depth: number, forceExpand = false): string {
  const hasKids = !!(node.children && node.children.length);
  const isExp = forceExpand || expanded.has(node.id);
  const isSel = selectedNodeId === node.id;
  const pad = 8 + depth * 14;
  const chevron = hasKids ? (isExp ? "▼" : "▶") : "·";
  const count = node.count != null ? `<span class="pb-count">${node.count}</span>` : "";

  let html = `
    <div class="pb-row ${isSel ? "is-sel" : ""}" data-id="${esc(node.id)}" data-kind="${esc(node.kind)}"
         style="padding-inline-start:${pad}px" title="${esc(node.label)}">
      <span class="pb-chev" data-toggle="${esc(node.id)}">${chevron}</span>
      <span class="pb-icon">${node.icon}</span>
      <span class="pb-label">${esc(node.label)}</span>
      ${count}
    </div>`;

  if (hasKids && isExp) {
    for (const c of node.children!) html += renderNode(c, depth + 1, forceExpand);
  }
  return html;
}

function render() {
  if (!panel) return;
  // While a filter is active every matching branch is shown expanded, so a
  // match is never hidden inside a collapsed subgroup.
  const filtering = filterQuery.trim().length > 0;
  const tree = filtering ? filterProjectBrowserTree(buildTree(), filterQuery) : buildTree();
  const body = panel.querySelector(".pb-body");
  if (!body) return;
  body.innerHTML = tree.map((n) => renderNode(n, 0, filtering)).join("");

  body.querySelectorAll(".pb-row").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = (el as HTMLElement).dataset.id!;
      // Toggle expand on chevron
      const t = (e.target as HTMLElement).closest("[data-toggle]") as HTMLElement | null;
      if (t) {
        const tid = t.dataset.toggle!;
        if (expanded.has(tid)) expanded.delete(tid);
        else expanded.add(tid);
        render();
        return;
      }
      // Find node
      const node = findNode(tree, id);
      if (node) onActivate(node);
    });
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const id = (el as HTMLElement).dataset.id!;
      const node = findNode(tree, id);
      if (node) onActivate(node);
    });
    // G11: right-click opens the node's context menu (Open / Rename /
    // Duplicate / Delete and the creation actions). stopPropagation keeps
    // the viewport context menu from opening over the browser panel.
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = (el as HTMLElement).dataset.id!;
      const node = findNode(tree, id);
      if (!node) return;
      selectedNodeId = node.id;
      render();
      openBrowserMenu(node, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    });
  });
}

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "obs-project-browser";
  panel.style.cssText =
    "position:fixed;left:12px;top:52px;width:280px;bottom:48px;z-index:8200;" +
    "display:none;flex-direction:column;background:#1a1d27;color:#e8eaf0;" +
    "border:1px solid #2a2e3a;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.5);" +
    "font:12px/1.35 system-ui,Segoe UI,sans-serif;overflow:hidden";

  panel.innerHTML = `
    <div class="pb-header">
      <span class="pb-title">Project Browser</span>
      <div class="pb-actions">
        <button type="button" data-act="refresh" title="Refresh">⟲</button>
        <button type="button" data-act="props" title="Properties">☰</button>
        <button type="button" data-act="close" title="Close">✕</button>
      </div>
    </div>
    <div class="pb-toolbar">
      <button type="button" data-act="new-view">+ View</button>
      <button type="button" data-act="new-sheet">+ Sheet</button>
      <button type="button" data-act="expand">Expand</button>
    </div>
    <div class="pb-filter">
      <input type="text" class="pb-filter-input" placeholder="Filter…" aria-label="Filter browser" autocomplete="off" />
    </div>
    <div class="pb-body"></div>
    <div class="pb-footer">Open BIM Studio · Project</div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    .obs-project-browser .pb-header {
      display:flex;align-items:center;justify-content:space-between;
      padding:8px 10px;background:#12141b;border-bottom:1px solid #2a2e3a;
      font-weight:600;font-size:12px;user-select:none;
    }
    .obs-project-browser .pb-actions button {
      background:transparent;border:none;color:#94a3b8;cursor:pointer;
      font-size:13px;padding:2px 6px;border-radius:4px;
    }
    .obs-project-browser .pb-actions button:hover { background:#2a2e3a;color:#e2e8f0; }
    .obs-project-browser .pb-toolbar {
      display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid #1e2029;
    }
    .obs-project-browser .pb-toolbar button {
      flex:1;background:#252836;border:1px solid #2a2e3a;color:#cbd5e1;
      border-radius:4px;padding:4px 6px;font-size:11px;cursor:pointer;
    }
    .obs-project-browser .pb-toolbar button:hover { background:#2f3344; }
    .obs-project-browser .pb-filter {
      padding:6px 8px;border-bottom:1px solid #1e2029;
    }
    .obs-project-browser .pb-filter-input {
      width:100%;box-sizing:border-box;background:#12141b;border:1px solid #2a2e3a;
      color:#e8eaf0;border-radius:4px;padding:5px 8px;font-size:12px;outline:none;
    }
    .obs-project-browser .pb-filter-input:focus { border-color:#38bdf8; }
    .obs-project-browser .pb-filter-input::placeholder { color:#64748b; }
    .obs-project-browser .pb-body {
      flex:1;overflow-y:auto;padding:4px 0;
    }
    .obs-project-browser .pb-row {
      display:flex;align-items:center;gap:6px;padding:4px 8px 4px 8px;
      cursor:pointer;border-inline-start:2px solid transparent;
    }
    .obs-project-browser .pb-row:hover { background:#222533; }
    .obs-project-browser .pb-row.is-sel {
      background:#1e3a5f;border-inline-start-color:#38bdf8;
    }
    .obs-project-browser .pb-chev {
      width:12px;font-size:9px;color:#64748b;text-align:center;flex-shrink:0;
    }
    /* RTL (#141): the expand chevron "▶" points the other way (scaleX of "▼" is still "▼"). */
    html[dir="rtl"] .obs-project-browser .pb-chev { display:inline-block;transform:scaleX(-1); }
    .obs-project-browser .pb-icon { flex-shrink:0;font-size:12px; }
    .obs-project-browser .pb-label {
      flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    .obs-project-browser .pb-count {
      font-size:10px;color:#64748b;background:#12141b;padding:1px 5px;border-radius:8px;
    }
    .obs-project-browser .pb-footer {
      padding:5px 10px;font-size:10px;color:#64748b;border-top:1px solid #1e2029;
      background:#12141b;
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  panel.querySelectorAll("[data-act]").forEach((el) => {
    el.addEventListener("click", () => {
      const act = (el as HTMLElement).dataset.act;
      if (act === "close") setVisible(false);
      if (act === "refresh") render();
      if (act === "props") {
        if (!isPropertyPaletteVisible()) togglePropertyPalette();
      }
      if (act === "new-view") {
        saveCurrentView();
        render();
      }
      if (act === "new-sheet") {
        createSheet();
        toggleSheetsPanel();
        render();
      }
      if (act === "expand") {
        // Expand every node in the tree, including view-kind subgroups.
        const walk = (nodes: BrowserNode[]) => {
          for (const n of nodes) {
            expanded.add(n.id);
            if (n.children) walk(n.children);
          }
        };
        walk(buildTree());
        render();
      }
    });
  });

  // As-you-type filter: narrows the tree by node name. The input lives
  // outside .pb-body, so re-rendering the tree never steals focus.
  const filterInput = panel.querySelector(".pb-filter-input") as HTMLInputElement | null;
  filterInput?.addEventListener("input", () => {
    filterQuery = filterInput.value;
    render();
  });

  return panel;
}

export function setVisible(on: boolean) {
  visible = on;
  const el = ensurePanel();
  el.style.display = on ? "flex" : "none";
  if (on) render();
}

export function toggleProjectBrowser() {
  setVisible(!visible);
}

export function isProjectBrowserVisible() {
  return visible;
}

export function setupProjectBrowser() {
  ensurePanel();
  // G11: the context menu is transient UI — Escape closes it through the
  // global escape-all orchestrator (priority 150: above the generic
  // ui-transients scope, below tool/mode scopes), because escape-all
  // consumes bare Escape before any private window keydown listener runs.
  if (!escapeScopeRegistered) {
    escapeScopeRegistered = true;
    registerEscapeScope({
      id: "project-browser-menu",
      priority: 150,
      cancel: () => {
        if (menuEl && menuEl.style.display !== "none") {
          closeBrowserMenu();
          return true;
        }
        return false;
      },
    });
  }
  // Refresh when models load
  try {
    window.addEventListener("obs-toast", () => {
      if (visible) setTimeout(render, 200);
    });
  } catch { /* */ }
  // openbim-fix:workspace-layout -- expose the panel via the feature
  // registry so workspace-layout can save/restore its open state.
  (ctx.features as any).projectBrowser = {
    open: () => setVisible(true),
    close: () => setVisible(false),
    toggle: toggleProjectBrowser,
    isVisible: isProjectBrowserVisible,
  };
  // openbim-fix:workspace-layout -- expose the panel via the feature
  // registry so workspace-layout can save/restore its open state.
  ctx.features.projectBrowser = {
    open: () => setVisible(true),
    close: () => setVisible(false),
    toggle: toggleProjectBrowser,
    isVisible: isProjectBrowserVisible,
  };
}
