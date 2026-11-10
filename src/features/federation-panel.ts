/**
 * Federation panel — the missing UI for modules/federation/manager.ts.
 *
 * The FederationManager (discipline tagging, per-model color/opacity/
 * visibility/priority/transform, isolate, align-to-model) was fully
 * implemented but reachable from no panel: the palette "Toggle Federation"
 * command looked up `ctx.features.federationPanel`, which nothing ever
 * registered, so users always got "Federation panel is not loaded yet".
 *
 * This panel registers that exact key. Multi-model federation is a real
 * workflow (ARC + STR + MEP files combined on one shared coordinate), so
 * the panel exposes the manager's live state via federation.list() and
 * re-renders on its onChange event.
 */
import { ctx } from "../core/context";
import { federation } from "../modules/federation/manager";
import { DISCIPLINES, DISCIPLINE_LABELS, type Discipline } from "../modules/federation/types";
import { makeDockable, type DockHandle } from "./dockable";
import { notify } from "../core/notify";

type Any = Record<string, any>;

const panel = document.createElement("div");
panel.id = "obs-federation-panel";
panel.style.cssText =
  "display:none;flex-direction:column;z-index:58;background:var(--bg-floating,#1c1e28);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
  "box-shadow:0 16px 50px rgba(0,0,0,.5);color:var(--text-primary,#e8eaf0);" +
  "font:12px system-ui,sans-serif;overflow:hidden";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid var(--border-subtle);" +
  "background:var(--bg-elevated);cursor:move;user-select:none";
const title = document.createElement("div");
title.style.cssText = "font-weight:700;flex:1;letter-spacing:.1px";
title.textContent = "Federation";
header.appendChild(title);

const body = document.createElement("div");
body.style.cssText = "overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px";
panel.append(header, body);

const INP = "width:100%;box-sizing:border-box;padding:5px 7px;border-radius:6px;border:1px solid #2a2e3a;background:#232633;color:#e8eaf0;font-size:12px";
const MINI = "padding:4px 7px;border-radius:6px;border:1px solid #2a2e3a;background:#232633;color:#e8eaf0;cursor:pointer;font-size:11px";

let dock: DockHandle | null = null;

function strategySelect(): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.style.cssText = INP + ";flex:1";
  for (const [v, label] of [
    ["discipline", "Color by discipline"],
    ["model", "Color by model"],
    ["neutral", "Neutral colors"],
  ] as Array<[string, string]>) {
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = String((federation as Any).strategy ?? "discipline");
  sel.onchange = () => { federation.setStrategy(sel.value as "discipline" | "model" | "neutral"); };
  return sel;
}

function entryRow(e: Any, list: HTMLDivElement): void {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-direction:column;gap:5px;padding:8px;border:1px solid #2a2e3a;border-radius:8px;background:#1b1e28";

  const top = document.createElement("div");
  top.style.cssText = "display:flex;align-items:center;gap:7px";
  const dot = document.createElement("span");
  dot.style.cssText = `width:9px;height:9px;border-radius:50%;flex:none;background:${e.color ?? "#6b7280"};opacity:${e.visible === false ? 0.3 : 1}`;
  const name = document.createElement("div");
  name.style.cssText = "flex:1;min-width:0;font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  name.textContent = e.name ?? e.modelId;
  const visBtn = document.createElement("button");
  visBtn.textContent = e.visible === false ? "Show" : "Hide";
  visBtn.style.cssText = MINI;
  visBtn.onclick = () => { federation.setVisible(e.modelId, e.visible === false); rerender(list); };
  top.append(dot, name, visBtn);

  const mid = document.createElement("div");
  mid.style.cssText = "display:flex;gap:5px;align-items:center";
  const disc = document.createElement("select");
  disc.style.cssText = INP + ";flex:1";
  for (const d of DISCIPLINES) {
    const o = document.createElement("option");
    o.value = d; o.textContent = DISCIPLINE_LABELS[d];
    disc.appendChild(o);
  }
  disc.value = e.discipline ?? "OTHER";
  disc.onchange = () => { federation.setDiscipline(e.modelId, disc.value as Discipline); rerender(list); };
  const prio = document.createElement("input");
  prio.type = "number"; prio.step = "1";
  prio.title = "Render priority — higher draws on top";
  prio.style.cssText = INP + ";width:58px;flex:none";
  prio.value = String(e.priority ?? 0);
  prio.onchange = () => { federation.setPriority(e.modelId, Number(prio.value) || 0); };
  mid.append(disc, prio);

  const bottom = document.createElement("div");
  bottom.style.cssText = "display:flex;gap:5px;align-items:center";
  const color = document.createElement("input");
  color.type = "color";
  color.title = "Override display color";
  color.style.cssText = "width:32px;height:26px;padding:0;border:1px solid #2a2e3a;border-radius:6px;background:#232633;cursor:pointer;flex:none";
  color.value = e.color ?? "#6b7280";
  color.onchange = () => { federation.setColor(e.modelId, color.value); rerender(list); };
  const opacity = document.createElement("input");
  opacity.type = "range"; opacity.min = "0"; opacity.max = "1"; opacity.step = "0.05";
  opacity.title = "Transparency";
  opacity.style.cssText = "flex:1";
  opacity.value = String(e.opacity ?? 0);
  opacity.onchange = () => { federation.setOpacity(e.modelId, Number(opacity.value)); };
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset move";
  resetBtn.title = "Remove this model's shared-coordinate transform override";
  resetBtn.style.cssText = MINI;
  resetBtn.onclick = () => { federation.resetTransform(e.modelId); notify("info", `Transform reset for ${e.name ?? e.modelId}`); };
  bottom.append(color, opacity, resetBtn);

  row.append(top, mid, bottom);
  list.appendChild(row);
}

