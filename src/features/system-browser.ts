/**
 * System Browser — MEP systems tree, v2.
 *
 * v1 grouped elements by IFC category regex and showed counts: every duct
 * was "Supply Air" whether or not it touched anything, disconnected runs
 * looked like one system, and unconnected elements were invisible.
 *
 * v2 renders the REAL model tree for authored MEP elements:
 *   - every connected cluster is ONE named system (Supply Air 1, …),
 *     built from geometry-derived connectivity (mep/system-tree.ts)
 *   - equipment heads the member list; members expand and are individually
 *     selectable; clicking a system selects all of its members
 *   - isolated elements are flagged as unconnected, per system browser
 *     convention, instead of being silently folded into a category count
 *   - imported IFC files keep their category grouping, honestly labelled:
 *     connectivity is not re-derived for imported geometry.
 */

import { ctx } from "../core/context";
import { selection } from "./selection";
import { getElements, setSelectedAuthored } from "./authoring";
import { computeMepSystemTree } from "../modules/mep/system-tree";
import { colorFor } from "../modules/mep/types";
import type { MepLike } from "../modules/mep/connectivity";

interface SystemDef {
  id: string;
  label: string;
  icon: string;
  color: string;
  categories: RegExp;
}

/** Imported-IFC grouping (category based — see the honest section label). */
const SYSTEMS: SystemDef[] = [
  { id: "supply-air",     label: "Supply Air",           icon: "\u2191", color: "#38bdf8", categories: /^IFC(DuctSegment|DuctFitting|AirTerminal|AirTerminalBox)/i },
  { id: "return-air",     label: "Return Air",           icon: "\u21BB", color: "#22d3ee", categories: /^IFC(DuctSegment|DuctFitting|AirTerminal)/i },
  { id: "exhaust-air",    label: "Exhaust Air",          icon: "\u2193", color: "#06b6d4", categories: /^IFC(DuctSegment|DuctFitting)/i },
  { id: "cold-water",     label: "Domestic Cold Water",  icon: "\u25CF", color: "#3b82f6", categories: /^IFC(PipeSegment|PipeFitting|Valve|Pump)/i },
  { id: "hot-water",      label: "Domestic Hot Water",   icon: "\u25CF", color: "#ef4444", categories: /^IFC(PipeSegment|PipeFitting|Valve)/i },
  { id: "sanitary",       label: "Sanitary / Drainage",  icon: "\u25C6", color: "#22c55e", categories: /^IFC(PipeSegment|PipeFitting|SanitaryTerminal)/i },
  { id: "power",          label: "Power",                icon: "\u26A1", color: "#f59e0b", categories: /^IFC(CableCarrier|CableSegment|Electric)/i },
  { id: "lighting",       label: "Lighting",             icon: "\u2600", color: "#fbbf24", categories: /^IFC(LightFixture|LightingDevice)/i },
  { id: "fire",           label: "Fire Protection",      icon: "\u{1F525}", color: "#dc2626", categories: /^IFC(FireSuppression|Sprinkler)/i },
  { id: "controls",       label: "Controls & Sensors",   icon: "\u25CB", color: "#a855f7", categories: /^IFC(Sensor|Controller|Alarm|Actuator)/i },
];

let panel: HTMLDivElement | null = null;
let listHost: HTMLDivElement | null = null;
let visible = false;
const expanded = new Set<string>();

export function setupSystemBrowser(): void {
  panel = document.createElement("div");
  panel.id = "obs-system-browser";
  panel.style.cssText =
    "position:fixed;left:16px;top:200px;width:300px;max-height:62vh;z-index:33;" +
    "display:none;flex-direction:column;background:#1a1d27;color:#e8eaf0;" +
    "border:1px solid #2a2e3a;border-radius:10px;" +
    "box-shadow:0 12px 36px rgba(0,0,0,.5);font:12px system-ui,sans-serif;overflow:hidden";
  panel.onmousedown = (e) => e.stopPropagation();

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:9px 10px;" +
    "border-bottom:1px solid #2a2e3a;background:#12141b;flex-shrink:0";
  header.innerHTML = "<div style='font-weight:700;flex:1'>\u2637 System Browser</div>";

  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "\u21BB";
  refreshBtn.title = "Rebuild the tree from the current model";
  refreshBtn.style.cssText =
    "padding:2px 8px;background:transparent;color:#94a3b8;" +
    "border:1px solid #2a2e3a;border-radius:4px;cursor:pointer;font-size:12px";
  refreshBtn.onclick = () => renderTree();
  header.appendChild(refreshBtn);

  listHost = document.createElement("div");
  listHost.style.cssText = "flex:1;overflow-y:auto;padding:4px";

  panel.append(header, listHost);
  ctx.rightHost.appendChild(panel);

  (ctx.features as any).systemBrowser = {
    show: () => { visible = true; if (panel) panel.style.display = "flex"; renderTree(); },
    hide: () => { visible = false; if (panel) panel.style.display = "none"; },
    toggle: () => { visible ? (ctx.features as any).systemBrowser.hide() : (ctx.features as any).systemBrowser.show(); },
    isVisible: () => visible,
    refresh: renderTree,
  };
}

