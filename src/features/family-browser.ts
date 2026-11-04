// openbim-step1.5:family-browser
// Family Browser - dockable panel surfacing the family system from Step 1.
//
// Layout:
//   +--------------------------------------------------+
//   |  Families                            [x] [+]      |
//   +--------------------------------------------------+
//   |  search                          category filter  |
//   +------------------+-------------------------------+
//   |  category tree   |  family detail (preview,      |
//   |  families/types  |  parameters, types, actions)  |
//   +------------------+-------------------------------+
//   |  status bar: counts + storage key                 |
//   +--------------------------------------------------+
//
// All actions are wired. Place sets the matching authoring tool. Step 2
// will replace the authoring tool path with a real family-driven mesh.

import * as THREE from "three";
import { ctx } from "../core/context";
import { promptLine, confirmDialog, pickFromList } from "./form-modal";
import { makeDockable, type DockHandle } from "./dockable";
import { setupFamilies, isFamilySystemReady } from "../modules/families";
import type { FamilyDefinition, FamilyType, FamilyService } from "../modules/families";
import type { ConnectorDefinition } from "../modules/object-hierarchy";
import { validateFamilyConnectorDefinitions, cloneFamilyConnectorDefinitions } from "../modules/families/connector-definitions";
import { buildFamilyConnectorPreviewLayout, projectedDeltaToLocalAxisDelta, type PreviewLocalAxis } from "../modules/families/connector-preview";
import { connectorDirectionToYawPitch, yawPitchToConnectorDirection } from "../modules/families/connector-orientation";
// openbim-families:formula-engine-ui
import { evaluateParameters } from "../modules/families/formula-engine";

const PANEL_ID = "obs-family-browser";
const SVG_NS = "http://www.w3.org/2000/svg";

// -----------------------------------------------------------------------------
// Panel shell
// -----------------------------------------------------------------------------
const panel = document.createElement("div");
panel.id = PANEL_ID;
panel.style.cssText =
  "display:none;flex-direction:column;z-index:58;background:var(--bg-floating,#1c1e28);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
  "box-shadow:0 16px 50px rgba(0,0,0,.55);color:var(--text-primary,#e8eaf0);" +
  "font:12px system-ui,sans-serif;overflow:hidden;min-width:460px";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:8px;padding:9px 10px;" +
  "border-bottom:1px solid var(--border-subtle,#1e2029);" +
  "background:var(--bg-elevated,#181a23);cursor:grab;user-select:none";

const title = document.createElement("div");
title.textContent = "Families";
title.style.cssText = "font-weight:700;flex:1;letter-spacing:.2px";

const newBtn = mkHeaderBtn("+ Family", "Duplicate the current family under a new name", () => onNewFamily());
const refreshBtn = mkHeaderBtn("↻", "Reload from storage", () => reloadAll());
const closeBtn = mkHeaderBtn("✕", "Close", () => closeFamilyBrowser());
header.append(title, newBtn, refreshBtn, closeBtn);