function rerender(list: HTMLDivElement): void {
  list.innerHTML = "";
  const entries = federation.list();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:16px 10px;text-align:center;color:#8b93a7;font-size:12px;line-height:1.6";
    empty.innerHTML = "No models federated yet.<br>Insert another IFC/DWG model and it appears here with a guessed discipline (ARC / STR / MEP-M / …).";
    list.appendChild(empty);
    return;
  }
  for (const e of entries) entryRow(e as Any, list);
}

function buildBody(): void {
  body.innerHTML = "";
  const hint = document.createElement("div");
  hint.style.cssText = "font-size:11px;color:#8b93a7;line-height:1.5";
  hint.textContent = "Multi-model federation: every inserted model keeps its own discipline color, visibility, transparency and shared-coordinate transform.";
  const stratRow = document.createElement("div");
  stratRow.style.cssText = "display:flex;gap:6px;align-items:center";
  stratRow.appendChild(strategySelect());
  const isolateBtn = document.createElement("button");
  isolateBtn.textContent = "Isolate selected";
  isolateBtn.title = "Show only the currently selected model(s) (uses selection's model ids)";
  isolateBtn.style.cssText = MINI;
  isolateBtn.onclick = () => {
    const f = (ctx as Any).features ?? {};
    const ids: string[] = [];
    try {
      const a = f.authoring;
      const sel = typeof a?.getSelectedIds === "function" ? a.getSelectedIds() : [];
      for (const id of sel ?? []) {
        const el = (typeof a?.getElementById === "function" ? a.getElementById(id) : null) as Any;
        const mid = String(el?.properties?.modelId ?? el?.modelId ?? "");
        if (mid) ids.push(mid);
      }
    } catch { /* */ }
    if (!ids.length) { notify("warn", "Isolate: select an element that belongs to an inserted model first."); return; }
    federation.isolate(ids);
    rerender(list);
    notify("info", `Isolated ${ids.length} model(s) — use Show all to reset`);
  };
  const showAllBtn = document.createElement("button");
  showAllBtn.textContent = "Show all";
  showAllBtn.style.cssText = MINI;
  showAllBtn.onclick = () => { federation.clearIsolation(); rerender(list); };
  stratRow.append(isolateBtn, showAllBtn);
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:7px";
  body.append(hint, stratRow, list);
  rerender(list);
  try { federation.onChange(() => rerender(list)); } catch { /* */ }
}

export function setupFederationPanel(): void {
  const f = (ctx as Any).features ?? ((ctx as Any).features = {});
  if (f.federationPanel) return;
  try {
    federation.init();
  } catch { /* fragments runtime may not be ready; the panel still renders state */ }
  buildBody();
  dock = makeDockable(panel, {
    id: "federation-panel",
    host: (ctx as Any).rightHost,
    header,
    minWidth: 300,
    minHeight: 260,
    defaultDock: "right",
    defaultWidth: 330,
    defaultHeight: 420,
  });
  f.federationPanel = {
    toggle: () => dock?.toggle(),
    open: () => dock?.show(),
    close: () => dock?.hide(),
    isVisible: () => !!dock?.isVisible(),
  };
  console.log("[federation-panel] ready — palette commands and Insert ▸ Federation now work");
}