function toast(message: string, kind: "success" | "warn"): void {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
}

function sectionTitle(text: string, subtitle: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "padding:7px 6px 3px";
  const t = document.createElement("div");
  t.textContent = text;
  t.style.cssText = "font-weight:700;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#7dd3fc";
  const s = document.createElement("div");
  s.textContent = subtitle;
  s.style.cssText = "font-size:10px;color:#6b7280;margin-top:1px";
  wrap.append(t, s);
  return wrap;
}

function rowBase(): HTMLDivElement {
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:5px;" +
    "cursor:pointer;margin-bottom:2px;background:#0e1017;border:1px solid #2a2e3a";
  row.onmouseenter = () => { row.style.background = "#181a23"; };
  row.onmouseleave = () => { row.style.background = "#0e1017"; };
  return row;
}

/** Authored model: real systems from connectivity. */
function renderAuthoredSection(host: HTMLDivElement): { systems: number; elements: number; unconnected: number; conflicts: number } {
  const els = getElements() as unknown as MepLike[];
  const tree = computeMepSystemTree(els);
  if (!tree.totalMep) return { systems: 0, elements: 0, unconnected: 0, conflicts: 0 };

  host.appendChild(sectionTitle(
    "Model systems",
    "built from real connectivity \u00B7 click a system to select it",
  ));

  for (const c of tree.clusters) {
    const row = rowBase();
    const conflict = c.conflicts.length > 0;
    const dot = document.createElement("span");
    dot.textContent = conflict ? "\u26A0" : "\u25CF";
    dot.style.cssText = "color:" + (conflict ? "#ef4444" : c.system ? colorFor(c.system) : "#6b7280") + ";font-size:14px;flex-shrink:0";
    const label = document.createElement("span");
    label.textContent = c.label + (conflict ? " \u2014 " + c.conflicts.map((s) => s).join(" vs ") : c.unconnected ? " \u2014 not connected" : "");
    label.style.cssText = "flex:1;font-weight:600;font-size:11.5px" + (conflict ? ";color:#fca5a5" : c.unconnected ? ";color:#fbbf24" : "");
    const badge = document.createElement("span");
    badge.textContent = String(c.memberIds.length);
    badge.style.cssText =
      "font:600 10px ui-monospace,monospace;color:#94a3b8;background:#1a1d27;" +
      "padding:2px 7px;border-radius:10px;flex-shrink:0";
    const chev = document.createElement("span");
    chev.textContent = expanded.has(c.id) ? "\u25BE" : "\u25B8";
    chev.style.cssText = "color:#6b7280;font-size:10px;flex-shrink:0";
    row.append(dot, label, badge, chev);
    row.onclick = () => {
      setSelectedAuthored(c.memberIds);
      toast("Selected " + c.memberIds.length + " element(s) in " + c.label, "success");
    };
    host.appendChild(row);

    // A rejected mixed-system cluster explains itself under its row.
    if (conflict) {
      for (const d of c.diagnostics) {
        const drow = document.createElement("div");
        drow.textContent = d;
        drow.style.cssText = "padding:2px 9px 6px 27px;font-size:10.5px;color:#fca5a5;line-height:1.5";
        host.appendChild(drow);
      }
    }

    if (expanded.has(c.id)) {
      for (const id of c.memberIds) {
        const el = els.find((e) => e.id === id);
        const mrow = rowBase();
        mrow.style.marginLeft = "18px";
        mrow.style.padding = "4px 9px";
        const mlabel = document.createElement("span");
        mlabel.textContent = (el?.type ?? "?") + " \u00B7 " + id;
        mlabel.style.cssText = "flex:1;font-size:10.5px;color:#cbd5e1";
        mrow.appendChild(mlabel);
        mrow.onclick = (ev) => {
          ev.stopPropagation();
          setSelectedAuthored([id]);
          toast("Selected " + id, "success");
        };
        host.appendChild(mrow);
      }
    }

    chev.onclick = (ev) => {
      ev.stopPropagation();
      if (expanded.has(c.id)) expanded.delete(c.id);
      else expanded.add(c.id);
      renderTree();
    };
  }
  return { systems: tree.clusters.length, elements: tree.totalMep, unconnected: tree.unconnectedCount, conflicts: tree.conflictCount };
}