function mkHeaderBtn(label: string, tooltip: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = tooltip;
  b.style.cssText =
    "padding:3px 9px;background:transparent;color:var(--text-secondary,#a0a6b5);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:5px;" +
    "cursor:pointer;font:11px system-ui";
  b.onmouseenter = () => { b.style.background = "var(--bg-hover,#232633)"; b.style.color = "var(--text-primary,#e8eaf0)"; };
  b.onmouseleave = () => { b.style.background = "transparent"; b.style.color = "var(--text-secondary,#a0a6b5)"; };
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

// --- Toolbar ---------------------------------------------------------------
const toolbar = document.createElement("div");
toolbar.style.cssText =
  "display:flex;align-items:center;gap:6px;padding:6px 8px;" +
  "border-bottom:1px solid var(--border-subtle,#1e2029);background:var(--bg-inset,#0e1017)";

const searchInput = document.createElement("input");
searchInput.type = "text";
searchInput.placeholder = "Search families, types, IFC entity…";
searchInput.style.cssText =
  "flex:1;padding:5px 9px;background:#0f1118;border:1px solid var(--border-default,#2a2e3a);" +
  "border-radius:5px;color:var(--text-primary,#e8eaf0);font:11.5px system-ui;outline:none";

const categoryFilter = document.createElement("select");
categoryFilter.style.cssText =
  "padding:5px 8px;background:#0f1118;border:1px solid var(--border-default,#2a2e3a);" +
  "border-radius:5px;color:var(--text-primary,#e8eaf0);font:11px system-ui;cursor:pointer";
categoryFilter.title = "Filter by category";
toolbar.append(searchInput, categoryFilter);

// --- Body ------------------------------------------------------------------
const body = document.createElement("div");
body.style.cssText = "display:flex;flex:1;min-height:0;height:520px";

const treePane = document.createElement("div");
treePane.style.cssText =
  "width:230px;flex:none;overflow-y:auto;padding:6px 4px;border-right:1px solid var(--border-subtle,#1e2029);" +
  "background:#0b0d12";

const detailPane = document.createElement("div");
detailPane.style.cssText = "flex:1;min-width:0;overflow-y:auto;padding:10px 12px";

body.append(treePane, detailPane);

// --- Status bar ------------------------------------------------------------
const statusBar = document.createElement("div");
statusBar.style.cssText =
  "padding:5px 10px;border-top:1px solid var(--border-subtle,#1e2029);" +
  "background:var(--bg-elevated,#181a23);font:10.5px ui-monospace,monospace;" +
  "color:var(--text-tertiary,#6b7280)";

panel.append(header, toolbar, body, statusBar);

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
let dock: DockHandle | null = null;
let visible = false;
let selectedFamilyId: string | null = null;
let selectedTypeId: string | null = null;
let searchQuery = "";
let categoryValue = "all";

function svc(): FamilyService | null {
  const s = (ctx.features as any).family as FamilyService | undefined;
  return s ?? null;
}

function reloadAll(): void {
  const s = svc();
  if (!s) {
    statusBar.textContent = "family system not initialized";
    return;
  }
  const list = s.list();
  const categories = new Set<string>(["all"]);
  for (const f of list) categories.add(f.category);

  const prevFilter = categoryFilter.value;
  categoryFilter.innerHTML = Array.from(categories)
    .map((c) => `<option value="${c}">${c === "all" ? "All categories" : c}</option>`)
    .join("");
  categoryFilter.value = categories.has(prevFilter) ? prevFilter : "all";
  categoryValue = categoryFilter.value;

  if (!selectedFamilyId && list.length) selectedFamilyId = list[0].id;

  const totalTypes = list.reduce((n, f) => n + f.types.length, 0);
  statusBar.textContent = list.length + " families · " + totalTypes + " types · obs.families.v1";
  renderTree();
  renderDetail();
}

function filteredFamilies(): FamilyDefinition[] {
  const s = svc();
  if (!s) return [];
  const q = searchQuery.trim().toLowerCase();
  return s.list().filter((f) => {
    if (categoryValue !== "all" && f.category !== categoryValue) return false;
    if (!q) return true;
    if (f.name.toLowerCase().includes(q)) return true;
    if (f.category.toLowerCase().includes(q)) return true;
    if (f.ifcEntity.toLowerCase().includes(q)) return true;
    for (const t of f.types) if (t.name.toLowerCase().includes(q)) return true;
    return false;
  });
}

// -----------------------------------------------------------------------------
// Tree
// -----------------------------------------------------------------------------
function renderTree(): void {
  treePane.innerHTML = "";
  const list = filteredFamilies();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.textContent = "No matching families.";
    empty.style.cssText = "padding:16px;color:#6b7280;font-size:11px;text-align:center";
    treePane.appendChild(empty);
    return;
  }

  // Group families by category, in alphabetical order.
  const byCat = new Map<string, FamilyDefinition[]>();
  for (const f of list) {
    const bucket = byCat.get(f.category) ?? [];
    bucket.push(f);
    byCat.set(f.category, bucket);
  }
  const cats = Array.from(byCat.keys()).sort();

  for (const cat of cats) {
    const header = document.createElement("div");
    header.textContent = cat + "  (" + byCat.get(cat)!.length + ")";
    header.style.cssText =
      "padding:5px 8px;font:600 10px system-ui;letter-spacing:.4px;text-transform:uppercase;" +
      "color:#64748b;background:rgba(255,255,255,.02);border-radius:4px;margin-top:4px";
    treePane.appendChild(header);

    for (const fam of byCat.get(cat)!) {
      const row = document.createElement("div");
      const active = fam.id === selectedFamilyId;
      row.style.cssText =
        "display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:5px;" +
        "cursor:pointer;font-size:11.5px;margin:1px 0;" +
        (active
          ? "background:rgba(56,189,248,.14);color:#7dd3fc"
          : "color:#cbd5e1");
      row.onmouseenter = () => { if (!active) row.style.background = "rgba(255,255,255,.04)"; };
      row.onmouseleave = () => { if (!active) row.style.background = ""; };
      row.onclick = () => {
        selectedFamilyId = fam.id;
        selectedTypeId = fam.types[0]?.id ?? null;
        renderTree();
        renderDetail();
      };

      const icon = document.createElement("span");
      icon.textContent = fam.builtIn ? "●" : "○";
      icon.style.cssText = "font-size:9px;color:" + (fam.builtIn ? "#38bdf8" : "#a855f7");

      const name = document.createElement("span");
      name.textContent = fam.name;
      name.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

      const count = document.createElement("span");
      count.textContent = String(fam.types.length);
      count.style.cssText = "font-size:9.5px;color:#64748b;font-family:ui-monospace,monospace";

      row.append(icon, name, count);
      treePane.appendChild(row);

      // Types under the family, if it is selected.
      if (active) {
        for (const t of fam.types) {
          const trow = document.createElement("div");
          const tActive = t.id === selectedTypeId;
          trow.style.cssText =
            "display:flex;align-items:center;gap:6px;padding:3px 8px 3px 24px;border-radius:4px;" +
            "cursor:pointer;font-size:11px;margin:1px 0;" +
            (tActive
              ? "background:rgba(56,189,248,.10);color:#7dd3fc"
              : "color:#94a3b8");
          trow.onmouseenter = () => { if (!tActive) trow.style.background = "rgba(255,255,255,.03)"; };
          trow.onmouseleave = () => { if (!tActive) trow.style.background = ""; };
          trow.onclick = (e) => {
            e.stopPropagation();
            selectedTypeId = t.id;
            renderTree();
            renderDetail();
          };
          const bullet = document.createElement("span");
          bullet.textContent = "▸";
          bullet.style.cssText = "font-size:8px;opacity:.6";
          const tname = document.createElement("span");
          tname.textContent = t.name;
          tname.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
          trow.append(bullet, tname);
          treePane.appendChild(trow);
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Detail
// -----------------------------------------------------------------------------
function renderDetail(): void {
  detailPane.innerHTML = "";
  const s = svc();
  if (!s) {
    const msg = document.createElement("div");
    msg.textContent = "Family service is not initialized. Reload the page.";
    msg.style.cssText = "padding:20px;color:#fca5a5;font-size:12px";
    detailPane.appendChild(msg);
    return;
  }
  const fam = selectedFamilyId ? s.get(selectedFamilyId) : null;
  if (!fam) {
    const msg = document.createElement("div");
    msg.textContent = "Select a family on the left.";
    msg.style.cssText = "padding:20px;color:#6b7280;font-size:12px;text-align:center";
    detailPane.appendChild(msg);
    return;
  }

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:baseline;gap:8px;margin-bottom:4px";
  const nm = document.createElement("div");
  nm.textContent = fam.name;
  nm.style.cssText = "font-size:15px;font-weight:700;letter-spacing:.1px";
  const kind = document.createElement("span");
  kind.textContent = fam.builtIn ? "built-in" : "user";
  kind.style.cssText =
    "font:600 9.5px ui-monospace,monospace;letter-spacing:.4px;text-transform:uppercase;" +
    "padding:2px 6px;border-radius:3px;" +
    (fam.builtIn
      ? "background:rgba(56,189,248,.14);color:#7dd3fc"
      : "background:rgba(168,85,247,.14);color:#c4b5fd");
  head.append(nm, kind);

  const meta = document.createElement("div");
  meta.style.cssText = "font:11px ui-monospace,monospace;color:#94a3b8;margin-bottom:10px";
  meta.textContent =
    "category: " + fam.category +
    "   ifc: " + fam.ifcEntity +
    (fam.sourceElementType ? "   maps to: " + fam.sourceElementType : "");

  detailPane.append(head, meta);

  // --- Preview (isometric geometry + editable local MEP connector ports) ---
  const preview = document.createElement("div");
  preview.style.cssText =
    "background:#0b0d12;border:1px solid var(--border-subtle,#1e2029);border-radius:6px;" +
    "padding:8px;margin-bottom:10px;display:flex;align-items:center;justify-content:center;min-height:160px";
  let builtPreviewObject: THREE.Object3D | null = null;
  const connectorPreviewState: FamilyConnectorPreviewState = {
    axis: "x",
    definitions: (fam.connectorDefs ?? []).map(definition => ({
      ...definition,
      origin: [...definition.origin] as [number, number, number],
      direction: [...definition.direction] as [number, number, number],
      size: Array.isArray(definition.size) ? [...definition.size] as [number, number] : definition.size,
    })),
    onPortMove: () => { /* assigned by the connector editor below */ },
    refresh: () => { /* assigned after the geometry preview is built */ },
  };
  connectorPreviewState.refresh = () => {
    if (!builtPreviewObject) return;
    preview.replaceChildren(buildPreviewSvg(builtPreviewObject, connectorPreviewState.definitions, {
      dragAxis: connectorPreviewState.axis,
      interactive: !fam.builtIn,
      onPortMove: connectorPreviewState.onPortMove,
    }));
  };
  try {
    builtPreviewObject = s.buildGeometry(fam.id, selectedTypeId, undefined);
    if (builtPreviewObject) connectorPreviewState.refresh();
    else {
      const em = document.createElement("div");
      em.textContent = "(no geometry for this type)";
      em.style.cssText = "color:#6b7280;font-size:11px";
      preview.appendChild(em);
    }
  } catch (err) {
    const em = document.createElement("div");
    em.textContent = "preview failed: " + (err instanceof Error ? err.message : String(err));
    em.style.cssText = "color:#fca5a5;font-size:11px";
    preview.appendChild(em);
  }
  detailPane.appendChild(preview);

  // --- Parameters table ---
  detailPane.appendChild(sectionLabel("Parameters"));
  const pTable = document.createElement("table");
  pTable.style.cssText = "width:100%;border-collapse:collapse;font-size:11.5px;margin-bottom:12px";
  const pHead = document.createElement("thead");
  pHead.innerHTML =
    `<tr style="background:#12141b">` +
    `<th style="text-align:left;padding:4px 6px;font-weight:600;color:#94a3b8">Name</th>` +
    `<th style="text-align:left;padding:4px 6px;font-weight:600;color:#94a3b8">Type</th>` +
    `<th style="text-align:left;padding:4px 6px;font-weight:600;color:#94a3b8">Scope</th>` +
    `<th style="text-align:right;padding:4px 6px;font-weight:600;color:#94a3b8">Value</th>` +
    `</tr>`;
  pTable.appendChild(pHead);
  const pBody = document.createElement("tbody");
  const resolved = s.resolveParams(fam.id, selectedTypeId, undefined) ?? {};
  // openbim-families:formula-engine-ui
  let __fxComputed = new Set<string>();
  let __fxErrors = new Map<string, { parameter: string; message: string; formula: string }>();
  try {
    const __fx = evaluateParameters(fam.parameters, resolved);
    __fxComputed = __fx.computed;
    __fxErrors = new Map(__fx.errors.map((e) => [e.parameter, e]));
  } catch (err) {
    console.warn("[family-browser] formula eval failed", err);
  }
  for (const p of fam.parameters) {
    const tr = document.createElement("tr");
    tr.style.cssText = "border-bottom:1px solid #1a1d24";
    const v = resolved[p.name];
    const formatted = formatParamValue(p, v);
    tr.innerHTML =
      `<td style="padding:4px 6px">` + esc(p.label ?? p.name) + `</td>` +
      `<td style="padding:4px 6px;color:#94a3b8">` + esc(p.type) + (p.unit ? " (" + esc(p.unit) + ")" : "") + `</td>` +
      `<td style="padding:4px 6px;color:#94a3b8">` + esc(p.scope) + `</td>` +
      `<td style="padding:4px 6px;text-align:right;font-family:ui-monospace,monospace;color:#7dd3fc">` + esc(formatted) + `</td>`;
    pBody.appendChild(tr);
  }
  pTable.appendChild(pBody);
  detailPane.appendChild(pTable);

  // openbim-families:formula-editor
  if (fam.parameters.length > 0) {
    try {
      detailPane.appendChild(
        buildFormulaDiagnosticsBlock(fam, __fxComputed, __fxErrors),
      );
    } catch (err) {
      console.warn("[family-browser] formula diagnostics failed", err);
    }
  }

  // --- Family-local MEP connector definitions ------------------------------
  try {
    detailPane.appendChild(buildMepConnectorsSection(fam, connectorPreviewState));
  } catch (err) {
    console.warn("[family-browser] MEP connectors section failed", err);
  }

  // --- Types table ---
  detailPane.appendChild(sectionLabel("Types"));
  const tBar = document.createElement("div");
  tBar.style.cssText = "display:flex;gap:6px;margin-bottom:8px";
  const addType = mkActionBtn("+ Type", () => onAddType(fam), false);
  const removeType = mkActionBtn("Remove", () => onRemoveType(fam), false);
  removeType.disabled = !selectedTypeId || fam.types.length <= 1;
  if (removeType.disabled) removeType.style.opacity = "0.45";
  tBar.append(addType, removeType);
  detailPane.appendChild(tBar);

  const tList = document.createElement("div");
  tList.style.cssText = "display:flex;flex-direction:column;gap:2px;margin-bottom:14px";
  for (const t of fam.types) {
    const row = document.createElement("div");
    const active = t.id === selectedTypeId;
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:5px;font-size:11.5px;" +
      "cursor:pointer;" +
      (active
        ? "background:rgba(56,189,248,.14);color:#7dd3fc;border:1px solid #38bdf8"
        : "background:#0b0d12;border:1px solid #1e2029;color:#cbd5e1");
    row.onclick = () => { selectedTypeId = t.id; renderTree(); renderDetail(); };

    const tname = document.createElement("span");
    tname.textContent = t.name;
    tname.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

    const overrides = document.createElement("span");
    const keys = Object.keys(t.values || {});
    overrides.textContent = keys.length ? keys.length + " override" + (keys.length === 1 ? "" : "s") : "defaults";
    overrides.style.cssText = "font:10px ui-monospace,monospace;color:#64748b";

    row.append(tname, overrides);
    tList.appendChild(row);
  }
  detailPane.appendChild(tList);

  // openbim-families:instance-wiring
  try {
    detailPane.appendChild(buildInstancesSection(fam));
  } catch (err) {
    console.warn("[family-browser] instances section failed", err);
  }

  // --- Footer actions -------------------------------------------------------
  const actions = document.createElement("div");
  actions.style.cssText =
    "display:flex;gap:6px;flex-wrap:wrap;padding-top:10px;border-top:1px solid #1e2029";
  const place = mkActionBtn("Place " + (selectedTypeId ? "this type" : "family"), () => onPlaceReal(fam), true);
  const dup = mkActionBtn("Duplicate family", () => onDuplicate(fam), false);
  const del = mkActionBtn("Delete family", () => onDelete(fam), false);
  const exportBtn = mkActionBtn("Export JSON", () => onExport(fam), false);
  del.disabled = fam.builtIn;
  if (del.disabled) del.style.opacity = "0.45";

  actions.append(place, dup, del, exportBtn);
  detailPane.appendChild(actions);
}


// -----------------------------------------------------------------------------
// MEP connector-definition editor
// -----------------------------------------------------------------------------
type ConnectorDraft = {
  name: string;
  domain: ConnectorDefinition["domain"];
  shape: ConnectorDefinition["shape"];
  flowDirection: ConnectorDefinition["flowDirection"];
  systemClassification: string;
  origin: [string, string, string];
  direction: [string, string, string];
  sizeA: string;
  sizeB: string;
};


type FamilyConnectorPreviewState = {
  axis: PreviewLocalAxis;
  definitions: ConnectorDefinition[];
  onPortMove: (index: number, origin: [number, number, number]) => void;
  refresh: () => void;
};
const CONNECTOR_DOMAINS: ConnectorDefinition["domain"][] =
  ["duct", "pipe", "electrical", "conduit", "cabletray", "structural", "other"];
const CONNECTOR_SHAPES: ConnectorDefinition["shape"][] =
  ["round", "rectangular", "oval", "point"];
const CONNECTOR_FLOWS: ConnectorDefinition["flowDirection"][] = ["in", "out", "inout"];

function connectorDraft(definition: ConnectorDefinition): ConnectorDraft {
  const size = definition.size;
  return {
    name: definition.name,
    domain: definition.domain,
    shape: definition.shape,
    flowDirection: definition.flowDirection,
    systemClassification: definition.systemClassification,
    origin: definition.origin.map(String) as [string, string, string],
    direction: definition.direction.map(String) as [string, string, string],
    sizeA: Array.isArray(size) ? String(size[0]) : String(size),
    sizeB: Array.isArray(size) ? String(size[1]) : "",
  };
}

function connectorNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

function connectorDraftDefinition(draft: ConnectorDraft): ConnectorDefinition {
  const firstSize = connectorNumber(draft.sizeA);
  const secondSize = connectorNumber(draft.sizeB);
  const size: number | [number, number] =
    draft.shape === "rectangular" || (draft.shape === "oval" && draft.sizeB.trim() !== "")
      ? [firstSize, secondSize]
      : firstSize;
  return {
    name: draft.name.trim(),
    domain: draft.domain,
    shape: draft.shape,
    flowDirection: draft.flowDirection,
    systemClassification: draft.systemClassification.trim(),
    origin: draft.origin.map(connectorNumber) as [number, number, number],
    direction: draft.direction.map(connectorNumber) as [number, number, number],
    size,
  };
}

function buildMepConnectorsSection(fam: FamilyDefinition, previewState: FamilyConnectorPreviewState): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "margin:12px 0 14px;padding:9px;border:1px solid var(--border-subtle,#1e2029);" +
    "border-radius:7px;background:#0b0d12";
  const title = sectionLabel("MEP connectors");
  title.style.marginTop = "0";
  wrap.appendChild(title);

  const hint = document.createElement("div");
  hint.textContent = fam.builtIn
    ? "Numbered markers show port origins; arrows show connection axes."
    : "Drag a numbered port along the selected local axis. Set direction with yaw/pitch angles; the arrow updates live. Save connectors to persist changes.";
  hint.style.cssText = "color:#94a3b8;font-size:10.5px;line-height:1.5;margin-bottom:8px";
  wrap.appendChild(hint);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:8px";
  wrap.appendChild(list);

  const status = document.createElement("div");
  status.style.cssText = "font-size:10.5px;line-height:1.45;margin-top:7px;color:#fca5a5;white-space:pre-wrap";
  wrap.appendChild(status);

  const existing = fam.connectorDefs ?? [];
  if (fam.builtIn) {
    const locked = document.createElement("div");
    locked.textContent = "Built-in family definitions are read-only. Duplicate this family to add or edit connector ports.";
    locked.style.cssText = "padding:8px;border:1px dashed #384152;border-radius:5px;color:#cbd5e1;font-size:11px;line-height:1.5";
    wrap.appendChild(locked);
    if (existing.length) {
      for (const definition of existing) {
        const row = document.createElement("div");
        row.textContent = definition.name + " · " + definition.domain + " · " +
          definition.shape + " · " + definition.systemClassification;
        row.style.cssText = "font:10.5px ui-monospace,monospace;color:#94a3b8;padding:4px 0";
        wrap.appendChild(row);
      }
    } else {
      const empty = document.createElement("div");
      empty.textContent = "No connector definitions yet.";
      empty.style.cssText = "color:#64748b;font-size:10.5px";
      wrap.appendChild(empty);
    }
    return wrap;
  }

  let drafts = existing.map(connectorDraft);
  const orientationErrors = new Map<ConnectorDraft, string>();

  const notifyPreview = (): void => {
    previewState.definitions = drafts.map(connectorDraftDefinition);
    previewState.refresh();
  };

  const makeInput = (
    labelText: string,
    value: string,
    width: string,
    onChange: (value: string) => void,
    afterChange?: () => void,
  ): HTMLElement => {
    const field = document.createElement("label");
    field.style.cssText = "display:flex;flex-direction:column;gap:3px;min-width:0;flex:0 0 " + width;
    const caption = document.createElement("span");
    caption.textContent = labelText;
    caption.style.cssText = "font-size:9px;color:#94a3b8";
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.spellcheck = false;
    input.style.cssText =
      "box-sizing:border-box;width:100%;min-width:0;padding:4px 5px;background:#11141d;" +
      "border:1px solid #303746;border-radius:4px;color:#e8eaf0;font:10.5px ui-monospace,monospace";
    input.addEventListener("input", () => { onChange(input.value); afterChange?.(); notifyPreview(); });
    field.append(caption, input);
    return field;
  };

  const makeSelect = <T extends string>(
    labelText: string,
    value: T,
    options: T[],
    onChange: (value: T) => void,
  ): HTMLElement => {
    const field = document.createElement("label");
    field.style.cssText = "display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 90px";
    const caption = document.createElement("span");
    caption.textContent = labelText;
    caption.style.cssText = "font-size:9px;color:#94a3b8";
    const select = document.createElement("select");
    select.style.cssText =
      "box-sizing:border-box;width:100%;min-width:0;padding:4px 5px;background:#11141d;" +
      "border:1px solid #303746;border-radius:4px;color:#e8eaf0;font:10.5px system-ui";
    for (const option of options) {
      const item = document.createElement("option");
      item.value = option;
      item.textContent = option;
      select.appendChild(item);
    }
    select.value = value;
    select.addEventListener("change", () => onChange(select.value as T));
    field.append(caption, select);
    return field;
  };

  const makeFieldRow = (): HTMLDivElement => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:5px;align-items:flex-end;flex-wrap:wrap";
    return row;
  };

  if (!fam.builtIn) {
    const dragAxis = makeFieldRow();
    dragAxis.style.marginBottom = "8px";
    dragAxis.appendChild(makeSelect(
      "DRAG PORT ALONG LOCAL AXIS",
      previewState.axis,
      ["x", "y", "z"] as PreviewLocalAxis[],
      value => {
        previewState.axis = value;
        previewState.refresh();
      },
    ));
    wrap.appendChild(dragAxis);
  }



  const renderRows = (): void => {
    orientationErrors.clear();
    list.innerHTML = "";
    drafts.forEach((draft, index) => {
      const card = document.createElement("div");
      card.style.cssText =
        "padding:7px;background:#11141d;border:1px solid #252d39;border-radius:5px;display:flex;flex-direction:column;gap:6px";
      const identity = makeFieldRow();
      identity.append(
        makeInput("PORT NAME", draft.name, "115px", value => { draft.name = value; }),
        makeSelect("DOMAIN", draft.domain, CONNECTOR_DOMAINS, value => { draft.domain = value; }),
        makeSelect("SHAPE", draft.shape, CONNECTOR_SHAPES, value => {
          draft.shape = value;
          renderRows();
          notifyPreview();
        }),
        makeSelect("FLOW", draft.flowDirection, CONNECTOR_FLOWS, value => { draft.flowDirection = value; }),
        makeInput("SYSTEM CLASSIFICATION", draft.systemClassification, "160px", value => { draft.systemClassification = value; }),
      );
      const remove = mkActionBtn("Remove", () => {
        drafts.splice(index, 1);
        status.textContent = "";
        renderRows();
        notifyPreview();
      }, false);
      remove.style.padding = "4px 7px";
      identity.appendChild(remove);
      const coords = makeFieldRow();
      coords.append(
        makeInput("ORIGIN X", draft.origin[0], "72px", value => { draft.origin[0] = value; }),
        makeInput("ORIGIN Y", draft.origin[1], "72px", value => { draft.origin[1] = value; }),
        makeInput("ORIGIN Z", draft.origin[2], "72px", value => { draft.origin[2] = value; }),
      );

      let yawInput: HTMLInputElement | null = null;
      let pitchInput: HTMLInputElement | null = null;
      const directionInputs: HTMLInputElement[] = [];
      const syncAnglesFromDirection = (): void => {
        try {
          const angles = connectorDirectionToYawPitch(draft.direction.map(connectorNumber));
          if (yawInput) yawInput.value = angles.yawDeg.toFixed(2);
          if (pitchInput) pitchInput.value = angles.pitchDeg.toFixed(2);
          orientationErrors.delete(draft);
        } catch {
          // Preserve the last valid angle display while the vector is being corrected.
        }
      };
      const directionField = (axisIndex: number, label: string): HTMLElement => {
        const field = makeInput(
          label,
          draft.direction[axisIndex],
          "80px",
          value => { draft.direction[axisIndex] = value; },
          syncAnglesFromDirection,
        );
        const input = field.querySelector("input");
        if (input) directionInputs.push(input);
        return field;
      };
      coords.append(
        directionField(0, "DIRECTION X"),
        directionField(1, "DIRECTION Y"),
        directionField(2, "DIRECTION Z"),
        makeInput("SIZE A (m)", draft.sizeA, "78px", value => { draft.sizeA = value; }),
        makeInput("SIZE B (m)", draft.sizeB, "78px", value => { draft.sizeB = value; }),
      );

      const orientation = makeFieldRow();
      const initialAngles = (() => {
        try {
          return connectorDirectionToYawPitch(draft.direction.map(connectorNumber));
        } catch {
          return { yawDeg: 0, pitchDeg: 0 };
        }
      })();
      const makeAngleInput = (
        label: string,
        value: number,
        width: string,
        min: string | null,
        max: string | null,
      ): { field: HTMLElement; input: HTMLInputElement } => {
        const field = document.createElement("label");
        field.style.cssText = "display:flex;flex-direction:column;gap:3px;min-width:0;flex:0 0 " + width;
        const caption = document.createElement("span");
        caption.textContent = label;
        caption.style.cssText = "font-size:9px;color:#94a3b8";
        const input = document.createElement("input");
        input.type = "number";
        input.step = "0.1";
        if (min !== null) input.min = min;
        if (max !== null) input.max = max;
        input.value = value.toFixed(2);
        input.style.cssText =
          "box-sizing:border-box;width:100%;min-width:0;padding:4px 5px;background:#11141d;" +
          "border:1px solid #303746;border-radius:4px;color:#e8eaf0;font:10.5px ui-monospace,monospace";
        field.append(caption, input);
        return { field, input };
      };
      const applyOrientation = (): void => {
        if (!yawInput || !pitchInput) return;
        const yaw = connectorNumber(yawInput.value);
        const pitch = connectorNumber(pitchInput.value);
        try {
          const direction = yawPitchToConnectorDirection(yaw, pitch);
          draft.direction = direction.map(String) as [string, string, string];
          directionInputs.forEach((input, axisIndex) => {
            input.value = draft.direction[axisIndex];
          });
          status.style.color = "#86efac";
          orientationErrors.delete(draft);
          status.textContent =
            "Updated " + (draft.name || ("connector " + (index + 1))) +
            " direction. The preview arrow reflects this draft; save connectors to persist it.";
          notifyPreview();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          orientationErrors.set(draft, message);
          status.style.color = "#fca5a5";
          status.textContent = message;
        }
      };
      const yawControl = makeAngleInput("YAW (°)", initialAngles.yawDeg, "88px", null, null);
      const pitchControl = makeAngleInput("PITCH (°)", initialAngles.pitchDeg, "88px", "-90", "90");
      yawInput = yawControl.input;
      pitchInput = pitchControl.input;
      yawControl.input.addEventListener("input", applyOrientation);
      pitchControl.input.addEventListener("input", applyOrientation);
      const orientationHint = document.createElement("span");
      orientationHint.textContent = "Yaw: +X → +Z · Pitch: −90° to +90°";
      orientationHint.style.cssText = "align-self:center;color:#64748b;font-size:9px;margin-left:4px";
      orientation.append(yawControl.field, pitchControl.field, orientationHint);
      card.append(identity, coords, orientation);
      list.appendChild(card);
    });
    if (!drafts.length) {
      const empty = document.createElement("div");
      empty.textContent = "No connector ports defined for this family.";
      empty.style.cssText = "color:#64748b;font-size:10.5px;padding:4px 0";
      list.appendChild(empty);
    }
    notifyPreview();
  };

  previewState.onPortMove = (index, origin) => {
    const draft = drafts[index];
    if (!draft) return;
    draft.origin = origin.map(value => Number(value.toFixed(6)).toString()) as [string, string, string];
    status.style.color = "#86efac";
    status.textContent =
      "Moved " + (draft.name || ("connector " + (index + 1))) +
      " along local " + previewState.axis.toUpperCase() +
      ". Save connectors to persist this change.";
    renderRows();
  };

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:8px";
  const add = mkActionBtn("+ Add connector", () => {
    const defaultDomain: ConnectorDefinition["domain"] =
      fam.category === "duct" ? "duct" :
      fam.category === "pipe" ? "pipe" :
      fam.category === "conduit" ? "conduit" :
      fam.category === "cable-tray" ? "cabletray" :
      fam.category === "equipment" ? "pipe" : "other";
    drafts.push({
      name: "Port " + (drafts.length + 1),
      domain: defaultDomain,
      shape: "round",
      flowDirection: "inout",
      systemClassification: defaultDomain + "-default",
      origin: ["0", "0", "0"],
      direction: ["1", "0", "0"],
      sizeA: "0.05",
      sizeB: "",
    });
    status.textContent = "";
    renderRows();
    notifyPreview();
  }, false);
  const save = mkActionBtn("Save connectors", () => {
    const s = svc();
    if (!s) { status.textContent = "Family service is unavailable."; return; }
    if (orientationErrors.size) {
      status.style.color = "#fca5a5";
      status.textContent = [...orientationErrors.values()].map(error => "• " + error).join("\n");
      return;
    }
    const definitions = drafts.map(connectorDraftDefinition);
    const errors = validateFamilyConnectorDefinitions(definitions);
    if (errors.length) {
      status.textContent = errors.map(error => "• " + error).join("\n");
      return;
    }
    const updated = s.update(fam.id, {
      connectorDefs: cloneFamilyConnectorDefinitions(definitions),
    });
    if (!updated) {
      status.textContent = "The family connector definitions could not be saved.";
      return;
    }
    toast("Saved " + definitions.length + " MEP connector" + (definitions.length === 1 ? "" : "s") + ".", "success");
    reloadAll();
  }, true);
  actions.append(add, save);
  wrap.appendChild(actions);
  renderRows();
  return wrap;
}

function sectionLabel(text: string): HTMLElement {
  const h = document.createElement("div");
  h.textContent = text;
  h.style.cssText =
    "font:700 10px system-ui;letter-spacing:.5px;text-transform:uppercase;" +
    "color:#64748b;margin:8px 0 6px";
  return h;
}

// openbim-families:formula-engine-ui
//
// "Formula diagnostics" block rendered under the Parameters table.
// Shows every parameter that has a formula:
//   - formula text (monospace, truncated with full text in tooltip)
//   - purple name when the formula resolves
//   - red name when the formula errored, plus the error message below
//
// Reads only what evaluateParameters() already produced, so no extra
// computation is performed here.
function buildFormulaDiagnosticsBlock(
  fam: FamilyDefinition,
  computed: Set<string>,
  errors: Map<string, { parameter: string; message: string; formula: string }>,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "border:1px solid var(--border-subtle,#1e2029);border-radius:6px;" +
    "margin:0 0 12px;overflow:hidden;background:#0b0d12";

  const head = document.createElement("div");
  head.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:6px 10px;" +
    "background:#12141b;font:600 11px system-ui;" +
    "border-bottom:1px solid var(--border-subtle,#1e2029)";

  const fx = document.createElement("span");
  fx.textContent = "Fx";
  fx.style.cssText = "color:#c084fc;font-family:ui-monospace,monospace;font-weight:700";

  const title = document.createElement("span");
  title.textContent = "Formula diagnostics";
  title.style.cssText = "flex:1;color:#e8eaf0";

  const summary = document.createElement("span");
  summary.style.cssText = "font:10px ui-monospace,monospace;color:#6b7280";
  const nErr = errors.size;
  summary.textContent =
    computed.size + " computed" +
    (nErr > 0 ? " | " + nErr + " error" + (nErr === 1 ? "" : "s") : "");
  if (nErr > 0) summary.style.color = "#fca5a5";

  head.append(fx, title, summary);
  wrap.appendChild(head);

  const list = document.createElement("div");
  list.style.cssText = "padding:6px 10px;font:11px system-ui";

  // openbim-families:formula-editor
  const formulaParams = fam.parameters.filter((p) => !!p.formula);

  if (formulaParams.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "No formulas yet. Use '+ Add formula' below.";
    empty.style.cssText = "font-size:10.5px;color:#6b7280;padding:2px 0 6px";
    list.appendChild(empty);
  }

  for (const p of formulaParams) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:grid;grid-template-columns:120px 1fr;gap:8px;padding:2px 0;" +
      "align-items:center";

    const name = document.createElement("span");
    name.textContent = p.name;
    name.style.cssText =
      "font-family:ui-monospace,monospace;overflow:hidden;" +
      "text-overflow:ellipsis;white-space:nowrap;" +
      (errors.has(p.name) ? "color:#fca5a5" : "color:#c084fc");
    name.title = p.name;

    const expr = document.createElement("input");
    expr.type = "text";
    expr.value = p.formula ?? "";
    expr.spellcheck = false;
    expr.style.cssText =
      "width:100%;box-sizing:border-box;padding:1px 6px;" +
      "font-family:ui-monospace,monospace;font-size:11px;color:#c084fc;" +
      "background:transparent;border:1px solid transparent;" +
      "border-radius:3px;outline:none";
    expr.onfocus = () => {
      expr.style.borderColor = "var(--accent,#38bdf8)";
      expr.style.background = "#0e1017";
    };
    expr.onblur = () => {
      expr.style.borderColor = "transparent";
      expr.style.background = "transparent";
    };
    expr.onkeydown = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); expr.blur(); }
      if (ev.key === "Escape") { expr.value = p.formula ?? ""; expr.blur(); }
    };
    expr.onchange = () => {
      const next = expr.value.trim();
      const cur = (p.formula ?? "").trim();
      if (next === cur) return;
      const store = svc();
      if (!store) return;
      const newParams = fam.parameters.map((x) =>
        x.name === p.name
          ? { ...x, formula: next || undefined }
          : x,
      );
      try {
        store.update(fam.id, { parameters: newParams });
      } catch (err) {
        console.warn("[family-browser] formula save failed", err);
      }
      renderDetail();
    };

    row.append(name, expr);
    list.appendChild(row);
  }

  // "+ Add formula" row ------------------------------------------------
  try {
    const addRow = document.createElement("div");
    addRow.style.cssText = "padding:6px 0 2px;border-top:1px solid #1e2029;margin-top:6px";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "+ Add formula";
    addBtn.style.cssText =
      "padding:3px 10px;background:transparent;color:#94a3b8;" +
      "border:1px dashed #2a2e3a;border-radius:4px;cursor:pointer;font:10.5px system-ui";
    addBtn.onmouseenter = () => (addBtn.style.color = "#38bdf8");
    addBtn.onmouseleave = () => (addBtn.style.color = "#94a3b8");
    addBtn.onclick = async (ev) => {
      ev.stopPropagation();
      const store = svc();
      if (!store) return;
      const available = fam.parameters.filter((x) => !x.formula);
      if (!available.length) {
        window.dispatchEvent(new CustomEvent("obs-toast", {
          detail: { message: "Every parameter already has a formula.", kind: "info" },
        }));
        return;
      }
      const names = available.map((x) => x.name);
      const choose = await pickFromList(
        "Add formula",
        "Add a formula to which parameter?",
        names.map((n) => ({ value: n, label: n })),
        names[0],
      );
      if (!choose || names.indexOf(choose) < 0) return;
      const formula = await promptLine("Add formula", "Formula for " + choose + ":", "= ");
      if (formula == null) return;
      const next = fam.parameters.map((x) =>
        x.name === choose ? { ...x, formula: formula.trim() || undefined } : x,
      );
      try {
        store.update(fam.id, { parameters: next });
      } catch (err) {
        console.warn("[family-browser] add formula failed", err);
      }
      renderDetail();
    };

    addRow.appendChild(addBtn);
    list.appendChild(addRow);
  } catch (err) {
    console.warn("[family-browser] add-formula row failed", err);
  }

  for (const e of errors.values()) {
    const row = document.createElement("div");
    row.style.cssText =
      "margin-top:6px;padding:5px 8px;border-left:2px solid #ef4444;" +
      "background:rgba(239,68,68,.07);font-size:10.5px;line-height:1.5;color:#fca5a5";
    const strong = document.createElement("b");
    strong.textContent = e.parameter + ": ";
    const msg = document.createTextNode(e.message);
    row.append(strong, msg);
    list.appendChild(row);
  }

  wrap.appendChild(list);
  return wrap;
}

