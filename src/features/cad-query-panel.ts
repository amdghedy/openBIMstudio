/**
 * Drawing Query panel — filter linked DXF/DWG entities by layer, type, name, colour, linetype.
 * Actions: isolate matching layers, zoom to results, show/hide layers.
 */
import { ctx } from "../core/context";
import {
  listCadLinks,
  getCadLink,
  setCadLayerVisible,
  setCadLinkVisible,
  zoomToCadLink,
  onCadLinksChanged,
  type CadLink,
} from "../modules/cad-link";
import {
  queryCadLinks,
  listEntityTypesInLinks,
  listLayersInLinks,
  layersFromHits,
  type CadQueryFilter,
  type CadQueryHit,
} from "../modules/cad-link/query";

let panel: HTMLDivElement | null = null;
let unsub: (() => void) | null = null;
let lastHits: CadQueryHit[] = [];

const CSS = {
  panel:
    "position:fixed;top:100px;right:18px;width:min(420px,calc(100vw - 32px));max-height:min(70vh,640px);" +
    "z-index:240;display:flex;flex-direction:column;background:#1b1c26;border:1px solid #34353f;" +
    "border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.55);color:#e2e8f0;font:12.5px system-ui,sans-serif;overflow:hidden",
  head:
    "display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2a2e3a;" +
    "background:linear-gradient(180deg,#22242e,#1b1c26);cursor:move;user-select:none",
  body: "padding:10px 12px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:8px",
  row: "display:flex;flex-direction:column;gap:3px",
  label: "font:700 10px system-ui;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px",
  input:
    "width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid #3a3f4d;" +
    "background:#12141c;color:#e8eaf0;font:12.5px system-ui",
  btn:
    "padding:6px 10px;border-radius:6px;border:1px solid #3a3f4d;background:#2a2e3a;color:#e8eaf0;" +
    "cursor:pointer;font:600 12px system-ui",
  btnPrimary:
    "padding:6px 10px;border-radius:6px;border:1px solid #0284c7;background:#0369a1;color:#fff;" +
    "cursor:pointer;font:600 12px system-ui",
  tableWrap: "overflow:auto;max-height:280px;border:1px solid #2a2e3a;border-radius:6px",
  table: "width:100%;border-collapse:collapse;font:11.5px ui-monospace,monospace",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css?: string, html?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (html != null) n.innerHTML = html;
  return n;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const row = el("div", CSS.row);
  row.append(el("div", CSS.label, label), control);
  return row;
}

function collectFilter(root: HTMLElement): CadQueryFilter {
  const g = (id: string) => root.querySelector(`#${id}`) as HTMLInputElement | HTMLSelectElement | null;
  const colorRaw = (g("cq-color") as HTMLInputElement)?.value?.trim();
  const color = colorRaw === "" || colorRaw == null ? null : Number(colorRaw);
  return {
    linkId: (g("cq-link") as HTMLSelectElement)?.value || null,
    layer: (g("cq-layer") as HTMLSelectElement)?.value || "",
    layerContains: (g("cq-layer-sub") as HTMLInputElement)?.value || "",
    entityType: (g("cq-type") as HTMLSelectElement)?.value || "",
    nameContains: (g("cq-name") as HTMLInputElement)?.value || "",
    color: Number.isFinite(color as number) ? (color as number) : null,
    lineTypeContains: (g("cq-ltype") as HTMLInputElement)?.value || "",
    visibleLayersOnly: !!(g("cq-vis") as HTMLInputElement)?.checked,
  };
}

function renderHits(tbody: HTMLElement, hits: CadQueryHit[], status: HTMLElement) {
  tbody.innerHTML = "";
  lastHits = hits;
  status.textContent = `${hits.length} entit${hits.length === 1 ? "y" : "ies"}`;
  const max = 500;
  const slice = hits.slice(0, max);
  for (const h of slice) {
    const tr = document.createElement("tr");
    tr.style.cssText = "border-bottom:1px solid #252833";
    tr.innerHTML =
      `<td style="padding:4px 6px;color:#93c5fd;max-width:90px;overflow:hidden;text-overflow:ellipsis" title="${esc(h.linkName)}">${esc(h.linkName)}</td>` +
      `<td style="padding:4px 6px;color:#fbbf24">${esc(h.layer)}</td>` +
      `<td style="padding:4px 6px;color:#a5b4fc">${esc(h.entityType)}</td>` +
      `<td style="padding:4px 6px;color:#e2e8f0;max-width:140px;overflow:hidden;text-overflow:ellipsis" title="${esc(h.name)}">${esc(h.name)}</td>`;
    tr.title = [
      h.linkName,
      `Layer: ${h.layer}`,
      `Type: ${h.entityType}`,
      h.name,
      h.color != null ? `ACI ${h.color}` : "",
      h.lineType ? `Linetype ${h.lineType}` : "",
      h.world ? `World ${h.world.x.toFixed(2)}, ${h.world.y.toFixed(2)}, ${h.world.z.toFixed(2)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    tbody.appendChild(tr);
  }
  if (hits.length > max) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" style="padding:6px;color:#94a3b8">… and ${hits.length - max} more</td>`;
    tbody.appendChild(tr);
  }
}

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c],
  );
}

