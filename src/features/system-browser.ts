/**
 * System Browser â€” MEP systems tree.
 *
 * Scans the loaded fragment models for MEP categories and groups them
 * into systems (Supply Air, Return Air, Domestic Cold Water, Sanitary,
 * Power, Lighting, Fire). Clicking a system selects all its elements.
 */

import { ctx } from "../core/context";
import { selection } from "./selection";
import { getElements } from "./authoring";

interface SystemDef {
  id: string;
  label: string;
  icon: string;
  color: string;
  categories: RegExp;
}

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

export function setupSystemBrowser(): void {
  panel = document.createElement("div");
  panel.id = "obs-system-browser";
  panel.style.cssText =
    "position:fixed;left:16px;top:200px;width:280px;max-height:60vh;z-index:33;" +
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
  refreshBtn.title = "Refresh";
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

async function renderTree(): Promise<void> {
  if (!listHost) return;
  listHost.innerHTML = "<div style='padding:16px;text-align:center;color:#6b7280'>Scanning models\u2026</div>";

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

  // Authored elements
  for (const el of getElements()) {
    const type = el.type;
    if (type === "duct" || type === "fitting") counts.set("supply-air", (counts.get("supply-air") ?? 0) + 1);
    else if (type === "pipe") counts.set("cold-water", (counts.get("cold-water") ?? 0) + 1);
    else if (type === "cable-tray" || type === "conduit") counts.set("power", (counts.get("power") ?? 0) + 1);
    else if (type === "equipment") counts.set("controls", (counts.get("controls") ?? 0) + 1);
  }

  listHost.innerHTML = "";
  let totalSystems = 0;
  let totalElements = 0;

  for (const sys of SYSTEMS) {
    const count = counts.get(sys.id) ?? 0;
    if (count === 0) continue;
    totalSystems++;
    totalElements += count;

    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:5px;" +
      "cursor:pointer;margin-bottom:2px;background:#0e1017;border:1px solid #2a2e3a";
    row.onmouseenter = () => { row.style.background = "#181a23"; };
    row.onmouseleave = () => { row.style.background = "#0e1017"; };

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
    row.onclick = () => void selectSystem(sys);

    listHost.appendChild(row);
  }

  if (!totalSystems) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:20px;text-align:center;color:#6b7280;font:11.5px system-ui;line-height:1.6";
    empty.innerHTML = "No MEP systems detected.<br>Load an IFC with ducts, pipes, or cable trays.";
    listHost.appendChild(empty);
    return;
  }

  const summary = document.createElement("div");
  summary.style.cssText =
    "padding:8px 10px;border-top:1px solid #2a2e3a;font:10.5px ui-monospace,monospace;" +
    "color:#6b7280;text-align:center";
  summary.textContent = totalSystems + " system(s) \u00B7 " + totalElements + " element(s)";
  listHost.appendChild(summary);
}

async function selectSystem(sys: SystemDef): Promise<void> {
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
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "No federated elements in " + sys.label, kind: "warn" },
    }));
    return;
  }
  selection.replace(map);
  await selection.applyToHighlighter();
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: { message: "Selected " + sys.label, kind: "success" },
  }));
}