// openbim-families:instance-wiring
//
// "Instances of this family" section. Counts every authored element
// whose familyId matches, groups by type, and exposes a "Sync instances"
// button that re-resolves params from the family definition.
function buildInstancesSection(fam: FamilyDefinition): HTMLElement {
  const sec = document.createElement("div");
  sec.style.cssText = "margin-top:8px;border-top:1px solid #1e2029;padding-top:8px";

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:8px;margin-bottom:6px";
  const label = document.createElement("div");
  label.textContent = "Instances of this family";
  label.style.cssText =
    "flex:1;font:700 10px system-ui;letter-spacing:.5px;text-transform:uppercase;" +
    "color:#64748b";
  header.appendChild(label);
  sec.appendChild(header);

  const auth: any = (ctx.features as any).authoring;
  const all: any[] = auth?.getElements?.() ?? [];
  const instances = all.filter((el) => el.familyId === fam.id);

  const info = document.createElement("div");
  info.style.cssText = "font:11px system-ui;color:#94a3b8;margin-bottom:6px";
  if (!instances.length) {
    info.textContent = "No placed instances. Press Place, then click in the viewport.";
    sec.appendChild(info);
    return sec;
  }

  const byType = new Map<string, number>();
  for (const el of instances) {
    const key = el.familyTypeId ?? "(untyped)";
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const t of fam.types) {
    const n = byType.get(t.id) ?? 0;
    if (n > 0) parts.push(t.name + " (" + n + ")");
  }
  const untyped = byType.get("(untyped)") ?? 0;
  if (untyped > 0) parts.push("untyped (" + untyped + ")");
  info.textContent =
    instances.length + " instance" +
    (instances.length === 1 ? "" : "s") +
    " -- " + parts.join(", ");
  sec.appendChild(info);

  const syncBtn = document.createElement("button");
  syncBtn.type = "button";
  syncBtn.textContent = "Sync instances";
  syncBtn.style.cssText =
    "padding:5px 12px;background:var(--bg-elevated,#181a23);" +
    "color:var(--text-primary,#e8eaf0);border:1px solid var(--border-default,#2a2e3a);" +
    "border-radius:5px;cursor:pointer;font:600 11px system-ui";
  syncBtn.onmouseenter = () => (syncBtn.style.background = "var(--bg-hover,#232633)");
  syncBtn.onmouseleave = () => (syncBtn.style.background = "var(--bg-elevated,#181a23)");
  syncBtn.onclick = (ev) => {
    ev.stopPropagation();
    if (!auth?.syncFamilyInstances) {
      toast("Authoring not ready.", "warn");
      return;
    }
    const n = auth.syncFamilyInstances(fam.id, selectedTypeId ?? null);
    toast(
      n > 0
        ? "Synced " + n + " instance" + (n === 1 ? "" : "s")
        : "All instances already up to date",
      n > 0 ? "success" : "info",
    );
    renderDetail();
  };
  sec.appendChild(syncBtn);

  return sec;
}

