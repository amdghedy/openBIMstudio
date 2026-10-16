// Open BIM Studio - Step 1.5: Family Browser UI.
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const MARK = "openbim-step1.5:family-browser";

const stats = { created: 0, patched: 0, noop: 0, skipped: 0, warned: 0 };

function full(rel) { return path.join(root, rel); }
function exists(rel) { try { fs.accessSync(full(rel)); return true; } catch { return false; } }
function read(rel) { try { return fs.readFileSync(full(rel), "utf8"); } catch { return null; } }
function ensureDir(rel) { fs.mkdirSync(path.dirname(full(rel)), { recursive: true }); }
function backup(rel) { if (exists(rel)) fs.copyFileSync(full(rel), full(rel) + ".bak-fbui-" + stamp); }
function write(rel, s) { ensureDir(rel); fs.writeFileSync(full(rel), s, "utf8"); }
function log(kind, name, note) {
  let tag;
  if (kind === "CREATE") { tag = "CREATE"; stats.created++; }
  else if (kind === "PATCH") { tag = "PATCH "; stats.patched++; }
  else if (kind === "NOOP") { tag = "NOOP  "; stats.noop++; }
  else if (kind === "WARN") { tag = "WARN  "; stats.warned++; }
  else { tag = "SKIP  "; stats.skipped++; }
  console.log("  [" + tag + "] " + name + (note ? "  -- " + note : ""));
}
function readNorm(rel) {
  const raw = fs.readFileSync(full(rel), "utf8");
  const crlf = raw.indexOf("\r\n") >= 0;
  return { text: crlf ? raw.split("\r\n").join("\n") : raw, crlf };
}
function writeNorm(rel, text, crlf) {
  fs.writeFileSync(full(rel), crlf ? text.split("\n").join("\r\n") : text, "utf8");
}
function dumpContext(text, needle, radius) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(needle) >= 0) {
      const a = Math.max(0, i - radius), b = Math.min(lines.length - 1, i + radius);
      console.log("    (diag) around line " + (i + 1) + ":");
      for (let j = a; j <= b; j++) console.log("    " + String(j + 1).padStart(5, " ") + " | " + lines[j]);
      return;
    }
  }
  console.log("    (diag) no line contains: " + JSON.stringify(needle));
}