function toast(msg: string, kind: "info" | "warn" | "success" | "error" = "info") {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: msg, kind } }));
  } catch {
    console.log("[cad-query]", msg);
  }
}

function isolateHits(hits: CadQueryHit[], onlyMatching: boolean) {
  const byLink = layersFromHits(hits);
  if (!byLink.size) {
    toast("No matching layers to isolate", "warn");
    return;
  }
  for (const link of listCadLinks()) {
    const match = byLink.get(link.id);
    if (!match) {
      if (onlyMatching) setCadLinkVisible(link.id, false);
      continue;
    }
    setCadLinkVisible(link.id, true);
    const allLayers = new Set([
      ...link.doc.layers.map((l) => l.name),
      ...link.doc.entities.map((e) => e.layer),
    ]);
    for (const name of allLayers) {
      setCadLayerVisible(link.id, name, match.has(name));
    }
  }
  toast(`Isolated ${[...byLink.values()].reduce((n, s) => n + s.size, 0)} layer(s) from query`, "success");
}

function showAllLayers() {
  for (const link of listCadLinks()) {
    setCadLinkVisible(link.id, true);
    const allLayers = new Set([
      ...link.doc.layers.map((l) => l.name),
      ...link.doc.entities.map((e) => e.layer),
    ]);
    for (const name of allLayers) setCadLayerVisible(link.id, name, true);
  }
  toast("All drawing layers visible", "info");
}

async function zoomToHits(hits: CadQueryHit[]) {
  const withWorld = hits.filter((h) => h.world);
  if (!withWorld.length) {
    const first = hits[0];
    if (first) await zoomToCadLink(first.linkId);
    else toast("Nothing to zoom to", "warn");
    return;
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const h of withWorld) {
    const w = h.world!;
    minX = Math.min(minX, w.x); maxX = Math.max(maxX, w.x);
    minY = Math.min(minY, w.y); maxY = Math.max(maxY, w.y);
    minZ = Math.min(minZ, w.z); maxZ = Math.max(maxZ, w.z);
  }
  const pad = 2;
  try {
    const controls: any = ctx.world.camera.controls;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2 + 1.5;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ, maxY - minY, 4) + pad;
    const dist = span * 1.4;
    if (controls?.setLookAt) {
      controls.setLookAt(cx + dist * 0.6, cy + dist * 0.5, cz + dist * 0.6, cx, cy, cz, true);
    }
    toast(`Zoomed to ${withWorld.length} result(s)`, "success");
  } catch (e) {
    console.warn("[cad-query] zoom failed", e);
    toast("Zoom failed", "error");
  }
}

function fillSelects(root: HTMLElement) {
  const links = listCadLinks();
  const linkSel = root.querySelector("#cq-link") as HTMLSelectElement;
  const layerSel = root.querySelector("#cq-layer") as HTMLSelectElement;
  const typeSel = root.querySelector("#cq-type") as HTMLSelectElement;
  if (!linkSel || !layerSel || !typeSel) return;

  const prevLink = linkSel.value;
  const prevLayer = layerSel.value;
  const prevType = typeSel.value;

  linkSel.innerHTML = `<option value="">All linked drawings</option>`;
  for (const l of links) {
    const o = document.createElement("option");
    o.value = l.id;
    o.textContent = `${l.name} (${l.format.toUpperCase()}, ${l.doc.entities.length} ents)`;
    linkSel.appendChild(o);
  }
  if ([...linkSel.options].some((o) => o.value === prevLink)) linkSel.value = prevLink;

  const layerLink = linkSel.value || null;
  layerSel.innerHTML = `<option value="">Any layer</option>`;
  for (const name of listLayersInLinks(links, layerLink)) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = name;
    layerSel.appendChild(o);
  }
  if ([...layerSel.options].some((o) => o.value === prevLayer)) layerSel.value = prevLayer;

  typeSel.innerHTML = `<option value="">Any type</option>`;
  for (const ty of listEntityTypesInLinks(links)) {
    const o = document.createElement("option");
    o.value = ty;
    o.textContent = ty;
    typeSel.appendChild(o);
  }
  if ([...typeSel.options].some((o) => o.value === prevType)) typeSel.value = prevType;
}