function formatParamValue(p: any, v: any): string {
  if (v === undefined || v === null) return "—";
  if (p.type === "length" && typeof v === "number") return v.toFixed(3) + " m";
  if (p.type === "angle"  && typeof v === "number") return v.toFixed(3) + " rad";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}

// -----------------------------------------------------------------------------
// Isometric preview
// -----------------------------------------------------------------------------
function buildPreviewSvg(
  obj: THREE.Object3D,
  connectorDefinitions: ConnectorDefinition[] = [],
  interaction: {
    dragAxis: PreviewLocalAxis;
    interactive: boolean;
    onPortMove: (index: number, origin: [number, number, number]) => void;
  } = { dragAxis: "x", interactive: false, onPortMove: () => { /* no-op */ } },
): SVGSVGElement {
  let layout: ReturnType<typeof buildFamilyConnectorPreviewLayout> = null;
  let connectorPreviewError = false;
  try {
    layout = buildFamilyConnectorPreviewLayout(obj, connectorDefinitions);
  } catch (err) {
    connectorPreviewError = true;
    console.warn("[family-browser] connector preview failed", err);
    // Keep the geometry preview useful even when stored connector data is invalid.
    layout = buildFamilyConnectorPreviewLayout(obj, []);
  }

  const w = 220, h = 160;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.style.cssText = "display:block;max-width:100%;touch-action:none";

  if (!layout) {
    svg.setAttribute("width", "200");
    svg.setAttribute("height", "150");
    return svg;
  }

  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  for (const [a, b] of edges) {
    const pa = layout.geometryCorners[a];
    const pb = layout.geometryCorners[b];
    if (!pa || !pb) continue;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", pa.x.toFixed(2));
    line.setAttribute("y1", pa.y.toFixed(2));
    line.setAttribute("x2", pb.x.toFixed(2));
    line.setAttribute("y2", pb.y.toFixed(2));
    line.setAttribute("stroke", "#38bdf8");
    line.setAttribute("stroke-width", "1.2");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
  }

  const connectorColors: Record<ConnectorDefinition["domain"], string> = {
    duct: "#a78bfa",
    pipe: "#38bdf8",
    electrical: "#fbbf24",
    conduit: "#fb923c",
    cabletray: "#34d399",
    structural: "#f472b6",
    other: "#cbd5e1",
  };

  type ActivePortDrag = {
    pointerId: number;
    group: SVGGElement;
    index: number;
    startClientX: number;
    startClientY: number;
    origin: [number, number, number];
    axisIndex: number;
    axisProjection: { x: number; y: number };
    delta: number;
  };
  let activeDrag: ActivePortDrag | null = null;

  const commitKeyboardNudge = (index: number, axis: PreviewLocalAxis, delta: number): void => {
    const definition = connectorDefinitions[index];
    if (!definition) return;
    const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
    const origin = [...definition.origin] as [number, number, number];
    origin[axisIndex] += delta;
    interaction.onPortMove(index, origin);
  };

  layout.ports.forEach((port, index) => {
    const color = connectorColors[port.domain] ?? "#cbd5e1";
    const group = document.createElementNS(SVG_NS, "g");
    const definition = connectorDefinitions[index];
    const tooltip = document.createElementNS(SVG_NS, "title");
    const size = Array.isArray(port.size) ? port.size.join(" × ") + " m" : port.size + " m";
    tooltip.textContent =
      port.name + " · " + port.domain + " · " + port.shape + " · " +
      port.flowDirection + " · " + port.systemClassification + " · " + size;
    group.appendChild(tooltip);

    const dx = port.axisEnd.x - port.origin.x;
    const dy = port.axisEnd.y - port.origin.y;
    const length = Math.hypot(dx, dy);
    if (length > 1.5) {
      const shaft = document.createElementNS(SVG_NS, "line");
      shaft.setAttribute("x1", port.origin.x.toFixed(2));
      shaft.setAttribute("y1", port.origin.y.toFixed(2));
      shaft.setAttribute("x2", port.axisEnd.x.toFixed(2));
      shaft.setAttribute("y2", port.axisEnd.y.toFixed(2));
      shaft.setAttribute("stroke", color);
      shaft.setAttribute("stroke-width", "2");
      shaft.setAttribute("stroke-linecap", "round");
      group.appendChild(shaft);

      const ux = dx / length, uy = dy / length;
      const headLength = Math.min(5.5, Math.max(3.5, length * 0.35));
      const halfWidth = headLength * 0.48;
      const baseX = port.axisEnd.x - ux * headLength;
      const baseY = port.axisEnd.y - uy * headLength;
      const leftX = baseX - uy * halfWidth;
      const leftY = baseY + ux * halfWidth;
      const rightX = baseX + uy * halfWidth;
      const rightY = baseY - ux * halfWidth;
      const head = document.createElementNS(SVG_NS, "polygon");
      head.setAttribute(
        "points",
        port.axisEnd.x.toFixed(2) + "," + port.axisEnd.y.toFixed(2) + " " +
        leftX.toFixed(2) + "," + leftY.toFixed(2) + " " +
        rightX.toFixed(2) + "," + rightY.toFixed(2),
      );
      head.setAttribute("fill", color);
      group.appendChild(head);
    }

    const marker = document.createElementNS(SVG_NS, "circle");
    marker.setAttribute("cx", port.origin.x.toFixed(2));
    marker.setAttribute("cy", port.origin.y.toFixed(2));
    marker.setAttribute("r", "5.8");
    marker.setAttribute("fill", color);
    marker.setAttribute("stroke", "#f8fafc");
    marker.setAttribute("stroke-width", "1");
    group.appendChild(marker);

    const number = document.createElementNS(SVG_NS, "text");
    number.setAttribute("x", port.origin.x.toFixed(2));
    number.setAttribute("y", (port.origin.y + 2.5).toFixed(2));
    number.setAttribute("text-anchor", "middle");
    number.setAttribute("font-family", "ui-monospace, monospace");
    number.setAttribute("font-size", "7.5");
    number.setAttribute("font-weight", "700");
    number.setAttribute("fill", "#07111c");
    number.textContent = String(index + 1);
    group.appendChild(number);

    if (interaction.interactive && typeof interaction.onPortMove === "function" && definition) {
      group.style.cursor = "grab";
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label",
        "Move connector " + port.name + " along local " + interaction.dragAxis.toUpperCase() +
        " axis. Use arrow keys for 10 millimetre adjustments.");
      group.addEventListener("pointerdown", (event) => {
        const pointer = event as PointerEvent;
        if (pointer.button !== 0 || activeDrag) return;
        pointer.preventDefault();
        pointer.stopPropagation();
        const axisIndex = interaction.dragAxis === "x" ? 0 : interaction.dragAxis === "y" ? 1 : 2;
        activeDrag = {
          pointerId: pointer.pointerId,
          group,
          index,
          startClientX: pointer.clientX,
          startClientY: pointer.clientY,
          origin: [...definition.origin] as [number, number, number],
          axisIndex,
          axisProjection: { ...port.axisProjection[interaction.dragAxis] },
          delta: 0,
        };
        group.style.cursor = "grabbing";
        try { svg.setPointerCapture(pointer.pointerId); } catch { /* pointer capture may be unavailable in test/older browsers */ }
      });
      group.addEventListener("keydown", (event) => {
        const key = event as KeyboardEvent;
        if (key.key !== "ArrowLeft" && key.key !== "ArrowRight" &&
            key.key !== "ArrowUp" && key.key !== "ArrowDown") return;
        key.preventDefault();
        key.stopPropagation();
        const delta = (key.key === "ArrowRight" || key.key === "ArrowUp" ? 1 : -1) * 0.01;
        commitKeyboardNudge(index, interaction.dragAxis, delta);
      });
    }

    svg.appendChild(group);
  });

  const updateDrag = (event: PointerEvent): void => {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
    const rect = svg.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const pointerDelta = {
      x: (event.clientX - activeDrag.startClientX) * w / rect.width,
      y: (event.clientY - activeDrag.startClientY) * h / rect.height,
    };
    try {
      activeDrag.delta = projectedDeltaToLocalAxisDelta(pointerDelta, activeDrag.axisProjection);
    } catch {
      activeDrag.delta = 0;
    }
    const movement = {
      x: activeDrag.axisProjection.x * activeDrag.delta,
      y: activeDrag.axisProjection.y * activeDrag.delta,
    };
    activeDrag.group.setAttribute("transform",
      "translate(" + movement.x.toFixed(2) + " " + movement.y.toFixed(2) + ")");
  };
  const finishDrag = (event: PointerEvent, commit: boolean): void => {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
    const finished = activeDrag;
    activeDrag = null;
    finished.group.removeAttribute("transform");
    finished.group.style.cursor = "grab";
    try { if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId); } catch { /* */ }
    if (!commit || Math.abs(finished.delta) < 1e-6) return;
    const origin = [...finished.origin] as [number, number, number];
    origin[finished.axisIndex] += finished.delta;
    interaction.onPortMove(finished.index, origin);
  };
  svg.addEventListener("pointermove", (event) => updateDrag(event as PointerEvent));
  svg.addEventListener("pointerup", (event) => finishDrag(event as PointerEvent, true));
  svg.addEventListener("pointercancel", (event) => finishDrag(event as PointerEvent, false));

  if (layout.ports.length) {
    const count = document.createElementNS(SVG_NS, "text");
    count.setAttribute("x", String(w - 6));
    count.setAttribute("y", "12");
    count.setAttribute("text-anchor", "end");
    count.setAttribute("font-family", "ui-monospace, monospace");
    count.setAttribute("font-size", "8.5");
    count.setAttribute("fill", "#cbd5e1");
    count.textContent = layout.ports.length + " MEP port" + (layout.ports.length === 1 ? "" : "s");
    svg.appendChild(count);
  }

  if (connectorPreviewError) {
    const warning = document.createElementNS(SVG_NS, "text");
    warning.setAttribute("x", "6");
    warning.setAttribute("y", "12");
    warning.setAttribute("font-family", "system-ui, sans-serif");
    warning.setAttribute("font-size", "8.5");
    warning.setAttribute("fill", "#fca5a5");
    warning.textContent = "Port preview unavailable — check definitions";
    svg.appendChild(warning);
  }

  // Dimensions are based on the actual family geometry, not expanded port extents.
  const dims = document.createElementNS(SVG_NS, "text");
  dims.setAttribute("x", String(w - 6));
  dims.setAttribute("y", String(h - 6));
  dims.setAttribute("text-anchor", "end");
  dims.setAttribute("font-family", "ui-monospace, monospace");
  dims.setAttribute("font-size", "9.5");
  dims.setAttribute("fill", "#64748b");
  dims.textContent =
    layout.dimensions[0].toFixed(2) + " × " +
    layout.dimensions[1].toFixed(2) + " × " +
    layout.dimensions[2].toFixed(2) + " m";
  svg.appendChild(dims);

  return svg;
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------
function mkActionBtn(label: string, onclick: () => void, primary: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText =
    "padding:5px 11px;border-radius:5px;cursor:pointer;font:600 11px system-ui;" +
    (primary
      ? "background:var(--accent,#38bdf8);color:#0b0d12;border:1px solid var(--accent,#38bdf8)"
      : "background:var(--bg-elevated,#181a23);color:var(--text-primary,#e8eaf0);border:1px solid var(--border-default,#2a2e3a)");
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

function toast(msg: string, kind: "info" | "success" | "warn" = "info") {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: msg, kind } }));
  } catch { /* */ }
}