// =============================================================================
// 1. src/features/family-browser.ts
// =============================================================================
const TS_PANEL = `// ${MARK}
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
import { makeDockable, type DockHandle } from "./dockable";
import { setupFamilies, isFamilySystemReady } from "../modules/families";
import type { FamilyDefinition, FamilyType, FamilyService } from "../modules/families";

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
const refreshBtn = mkHeaderBtn("\u21BB", "Reload from storage", () => reloadAll());
const closeBtn = mkHeaderBtn("\u2715", "Close", () => hideFamilyBrowser());
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
searchInput.placeholder = "Search families, types, IFC entity\u2026";
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
    .map((c) => "<option value=\"" + c + "\">" + (c === "all" ? "All categories" : c) + "</option>")
    .join("");
  categoryFilter.value = categories.has(prevFilter) ? prevFilter : "all";
  categoryValue = categoryFilter.value;

  if (!selectedFamilyId && list.length) selectedFamilyId = list[0].id;

  const totalTypes = list.reduce((n, f) => n + f.types.length, 0);
  statusBar.textContent = list.length + " families \u00B7 " + totalTypes + " types \u00B7 obs.families.v1";
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
      icon.textContent = fam.builtIn ? "\u25CF" : "\u25CB";
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
          bullet.textContent = "\u25B8";
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

  // --- Preview (isometric SVG of the bounding box of the built geometry) ---
  const preview = document.createElement("div");
  preview.style.cssText =
    "background:#0b0d12;border:1px solid var(--border-subtle,#1e2029);border-radius:6px;" +
    "padding:8px;margin-bottom:10px;display:flex;align-items:center;justify-content:center;min-height:160px";
  try {
    const built = s.buildGeometry(fam.id, selectedTypeId, undefined);
    if (built) preview.appendChild(buildPreviewSvg(built));
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
    "<tr style=\"background:#12141b\">" +
    "<th style=\"text-align:left;padding:4px 6px;font-weight:600;color:#94a3b8\">Name</th>" +
    "<th style=\"text-align:left;padding:4px 6px;font-weight:600;color:#94a3b8\">Type</th>" +
    "<th style=\"text-align:left;padding:4px 6px;font-weight:600;color:#94a3b8\">Scope</th>" +
    "<th style=\"text-align:right;padding:4px 6px;font-weight:600;color:#94a3b8\">Value</th>" +
    "</tr>";
  pTable.appendChild(pHead);
  const pBody = document.createElement("tbody");
  const resolved = s.resolveParams(fam.id, selectedTypeId, undefined) ?? {};
  for (const p of fam.parameters) {
    const tr = document.createElement("tr");
    tr.style.cssText = "border-bottom:1px solid #1a1d24";
    const v = resolved[p.name];
    const formatted = formatParamValue(p, v);
    tr.innerHTML =
      "<td style=\"padding:4px 6px\">" + esc(p.name) + "</td>" +
      "<td style=\"padding:4px 6px;color:#94a3b8\">" + esc(p.type) + (p.unit ? " (" + esc(p.unit) + ")" : "") + "</td>" +
      "<td style=\"padding:4px 6px;color:#94a3b8\">" + esc(p.scope) + "</td>" +
      "<td style=\"padding:4px 6px;text-align:right;font-family:ui-monospace,monospace;color:#7dd3fc\">" + esc(formatted) + "</td>";
    pBody.appendChild(tr);
  }
  pTable.appendChild(pBody);
  detailPane.appendChild(pTable);

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

  // --- Footer actions -------------------------------------------------------
  const actions = document.createElement("div");
  actions.style.cssText =
    "display:flex;gap:6px;flex-wrap:wrap;padding-top:10px;border-top:1px solid #1e2029";
  const place = mkActionBtn("Place " + (selectedTypeId ? "this type" : "family"), () => onPlace(fam), true);
  const dup = mkActionBtn("Duplicate family", () => onDuplicate(fam), false);
  const del = mkActionBtn("Delete family", () => onDelete(fam), false);
  const exportBtn = mkActionBtn("Export JSON", () => onExport(fam), false);
  del.disabled = fam.builtIn;
  if (del.disabled) del.style.opacity = "0.45";

  actions.append(place, dup, del, exportBtn);
  detailPane.appendChild(actions);
}

function sectionLabel(text: string): HTMLElement {
  const h = document.createElement("div");
  h.textContent = text;
  h.style.cssText =
    "font:700 10px system-ui;letter-spacing:.5px;text-transform:uppercase;" +
    "color:#64748b;margin:8px 0 6px";
  return h;
}

function formatParamValue(p: any, v: any): string {
  if (v === undefined || v === null) return "\u2014";
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
function buildPreviewSvg(obj: THREE.Object3D): SVGSVGElement {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "200");
    svg.setAttribute("height", "150");
    return svg;
  }

  const w = 220, h = 160, pad = 20;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  const scale = (Math.min(w, h) - pad * 2) / (maxDim * 1.6);

  const c30 = Math.cos(Math.PI / 6);
  const s30 = Math.sin(Math.PI / 6);
  const project = (p: THREE.Vector3) => {
    const dx = p.x - center.x, dy = p.y - center.y, dz = p.z - center.z;
    return {
      x: (dx - dz) * c30 * scale + w / 2,
      y: ((dx + dz) * s30 - dy) * scale + h / 2,
    };
  };

  const min = box.min, max = box.max;
  const corners: THREE.Vector3[] = [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
    new THREE.Vector3(min.x, max.y, max.z),
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.style.cssText = "display:block";

  for (const [a, b] of edges) {
    const pa = project(corners[a]);
    const pb = project(corners[b]);
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

  // Dimensions annotation
  const dims = document.createElementNS(SVG_NS, "text");
  dims.setAttribute("x", String(w - 6));
  dims.setAttribute("y", String(h - 6));
  dims.setAttribute("text-anchor", "end");
  dims.setAttribute("font-family", "ui-monospace, monospace");
  dims.setAttribute("font-size", "9.5");
  dims.setAttribute("fill", "#64748b");
  dims.textContent =
    size.x.toFixed(2) + " \u00D7 " + size.y.toFixed(2) + " \u00D7 " + size.z.toFixed(2) + " m";
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
      auth.setAuthoringTool(sourceType);
      const t = selectedTypeId ? fam.types.find((x) => x.id === selectedTypeId) : null;
      toast("Place " + fam.name + (t ? " \u00B7 " + t.name : "") + " \u2014 click in the viewport", "success");
    } else {
      toast("Authoring not ready.", "warn");
    }
  } catch (err) {
    console.error("[family-browser] place failed", err);
  }
}

function onDuplicate(fam: FamilyDefinition): void {
  const s = svc();
  if (!s) return;
  const name = prompt("New family name:", fam.name + " Copy");
  if (!name) return;
  const clone = s.duplicate(fam.id, name.trim() || (fam.name + " Copy"));
  if (clone) {
    selectedFamilyId = clone.id;
    selectedTypeId = clone.types[0]?.id ?? null;
    toast("Family duplicated: " + clone.name, "success");
    reloadAll();
  }
}

function onDelete(fam: FamilyDefinition): void {
  const s = svc();
  if (!s) return;
  if (fam.builtIn) { toast("Built-in families cannot be deleted.", "warn"); return; }
  if (!confirm("Delete family \u201C" + fam.name + "\u201D and all its types?")) return;
  if (s.remove(fam.id)) {
    if (selectedFamilyId === fam.id) {
      selectedFamilyId = null;
      selectedTypeId = null;
    }
    toast("Family deleted.", "info");
    reloadAll();
  }
}

function onNewFamily(): void {
  const s = svc();
  if (!s) return;
  const src = selectedFamilyId ? s.get(selectedFamilyId) : s.list()[0];
  if (!src) { toast("No family to duplicate.", "warn"); return; }
  const name = prompt("New family name:", "New " + src.category);
  if (!name) return;
  const clone = s.duplicate(src.id, name.trim() || ("New " + src.category));
  if (clone) {
    selectedFamilyId = clone.id;
    selectedTypeId = clone.types[0]?.id ?? null;
    toast("Created family: " + clone.name, "success");
    reloadAll();
  }
}

function onAddType(fam: FamilyDefinition): void {
  const s = svc();
  if (!s) return;
  const name = prompt("New type name:", fam.name + " Type " + (fam.types.length + 1));
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

function onRemoveType(fam: FamilyDefinition): void {
  const s = svc();
  if (!s) return;
  if (!selectedTypeId) return;
  if (fam.types.length <= 1) { toast("A family must keep at least one type.", "warn"); return; }
  const t = fam.types.find((x) => x.id === selectedTypeId);
  if (!t) return;
  if (!confirm("Delete type \u201C" + t.name + "\u201D?")) return;
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
`;