/** Imported IFC: category groups (honest label — connectivity not re-derived). */
async function renderImportedSection(host: HTMLDivElement): Promise<{ groups: number; elements: number }> {
  const counts = new Map<string, number>();
  for (const s of SYSTEMS) counts.set(s.id, 0);
  for (const [, model] of ctx.fragments.list) {
    try {
      const cats = await (model as any).getItemsOfCategories([/.+/]);
      for (const [cat, ids] of Object.entries(cats ?? {})) {
        const upper = String(cat).toUpperCase();
        for (const sys of SYSTEMS) {
          if (sys.categories.test(upper)) {
            counts.set(sys.id, (counts.get(sys.id) ?? 0) + ((ids as number[]) ?? []).length);
            break;
          }
        }
      }
    } catch { /* */ }
  }
  const groups = SYSTEMS.filter((s) => (counts.get(s.id) ?? 0) > 0);
  if (!groups.length) return { groups: 0, elements: 0 };

  host.appendChild(sectionTitle(
    "Imported (IFC)",
    "grouped by IFC category \u2014 connectivity is not re-derived for imported files",
  ));
  for (const sys of groups) {
    const count = counts.get(sys.id) ?? 0;
    const row = rowBase();
    const dot = document.createElement("span");
    dot.textContent = "\u25CF";
    dot.style.cssText = "color:" + sys.color + ";font-size:14px;flex-shrink:0";
    const icon = document.createElement("span");
    icon.textContent = sys.icon;
    icon.style.cssText = "font-size:12px;opacity:.7;flex-shrink:0";
    const label = document.createElement("span");
    label.textContent = sys.label;
    label.style.cssText = "flex:1;font-weight:600;font-size:11.5px";
    const badge = document.createElement("span");
    badge.textContent = String(count);
    badge.style.cssText =
      "font:600 10px ui-monospace,monospace;color:#94a3b8;background:#1a1d27;" +
      "padding:2px 7px;border-radius:10px;flex-shrink:0";
    row.append(dot, icon, label, badge);
    row.onclick = () => void selectImportedGroup(sys);
    host.appendChild(row);
  }
  return { groups: groups.length, elements: groups.reduce((a, s) => a + (counts.get(s.id) ?? 0), 0) };
}

async function renderTree(): Promise<void> {
  if (!listHost) return;
  listHost.innerHTML = "";

  const authored = renderAuthoredSection(listHost);
  const imported = await renderImportedSection(listHost);

  if (!authored.systems && !imported.groups) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:20px;text-align:center;color:#6b7280;font:11.5px system-ui;line-height:1.6";
    empty.innerHTML =
      "No MEP systems detected.<br>" +
      "Draw ducts, pipes, cable trays or conduit with the MEP tools,<br>" +
      "or load an IFC with MEP elements.";
    listHost.appendChild(empty);
    return;
  }

  const summary = document.createElement("div");
  summary.style.cssText =
    "padding:8px 10px;border-top:1px solid #2a2e3a;font:10.5px ui-monospace,monospace;" +
    "color:#6b7280;text-align:center";
  const parts: string[] = [];
  if (authored.systems) {
    parts.push(authored.systems + " model system(s) \u00B7 " + authored.elements + " element(s)");
    if (authored.unconnected) parts.push(authored.unconnected + " unconnected");
    if (authored.conflicts) parts.push(authored.conflicts + " system conflict(s) \u2014 resolve before audit");
  }
  if (imported.groups) parts.push(imported.groups + " imported group(s) \u00B7 " + imported.elements + " element(s)");
  summary.textContent = parts.join("  \u00B7  ");
  listHost.appendChild(summary);
}

async function selectImportedGroup(sys: SystemDef): Promise<void> {
  const map: Record<string, Set<number>> = {};
  for (const [modelId, model] of ctx.fragments.list) {
    try {
      const cats = await (model as any).getItemsOfCategories([/.+/]);
      for (const [cat, ids] of Object.entries(cats ?? {})) {
        if (sys.categories.test(String(cat).toUpperCase())) {
          if (!map[modelId]) map[modelId] = new Set();
          for (const id of (ids as number[]) ?? []) map[modelId].add(id);
        }
      }
    } catch { /* */ }
  }
  if (!Object.keys(map).length) {
    toast("No federated elements in " + sys.label, "warn");
    return;
  }
  selection.replace(map);
  await selection.applyToHighlighter();
  toast("Selected " + sys.label, "success");
}