function onPlace(fam: FamilyDefinition): void {
  const sourceType = fam.sourceElementType;
  if (!sourceType) {
    toast("This family has no authoring mapping yet (Step 2).", "warn");
    return;
  }
  try {
    const auth: any = (ctx.features as any).authoring;
    if (auth?.setAuthoringTool) {
      // openbim-families:instance-wiring
      try { auth.setActiveFamily?.(fam.id, selectedTypeId); } catch { /* */ }
      auth.setAuthoringTool(sourceType);
      const t = selectedTypeId ? fam.types.find((x) => x.id === selectedTypeId) : null;
      toast("Place " + fam.name + (t ? " · " + t.name : "") + " — click in the viewport", "success");
    } else {
      toast("Authoring not ready.", "warn");
    }
  } catch (err) {
    console.error("[family-browser] place failed", err);
  }
}

// openbim-families:real-placement
function onPlaceReal(fam: FamilyDefinition): void {
  const s = svc();
  const auth: any = (ctx.features as any).authoring;
  if (!s || !auth) { toast("Family or authoring not ready.", "warn"); return; }

  const built = s.buildGeometry(fam.id, selectedTypeId, undefined);
  if (!built) { toast("Family has no usable geometry for this type.", "warn"); return; }

  built.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(built);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  const positions: number[] = [];
  const v = new THREE.Vector3();
  built.traverse(function (o: any) {
    if (!o.isMesh || !o.geometry) return;
    const g: THREE.BufferGeometry = o.geometry;
    const pos = g.getAttribute("position");
    if (!pos) return;
    const idx = g.getIndex();
    const m = o.matrixWorld;
    const emit = function (i: number) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      positions.push(v.x, v.y, v.z);
    };
    if (idx) { for (let i = 0; i < idx.count; i++) emit(idx.getX(i)); }
    else { for (let i = 0; i < pos.count; i++) emit(i); }
  });

  if (!positions.length) { toast("Family geometry is empty.", "warn"); return; }

  if (typeof auth.addNativeGeometryElement === "function") {
    const native = auth.addNativeGeometryElement({
      name: fam.name,
      entity: fam.ifcEntity || "IfcBuildingElementProxy",
      sourceModelId: "family",
      sourceLocalId: Date.now(),
      sourceModelName: fam.name,
      positions: positions,
      position: [center.x, center.y, center.z],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      dimensions: { width: size.x, height: size.y, depth: size.z },
    });
    if (native) {
      try { auth.setSelectedAuthored && auth.setSelectedAuthored([native.id], "replace"); } catch (e) { /* ignore */ }
      toast("Placed: " + fam.name + " - use the Gizmo to move it.", "success");
      return;
    }
  }

  if (fam.sourceElementType) {
    try { auth.setActiveFamily && auth.setActiveFamily(fam.id, selectedTypeId); } catch (e) { /* ignore */ }
    auth.setAuthoringTool(fam.sourceElementType);
    toast("Place " + fam.name + " - click in the viewport", "success");
  } else {
    toast("Family has no sourceElementType and no direct geometry path.", "warn");
  }
}
async function onDuplicate(fam: FamilyDefinition): Promise<void> {
  const s = svc();
  if (!s) return;
  const name = await promptLine("Duplicate family", "New family name:", fam.name + " Copy");
  if (!name) return;
  const clone = s.duplicate(fam.id, name.trim() || (fam.name + " Copy"));
  if (clone) {
    selectedFamilyId = clone.id;
    selectedTypeId = clone.types[0]?.id ?? null;
    toast("Family duplicated: " + clone.name, "success");
    reloadAll();
  }
}