// =============================================================================
// CREATE: the panel
// =============================================================================
const PANEL_REL = "src/features/family-browser.ts";
if (exists(PANEL_REL)) {
  const cur = read(PANEL_REL) || "";
  if (cur.indexOf(MARK) >= 0) log("NOOP", PANEL_REL + " (already present)");
  else log("WARN", PANEL_REL + " (exists without marker; leaving untouched)");
} else {
  write(PANEL_REL, TS_PANEL);
  log("CREATE", PANEL_REL);
}

// =============================================================================
// PATCH: main.ts -- add the setup call after families
// =============================================================================
function patchMain() {
  const rel = "src/main.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: s0, crlf } = readNorm(rel);
  let s = s0;
  let changed = false;

  if (s.indexOf("setupFamilyBrowser") < 0) {
    const importAnchor = 'import { setupFamilies } from "./modules/families";';
    if (s.indexOf(importAnchor) >= 0) {
      s = s.replace(
        importAnchor,
        importAnchor + '\nimport { setupFamilyBrowser } from "./features/family-browser";'
      );
      changed = true;
    } else {
      log("WARN", rel + " (families import anchor missing)");
      dumpContext(s, "setupFamilies", 3);
    }
  }

  if (s.indexOf('step("family-browser"') < 0) {
    const stepAnchor = 'await step("families", () => setupFamilies());';
    if (s.indexOf(stepAnchor) >= 0) {
      s = s.replace(
        stepAnchor,
        stepAnchor + '\nawait step("family-browser", () => setupFamilyBrowser());'
      );
      changed = true;
    } else {
      log("WARN", rel + " (families boot anchor missing)");
    }
  }

  if (changed) {
    backup(rel);
    writeNorm(rel, s, crlf);
    log("PATCH", rel + " (wired family-browser boot step)");
  } else {
    log("NOOP", rel + " (nothing to do)");
  }
}
patchMain();

// =============================================================================
// PATCH: command-palette.ts -- register the toggle command
// =============================================================================
function patchCommandPalette() {
  const rel = "src/features/command-palette.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: s0, crlf } = readNorm(rel);
  if (s0.indexOf("familyBrowser.toggle") >= 0) { log("NOOP", rel + " (command already registered)"); return; }

  // Find the "Panels" group block and append after it.
  const anchor = '  registerCommand({ id: "panel.savedViews", label: toggleLabel("Saved views", isSavedViewsPanelVisible), category: "Panels", run: () => toggleSavedViewsPanel() });';
  if (s0.indexOf(anchor) < 0) {
    log("WARN", rel + " (panels group anchor missing)");
    dumpContext(s0, "registerCommand", 2);
    return;
  }
  const addition = anchor +
    '\n  registerCommand({ id: "familyBrowser.toggle", label: "Toggle Family Browser", category: "Panels", kbd: "Ctrl+Shift+B", run: () => (window as any).__obsFamilyBrowser?.toggle?.() });' +
    '\n  registerCommand({ id: "familyBrowser.open", label: "Open Family Browser", category: "Panels", run: () => (window as any).__obsFamilyBrowser?.open?.() });' +
    '\n  registerCommand({ id: "familyBrowser.close", label: "Close Family Browser", category: "Panels", run: () => (window as any).__obsFamilyBrowser?.close?.() });';
  const s = s0.replace(anchor, addition);
  backup(rel);
  writeNorm(rel, s, crlf);
  log("PATCH", rel + " (registered family-browser commands)");
}
patchCommandPalette();