function buildPanel(): HTMLDivElement {
  const root = el("div", CSS.panel);
  root.id = "obs-cad-query-panel";

  const head = el("div", CSS.head);
  head.innerHTML =
    `<span style="font-weight:700;flex:1">Drawing Query</span>` +
    `<span style="opacity:.55;font-size:11px">layer · type · name</span>`;
  const close = el("button", CSS.btn, "✕");
  close.onclick = () => hideCadQueryPanel();
  head.appendChild(close);
  root.appendChild(head);

  // drag
  let drag: { x: number; y: number; l: number; t: number } | null = null;
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    drag = { x: e.clientX, y: e.clientY, l: root.offsetLeft, t: root.offsetTop };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    root.style.left = `${drag.l + e.clientX - drag.x}px`;
    root.style.top = `${drag.t + e.clientY - drag.y}px`;
    root.style.right = "auto";
  });
  head.addEventListener("pointerup", () => { drag = null; });

  const body = el("div", CSS.body);

  const linkSel = el("select", CSS.input);
  linkSel.id = "cq-link";
  const layerSel = el("select", CSS.input);
  layerSel.id = "cq-layer";
  const layerSub = el("input", CSS.input) as HTMLInputElement;
  layerSub.id = "cq-layer-sub";
  layerSub.placeholder = "Layer contains…";
  const typeSel = el("select", CSS.input);
  typeSel.id = "cq-type";
  const nameIn = el("input", CSS.input) as HTMLInputElement;
  nameIn.id = "cq-name";
  nameIn.placeholder = "Text / name contains…";
  const colorIn = el("input", CSS.input) as HTMLInputElement;
  colorIn.id = "cq-color";
  colorIn.type = "number";
  colorIn.placeholder = "ACI colour (optional)";
  const ltypeIn = el("input", CSS.input) as HTMLInputElement;
  ltypeIn.id = "cq-ltype";
  ltypeIn.placeholder = "Linetype contains…";
  const vis = el("label", "display:flex;align-items:center;gap:6px;color:#cbd5e1;font:12px system-ui");
  const visCb = el("input") as HTMLInputElement;
  visCb.type = "checkbox";
  visCb.id = "cq-vis";
  vis.append(visCb, document.createTextNode(" Only currently visible layers"));

  body.append(
    field("Drawing file", linkSel),
    field("Layer", layerSel),
    field("Layer contains", layerSub),
    field("Element type", typeSel),
    field("Element name / text", nameIn),
    field("Colour (ACI)", colorIn),
    field("Linetype", ltypeIn),
    vis,
  );

  const actions = el("div", "display:flex;flex-wrap:wrap;gap:6px");
  const runBtn = el("button", CSS.btnPrimary, "Run query");
  const isolateBtn = el("button", CSS.btn, "Isolate layers");
  const zoomBtn = el("button", CSS.btn, "Zoom results");
  const resetBtn = el("button", CSS.btn, "Show all layers");
  actions.append(runBtn, isolateBtn, zoomBtn, resetBtn);
  body.appendChild(actions);

  const status = el("div", "color:#94a3b8;font:11.5px system-ui", "Link a drawing, then run a query.");
  body.appendChild(status);

  const tableWrap = el("div", CSS.tableWrap);
  const table = el("table", CSS.table);
  table.innerHTML =
    `<thead><tr style="background:#22242e;color:#94a3b8;text-align:left">` +
    `<th style="padding:5px 6px">File</th><th style="padding:5px 6px">Layer</th>` +
    `<th style="padding:5px 6px">Type</th><th style="padding:5px 6px">Name</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  body.appendChild(tableWrap);

  root.appendChild(body);

  const run = () => {
    const links = listCadLinks();
    if (!links.length) {
      toast("No linked drawings — Insert → Link drawing", "warn");
      status.textContent = "No linked drawings";
      tbody.innerHTML = "";
      return;
    }
    const hits = queryCadLinks(links, collectFilter(root));
    renderHits(tbody, hits, status);
  };

  runBtn.onclick = run;
  nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  layerSub.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  linkSel.addEventListener("change", () => fillSelects(root));
  isolateBtn.onclick = () => isolateHits(lastHits, true);
  zoomBtn.onclick = () => void zoomToHits(lastHits);
  resetBtn.onclick = () => showAllLayers();

  fillSelects(root);
  return root;
}

export function isCadQueryPanelOpen(): boolean {
  return !!(panel && panel.style.display !== "none" && document.body.contains(panel));
}

export function showCadQueryPanel(): void {
  try {
    void import("../modules/cad-link").then((m) => m.setupCadLinks());
  } catch { /* */ }

  if (!panel) {
    panel = buildPanel();
    document.body.appendChild(panel);
  } else {
    fillSelects(panel);
    panel.style.display = "flex";
  }

  if (!unsub) {
    try {
      unsub = onCadLinksChanged(() => {
        if (panel && isCadQueryPanelOpen()) fillSelects(panel);
      });
    } catch { /* */ }
  }
}

export function hideCadQueryPanel(): void {
  if (panel) panel.style.display = "none";
}

export function toggleCadQueryPanel(): void {
  if (isCadQueryPanelOpen()) hideCadQueryPanel();
  else showCadQueryPanel();
}

export function setupCadQueryPanel(): void {
  (window as any).__obsCadQuery = {
    open: showCadQueryPanel,
    close: hideCadQueryPanel,
    toggle: toggleCadQueryPanel,
  };
  try {
    (ctx.features as any).cadQuery = {
      open: showCadQueryPanel,
      toggle: toggleCadQueryPanel,
      isOpen: isCadQueryPanelOpen,
    };
  } catch { /* */ }
  console.log("[cad-query] panel ready — query linked drawings by layer / type / name");
}