async function onDelete(fam: FamilyDefinition): Promise<void> {
  const s = svc();
  if (!s) return;
  if (fam.builtIn) { toast("Built-in families cannot be deleted.", "warn"); return; }
  if (!(await confirmDialog("Delete family", "Delete family “" + fam.name + "” and all its types?"))) return;
  if (s.remove(fam.id)) {
    if (selectedFamilyId === fam.id) {
      selectedFamilyId = null;
      selectedTypeId = null;
    }
    toast("Family deleted.", "info");
    reloadAll();
  }
}

async function onNewFamily(): Promise<void> {
  const s = svc();
  if (!s) return;
  const src = selectedFamilyId ? s.get(selectedFamilyId) : s.list()[0];
  if (!src) { toast("No family to duplicate.", "warn"); return; }
  const name = await promptLine("New family", "New family name:", "New " + src.category);
  if (!name) return;
  const clone = s.duplicate(src.id, name.trim() || ("New " + src.category));
  if (clone) {
    selectedFamilyId = clone.id;
    selectedTypeId = clone.types[0]?.id ?? null;
    toast("Created family: " + clone.name, "success");
    reloadAll();
  }
}

async function onAddType(fam: FamilyDefinition): Promise<void> {
  const s = svc();
  if (!s) return;
  const name = await promptLine("New type", "New type name:", fam.name + " Type " + (fam.types.length + 1));
  if (!name) return;
  const base: Record<string, any> = {};
  const resolved = s.resolveParams(fam.id, selectedTypeId, undefined) ?? {};
  for (const p of fam.parameters) if (p.scope === "type") base[p.name] = resolved[p.name];
  const t = s.createType(fam.id, name.trim() || ("Type " + (fam.types.length + 1)), base);
  if (t) {
    selectedTypeId = t.id;
    toast("Added type: " + t.name, "success");
    reloadAll();
  }
}