// =============================================================================
// PATCH: ui-items-register.ts -- add to User Interface menu
// =============================================================================
function patchUiRegistry() {
  const rel = "src/features/ui-items-register.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: s0, crlf } = readNorm(rel);
  if (s0.indexOf('id: "family-browser"') >= 0) { log("NOOP", rel + " (already registered)"); return; }

  const anchor = "  // \u00E2\u201D\u20AC\u00E2\u201D\u20AC Properties";
  const fallback = "// \u00E2\u201D\u20AC\u00E2\u201D\u20AC Properties";
  const useAnchor = s0.indexOf(anchor) >= 0 ? anchor : (s0.indexOf(fallback) >= 0 ? fallback : null);
  if (!useAnchor) {
    log("WARN", rel + " (anchor not found)");
    dumpContext(s0, "registerUiItem", 2);
    return;
  }
  const entry =
    useAnchor + "\n" +
    "  registerUiItem({\n" +
    '    id: "family-browser",\n' +
    '    label: "Family Browser",\n' +
    '    group: "panels",\n' +
    "    available: true,\n" +
    "    isVisible: () => {\n" +
    "      try { return !!F.familyBrowser?.isVisible?.(); } catch { return false; }\n" +
    "    },\n" +
    "    toggle: () => {\n" +
    "      try { F.familyBrowser?.toggle?.(); } catch { /* */ }\n" +
    "    },\n" +
    "  });\n";
  const s = s0.replace(useAnchor, entry);
  backup(rel);
  writeNorm(rel, s, crlf);
  log("PATCH", rel + " (registered family-browser in UI menu)");
}
patchUiRegistry();

// =============================================================================
// PATCH: verify-input-focus.mjs -- add [family-browser] group
// =============================================================================
function patchVerify() {
  const rel = "scripts/verify-input-focus.mjs";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: s0, crlf } = readNorm(rel);
  if (s0.indexOf(MARK) >= 0) { log("NOOP", rel + " (already extended)"); return; }

  const anchor = "const byGroup = {};";
  const idx = s0.indexOf(anchor);
  if (idx < 0) { log("WARN", rel + " (report anchor missing)"); return; }

  const block = [
    "// ---- " + MARK + " ----",
    'const fbSrc = read("src/features/family-browser.ts") || "";',
    'check("family-browser", "panel module exists", fbSrc.length > 0);',
    'check("family-browser", "exports setupFamilyBrowser", /export function setupFamilyBrowser/.test(fbSrc));',
    'check("family-browser", "exports toggleFamilyBrowser", /export function toggleFamilyBrowser/.test(fbSrc));',
    'check("family-browser", "has search input", /Search families/.test(fbSrc));',
    'check("family-browser", "has category filter", /Filter by category/.test(fbSrc));',
    'check("family-browser", "renders isometric preview", /buildPreviewSvg/.test(fbSrc));',
    'check("family-browser", "exposes Place action", /function onPlace/.test(fbSrc));',
    'check("family-browser", "exposes Duplicate action", /function onDuplicate/.test(fbSrc));',
    'check("family-browser", "exposes Delete action", /function onDelete/.test(fbSrc));',
    'check("family-browser", "exposes Add Type action", /function onAddType/.test(fbSrc));',
    'check("family-browser", "exposes Export JSON action", /function onExport/.test(fbSrc));',
    'check("family-browser", "binds Ctrl+Shift+B shortcut", /ctrlKey.*shiftKey.*key\\.toLowerCase\\(\\) === "b"/.test(fbSrc));',
    'const mainSrc2 = read("src/main.ts") || "";',
    'check("family-browser", "main.ts boots family-browser", /step\\("family-browser"/.test(mainSrc2));',
    'check("family-browser", "main.ts imports setupFamilyBrowser", /setupFamilyBrowser/.test(mainSrc2));',
    'const cpSrc = read("src/features/command-palette.ts") || "";',
    'check("family-browser", "command palette exposes familyBrowser.toggle", /familyBrowser\\.toggle/.test(cpSrc));',
    'const uiSrc = read("src/features/ui-items-register.ts") || "";',
    'check("family-browser", "UI registry entry present", /id:\\s*"family-browser"/.test(uiSrc));',
    "",
  ].join("\n");

  const s = s0.slice(0, idx) + block + s0.slice(idx);
  backup(rel);
  writeNorm(rel, s, crlf);
  log("PATCH", rel + " (added [family-browser] group)");
}
patchVerify();

// =============================================================================
console.log("");
console.log("Summary: " + stats.created + " created, " + stats.patched + " patched, " +
            stats.noop + " no-op, " + stats.skipped + " skipped, " + stats.warned + " warned.");
console.log("");