async function onRemoveType(fam: FamilyDefinition): Promise<void> {
  const s = svc();
  if (!s) return;
  if (!selectedTypeId) return;
  if (fam.types.length <= 1) { toast("A family must keep at least one type.", "warn"); return; }
  const t = fam.types.find((x) => x.id === selectedTypeId);
  if (!t) return;
  if (!(await confirmDialog("Delete type", "Delete type “" + t.name + "”?"))) return;
  if (s.removeType(fam.id, t.id)) {
    selectedTypeId = fam.types[0]?.id ?? null;
    toast("Type removed.", "info");
    reloadAll();
  }
}

function onExport(fam: FamilyDefinition): void {
  try {
    const blob = new Blob([JSON.stringify(fam, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fam.name.replace(/[^a-z0-9._-]+/gi, "_") + ".family.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast("Exported " + fam.name, "success");
  } catch (err) {
    toast("Export failed: " + (err instanceof Error ? err.message : String(err)), "warn");
  }
}

// -----------------------------------------------------------------------------
// Search / filter wiring
// -----------------------------------------------------------------------------
searchInput.addEventListener("input", () => { searchQuery = searchInput.value; renderTree(); });
categoryFilter.addEventListener("change", () => { categoryValue = categoryFilter.value; renderTree(); });

// -----------------------------------------------------------------------------
// Visibility
// -----------------------------------------------------------------------------
function ensureDock(): void {
  if (dock) return;
  dock = makeDockable(panel, {
    id: "family-browser",
    host: ctx.rightHost,
    header,
    minWidth: 460,
    minHeight: 400,
    defaultDock: "right",
    defaultWidth: 560,
    defaultHeight: 640,
  });
}

export function openFamilyBrowser(): void {
  if (!isFamilySystemReady()) {
    try { setupFamilies(); } catch (err) { console.warn("[family-browser] boot failed", err); }
  }
  if (!panel.parentElement) ctx.rightHost.appendChild(panel);
  ensureDock();
  visible = true;
  panel.style.display = "flex";
  dock?.show();
  reloadAll();
}

export function closeFamilyBrowser(): void {
  visible = false;
  dock?.hide();
  panel.style.display = "none";
}

export function toggleFamilyBrowser(): void {
  visible ? closeFamilyBrowser() : openFamilyBrowser();
}

export function isFamilyBrowserVisible(): boolean {
  return visible;
}

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------
let installed = false;

export function setupFamilyBrowser(): void {
  if (installed) return;
  installed = true;

  // Panel is lazily mounted; only ensure the singleton service exists.
  if (!isFamilySystemReady()) {
    try { setupFamilies(); } catch (err) { console.warn("[family-browser] boot failed", err); }
  }

  const svcAny = svc();
  const api = {
    open: openFamilyBrowser,
    close: closeFamilyBrowser,
    toggle: toggleFamilyBrowser,
    isVisible: isFamilyBrowserVisible,
    reload: reloadAll,
  };
  (ctx.features as any).familyBrowser = api;
  (window as any).__obsFamilyBrowser = api;

  // Ctrl+Shift+B toggles the panel.
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleFamilyBrowser();
    }
  }, true);

  console.log("[family-browser] ready. Toggle with Ctrl+Shift+B.");
  void svcAny;
}
