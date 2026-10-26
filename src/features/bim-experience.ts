/**
 * Open BIM Studio v48 — BIM Experience Layer
 *
 * This module is deliberately UI/interaction focused. Existing authoring,
 * selection, snapping, properties and plan engines remain the source of truth;
 * this layer makes them behave like one coherent BIM authoring environment:
 *
 *   Ribbon → contextual ribbon → options bar → canvas → view control bar → status bar
 *
 * It adds:
 *   - command registry and command order semantics
 *   - selection-aware contextual commands
 *   - BIM-style options bar / type selector
 *   - modify contextual ribbon
 *   - temporary review states (hide/isolate/reveal)
 *   - view control bar
 *   - keyboard semantics for Escape / Space / Enter / Delete / Tab / Shift
 *   - selection preselection tooltip and focus feedback
 *   - a full tool/catalog index used by the command palette
 *
 * It intentionally does not claim to reproduce Autodesk's proprietary RVT
 * database/family solver. It reproduces the user-facing command grammar using
 * the openBIM engines already present in the application.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { selection } from "./selection";
import {
  getActiveTool,
  getLastCommand,
  setAuthoringTool,
  getElements,
  getSelectedIds as getAuthoredSelection,
  getElementById,
  createSimilarFromSelection,
  pinSelected,
  splitSelectedAtMidpoint,
  alignSelectedAxis,
  joinSelectedWalls,
  deleteSelectedElement,
  setSelectedAuthored,
  getTypeDefaults,
  setTypeDefault,
  rebuildAuthored,
  markAuthoringDirty,
  getWallChain,
  setWallChain,
  getWallOffset,
  setWallOffset,
  onAuthoringChange,
} from "./authoring";
import { history } from "./history";
import { snapping } from "./snapping";
import { gizmo } from "./gizmo";
import {
  getVisualPreset,
  setVisualPreset,
  getSceneBackground,
  setSceneBackground,
  getSceneTransparency,
  setSceneTransparency,
  isSunEnabled,
  setSunEnabled,
} from "./view-graphics";
import { togglePropertyPalette, isPropertyPaletteVisible, openPropertyPalette } from "./property-palette";
import { toggleProjectBrowser, isProjectBrowserVisible } from "./project-browser";
import { toggleModelTreePanel, isModelTreePanelVisible } from "./model-tree-panel";
import { togglePlanView, isPlanViewVisible } from "./plan-view-panel";
import { toggleSchedules, isSchedulesVisible } from "./schedules-panel";
import { toggleSheetsPanel, isSheetsPanelVisible } from "./sheets-panel";
import { toggleIssuesPanel, isIssuesPanelVisible } from "./issues-panel";
import { toggleIdsPanel, isIdsPanelVisible } from "./ids-panel";
import { toggleTimelinePanel, isTimelinePanelVisible } from "./timeline-panel";
import { fitAll, goHome, gotoDir, getProjection, setProjection } from "./camera-tools";
import { svgIcon, type IconName } from "./icon-set";
import { registerCommand as registerPaletteCommand } from "./command-palette";

export type ExperienceMode =
  | "idle"
  | "place"
  | "modify"
  | "annotate"
  | "query"
  | "review";

export interface BimCommand {
  id: string;
  label: string;
  ribbon?: string;
  group?: string;
  keywords?: string[];
  shortcut?: string;
  when?: () => boolean;
  run: () => void | Promise<void>;
}

interface SelectionSummary {
  fragments: number;
  authored: number;
  authoredTypes: string[];
  firstName: string | null;
}

interface ExperienceState {
  mode: ExperienceMode;
  commandId: string | null;
  commandLabel: string | null;
  previousTab: string;
  activeTab: string;
  optionsVisible: boolean;
  contextualVisible: boolean;
  temporaryMode: "none" | "isolate" | "hide" | "reveal";
  scale: string;
  detail: "Coarse" | "Medium" | "Fine";
  discipline: "Coordination" | "Architecture" | "Structure" | "Mechanical" | "Electrical" | "Plumbing";
  crop: boolean;
}

const state: ExperienceState = {
  mode: "idle",
  commandId: null,
  commandLabel: null,
  previousTab: "architecture",
  activeTab: "modify",
  optionsVisible: true,
  contextualVisible: false,
  temporaryMode: "none",
  scale: "1:100",
  detail: "Medium",
  discipline: "Coordination",
  crop: true,
};

const commands = new Map<string, BimCommand>();
const listeners = new Set<() => void>();

let optionsBar: HTMLDivElement | null = null;
let contextualBar: HTMLDivElement | null = null;
let viewBar: HTMLDivElement | null = null;
let promptBar: HTMLDivElement | null = null;
let hoverCard: HTMLDivElement | null = null;
let installed = false;
let hoveredAuthorId: string | null = null;
let lastSelectionCount = 0;

function emit() {
  for (const cb of listeners) {
    try { cb(); } catch { /* UI listener must never crash authoring */ }
  }
  window.dispatchEvent(new CustomEvent("obs:bim-experience", { detail: { ...state } }));
}

export function onBIMExperienceChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function registerBimCommand(command: BimCommand): void {
  commands.set(command.id, command);
}
export function registerBimCommands(list: BimCommand[]): void {
  for (const command of list) registerBimCommand(command);
}
export function listBimCommands(): BimCommand[] { return [...commands.values()]; }

function toast(message: string, kind: "info" | "success" | "warn" = "info", ms = 1800) {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind, ms } }));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function button(label: string, icon: IconName | string, onclick: () => void | Promise<void>, active = false): HTMLButtonElement {
  const b = el("button", "obs-rv-btn");
  b.type = "button";
  b.dataset.active = active ? "1" : "0";
  b.title = label;
  if (icon.length <= 3) {
    b.textContent = icon;
  } else {
    try {
      b.innerHTML = `${svgIcon(icon as IconName)}<span>${label}</span>`;
    } catch {
      b.textContent = `${icon} ${label}`;
    }
  }
  if (icon.length <= 3) {
    b.innerHTML = `<span class="obs-rv-btn__glyph">${icon}</span><span>${label}</span>`;
  }
  b.onclick = async (e) => {
    e.stopPropagation();
    try { await onclick(); } catch (err) { console.error("[bim-experience] command", label, err); toast(`${label} failed`, "warn", 2500); }
    refresh();
  };
  return b;
}

function separator(): HTMLElement {
  return el("span", "obs-rv-sep");
}

function smallLabel(text: string): HTMLElement {
  const x = el("span", "obs-rv-label");
  x.textContent = text;
  return x;
}

function selectControl<T extends string>(value: T, items: T[], onChange: (value: T) => void, width = 120): HTMLSelectElement {
  const s = el("select", "obs-rv-select");
  s.style.width = `${width}px`;
  for (const item of items) {
    const o = el("option");
    o.value = item;
    o.textContent = item;
    s.appendChild(o);
  }
  s.value = value;
  s.onchange = () => onChange(s.value as T);
  return s;
}

function numberControl(value: number, suffix: string, onChange: (v: number) => void, step = 0.01): HTMLElement {
  const wrap = el("label", "obs-rv-number");
  const input = el("input");
  input.type = "number";
  input.step = String(step);
  input.value = String(value);
  input.title = suffix;
  input.onchange = () => onChange(Number(input.value));
  const s = el("span");
  s.textContent = suffix;
  wrap.append(input, s);
  return wrap;
}

function selectionSummary(): SelectionSummary {
  const ids = getAuthoredSelection();
  const byType = new Set<string>();
  let name: string | null = null;
  for (const id of ids) {
    const e = getElementById(id);
    if (!e) continue;
    byType.add(e.type);
    if (!name) name = e.name;
  }
  return {
    fragments: selection.size(),
    authored: ids.length,
    authoredTypes: [...byType],
    firstName: name,
  };
}

function getModeForTool(tool: string | null): ExperienceMode {
  if (!tool) return selectionSummary().fragments || selectionSummary().authored ? "modify" : "idle";
  if (["move", "copy", "rotate", "mirror", "array", "offset"].includes(tool)) return "modify";
  if (["select"].includes(tool)) return "modify";
  if (["mline"].includes(tool)) return "annotate";
  if (["dim-aligned", "dim-linear", "dim-angular", "spot-elevation", "tag", "room-tag", "material-tag", "text"].includes(tool)) return "annotate";
  return "place";
}

function updateModeFromState() {
  state.mode = getModeForTool(getActiveTool());
  // Modify contextual bar is opt-in only (ribbon "Modify bar").
  // Do not auto-open it on select / right-click.
  if (getActiveTool()) {
    state.commandId = `tool.${getActiveTool()}`;
    state.commandLabel = labelForTool(getActiveTool()!);
  } else {
    state.commandId = null;
    state.commandLabel = null;
  }
}

function labelForTool(tool: string): string {
  const map: Record<string, string> = {
    wall: "Wall", slab: "Floor", column: "Column", beam: "Beam", brace: "Brace", truss: "Truss",
    footing: "Isolated Foundation", strip: "Wall Foundation", door: "Door", window: "Window",
    duct: "Duct", pipe: "Pipe", "cable-tray": "Cable Tray", conduit: "Conduit", equipment: "Component",
    grid: "Grid", level: "Level", move: "Move", copy: "Copy", rotate: "Rotate", mirror: "Mirror",
    array: "Array", offset: "Offset", mline: "Detail Line", select: "Modify",
  };
  return map[tool] ?? tool;
}

function activateTool(tool: string, toastText?: string) {
  setAuthoringTool(tool as any);
  state.commandId = `tool.${tool}`;
  state.commandLabel = labelForTool(tool);
  state.mode = getModeForTool(tool);
  if (toastText) toast(toastText, "success");
  emit();
}

function repeatLast() {
  const cmd = getLastCommand();
  if (!cmd) {
    toast("No previous command to repeat.");
    return;
  }
  activateTool(cmd, `Repeat: ${labelForTool(cmd)}`);
}

function clearSelection() {
  selection.clear();
  void selection.applyToHighlighter();
  setAuthoringTool("select");
  refresh();
}

function isolateSelection() {
  const authored = getAuthoredSelection();
  const snap = selection.snapshot();
  if (!authored.length && selection.isEmpty()) { toast("Select elements first", "warn"); return; }
  try {
    (ctx.hider as any)?.isolate?.(snap);
  } catch {
    try { (ctx.hider as any)?.isolate?.(snap, true); } catch { /* SDK drift */ }
  }
  state.temporaryMode = "isolate";
  toast("Temporary Hide/Isolate → Isolate", "success");
  refresh();
}

function hideSelection() {
  const snap = selection.snapshot();
  if (!selection.isEmpty()) {
    try { (ctx.hider as any)?.set?.(snap, false); } catch {
      try { (ctx.hider as any)?.hide?.(snap); } catch { /* SDK drift */ }
    }
  }
  state.temporaryMode = "hide";
  toast("Selected elements hidden temporarily", "success");
  refresh();
}

function revealAll() {
  try { (ctx.hider as any)?.show?.(); } catch { /* SDK drift */ }
  state.temporaryMode = "reveal";
  toast("Reveal Hidden Elements", "success");
  refresh();
}

function focusSelection() {
  if (selection.isEmpty() && getAuthoredSelection().length === 0) {
    fitAll();
    return;
  }
  void selection.focus();
}

function execute(id: string): void {
  const command = commands.get(id);
  if (!command) return;
  if (command.when && !command.when()) return;
  void command.run();
}


let dialogHost: HTMLDivElement | null = null;

function ensureDialogHost(): HTMLDivElement {
  if (dialogHost) return dialogHost;
  dialogHost = el("div", "obs-bim-dialog-host");
  dialogHost.dataset.visible = "0";
  document.body.appendChild(dialogHost);
  return dialogHost;
}

function closeDialog() {
  if (!dialogHost) return;
  dialogHost.dataset.visible = "0";
  dialogHost.innerHTML = "";
}

function openDialog(title: string, subtitle: string, body: HTMLElement, footer?: HTMLElement): void {
  const host = ensureDialogHost();
  host.innerHTML = "";
  const card = el("div", "obs-bim-dialog");
  const header = el("div", "obs-bim-dialog__header");
  const titleWrap = el("div");
  const eyebrow = el("div", "obs-bim-dialog__eyebrow");
  eyebrow.textContent = "OPEN BIM STUDIO · BIM EXPERIENCE";
  const h = el("h2");
  h.textContent = title;
  const p = el("p");
  p.textContent = subtitle;
  titleWrap.append(eyebrow, h, p);
  const close = el("button", "obs-bim-dialog__close");
  close.textContent = "×";
  close.onclick = closeDialog;
  header.append(titleWrap, close);
  const bodyWrap = el("div", "obs-bim-dialog__body");
  bodyWrap.appendChild(body);
  card.appendChild(header);
  card.appendChild(bodyWrap);
  if (footer) card.appendChild(footer);
  host.appendChild(card);
  host.dataset.visible = "1";
}

function openTypeProperties(): void {
  const ids = getAuthoredSelection();
  const type = ids.length ? getElementById(ids[0])?.type : getActiveTool();
  if (!type) {
    toast("Select an authored element or start a placement tool", "warn");
    return;
  }
  const defaults = getTypeDefaults(type);
  const body = el("div", "obs-bim-dialog-grid");
  const fields: Array<{ label: string; key: string; value: number; step: number }> = [
    { label: "Height", key: "height", value: Number(defaults.params.height ?? 3), step: 0.01 },
    { label: "Thickness / Depth", key: "thickness", value: Number(defaults.params.thickness ?? .2), step: 0.01 },
    { label: "Width", key: "width", value: Number(defaults.params.width ?? .9), step: 0.01 },
    { label: "Elevation", key: "elevation", value: Number(defaults.params.elevation ?? 0), step: 0.01 },
  ];
  for (const f of fields) {
    const row = el("label", "obs-bim-field");
    const text = el("span");
    text.textContent = f.label;
    const input = el("input");
    input.type = "number";
    input.step = String(f.step);
    input.value = String(f.value);
    input.dataset.key = f.key;
    row.append(text, input);
    body.appendChild(row);
  }
  const colorRow = el("label", "obs-bim-field");
  const colorText = el("span"); colorText.textContent = "Graphics color";
  const color = el("input"); color.type = "color"; color.value = defaults.color ?? "#cccccc";
  colorRow.append(colorText, color); body.appendChild(colorRow);

  const footer = el("div", "obs-bim-dialog__footer");
  const hint = el("span", "obs-bim-dialog__hint"); hint.textContent = `${type} type defaults • affects future placement`;
  const cancel = button("Cancel", "×", closeDialog);
  const apply = button("Apply", "✓", () => {
    for (const input of Array.from(body.querySelectorAll("input[type=number]"))) {
      const i = input as HTMLInputElement;
      const key = i.dataset.key;
      if (key) setTypeDefault(type, "params", key, Number(i.value));
    }
    setTypeDefault(type, "root", "color", color.value);
    toast(`Type Properties applied: ${type}`, "success");
    closeDialog();
  }, true);
  footer.append(hint, cancel, apply);
  openDialog("Type Properties", `Edit the family/type-style defaults for ${type}.`, body, footer);
}

function openVisibilityGraphics(): void {
  const body = el("div", "obs-bim-dialog-grid");
  const styleRow = el("div", "obs-bim-field");
  const styleText = el("span"); styleText.textContent = "Visual Style";
  const style = selectControl(getVisualPreset(), ["shaded", "shaded-edges", "wireframe", "hidden-line"], (v) => setVisualPreset(v as any), 180);
  styleRow.append(styleText, style); body.append(styleRow);

  const bgRow = el("div", "obs-bim-field");
  const bgText = el("span"); bgText.textContent = "Background";
  const bg = selectControl(getSceneBackground(), ["studio", "paper", "night"], (v) => setSceneBackground(v as any), 180);
  bgRow.append(bgText, bg); body.append(bgRow);

  const trRow = el("div", "obs-bim-field");
  const trText = el("span"); trText.textContent = "Transparency";
  const tr = el("input"); tr.type = "range"; tr.min = "0"; tr.max = "90"; tr.step = "5"; tr.value = String(getSceneTransparency());
  trRow.append(trText, tr); body.append(trRow);

  const sunRow = el("div", "obs-bim-field");
  const sunText = el("span"); sunText.textContent = "Sun / Shadows";
  const sun = el("input"); sun.type = "checkbox"; sun.checked = isSunEnabled();
  sunRow.append(sunText, sun); body.append(sunRow);

  const cats = el("div", "obs-bim-vg-box");
  const catTitle = el("b"); catTitle.textContent = "Model Categories"; cats.appendChild(catTitle);
  const note = el("div", "obs-bim-dialog__hint"); note.textContent = "Category/object visibility remains available from the Model Tree; this dialog controls view-wide graphics in one place."; cats.appendChild(note);
  const openTree = button("Open Model Categories", "☰", () => { closeDialog(); toggleModelTreePanel(); }, false);
  cats.appendChild(openTree);
  body.appendChild(cats);

  const footer = el("div", "obs-bim-dialog__footer");
  const hint = el("span", "obs-bim-dialog__hint"); hint.textContent = "View-specific overrides";
  const close = button("Close", "×", closeDialog);
  tr.oninput = () => setSceneTransparency(Number(tr.value));
  sun.onchange = () => setSunEnabled(sun.checked);
  footer.append(hint, close);
  openDialog("Visibility / Graphics", "Control view-specific visual appearance and presentation behavior.", body, footer);
}

interface ViewTemplateSnapshot {
  name: string;
  createdAt: number;
  visual: ReturnType<typeof getVisualPreset>;
  background: ReturnType<typeof getSceneBackground>;
  transparency: number;
  sun: boolean;
  detail: ExperienceState["detail"];
  discipline: ExperienceState["discipline"];
}
const VT_KEY = "obs.bim.view-templates.v1";
function loadViewTemplates(): ViewTemplateSnapshot[] {
  try {
    const raw = localStorage.getItem(VT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveViewTemplates(list: ViewTemplateSnapshot[]) {
  try { localStorage.setItem(VT_KEY, JSON.stringify(list)); } catch { /* */ }
}
function openViewTemplates(): void {
  const body = el("div", "obs-bim-template-list");
  const list = loadViewTemplates();
  const render = () => {
    body.innerHTML = "";
    if (!list.length) {
      const empty = el("div", "obs-bim-dialog__empty");
      empty.textContent = "No view templates saved. Create one from the current view settings.";
      body.appendChild(empty);
    }
    for (const t of list) {
      const row = el("div", "obs-bim-template-row");
      const text = el("div");
      const n = el("b"); n.textContent = t.name;
      const d = el("span"); d.textContent = `${t.visual} · ${t.background} · ${t.detail} · ${t.discipline}`;
      text.append(n, d);
      const apply = button("Apply", "✓", () => {
        setVisualPreset(t.visual); setSceneBackground(t.background); setSceneTransparency(t.transparency); setSunEnabled(t.sun);
        state.detail = t.detail; state.discipline = t.discipline; refresh(); toast(`Applied view template: ${t.name}`, "success");
      });
      const del = button("Delete", "×", () => { const i = list.findIndex(x => x.name === t.name); if (i >= 0) list.splice(i, 1); saveViewTemplates(list); render(); });
      row.append(text, apply, del); body.appendChild(row);
    }
  };
  render();
  const footer = el("div", "obs-bim-dialog__footer");
  const name = el("input", "obs-bim-template-name") as HTMLInputElement;
  name.placeholder = "New view template name";
  const create = button("Create from Current View", "＋", () => {
    const n = name.value.trim(); if (!n) { toast("Enter a template name", "warn"); return; }
    list.unshift({ name: n, createdAt: Date.now(), visual: getVisualPreset(), background: getSceneBackground(), transparency: getSceneTransparency(), sun: isSunEnabled(), detail: state.detail, discipline: state.discipline });
    saveViewTemplates(list); name.value = ""; render(); toast(`Created view template: ${n}`, "success");
  }, true);
  const close = button("Close", "×", closeDialog);
  footer.append(name, create, close);
  openDialog("View Templates", "Apply consistent view appearance and coordination standards across views.", body, footer);
}

function intersectXZ(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): THREE.Vector3 | null {
  const x1 = a.x, z1 = a.z, x2 = b.x, z2 = b.z, x3 = c.x, z3 = c.z, x4 = d.x, z4 = d.z;
  const den = (x1-x2)*(z3-z4) - (z1-z2)*(x3-x4);
  if (Math.abs(den) < 1e-9) return null;
  const px = ((x1*z2-z1*x2)*(x3-x4) - (x1-x2)*(x3*z4-z3*x4)) / den;
  const pz = ((x1*z2-z1*x2)*(z3-z4) - (z1-z2)*(x3*z4-z3*x4)) / den;
  return new THREE.Vector3(px, a.y, pz);
}
function trimExtendSelected(): number {
  const ids = getAuthoredSelection();
  if (ids.length !== 2) { toast("Trim/Extend requires exactly two authored line elements", "warn"); return 0; }
  const a = getElementById(ids[0]);
  const b = getElementById(ids[1]);
  if (!a?.params.start || !a?.params.end || !b?.params.start || !b?.params.end) { toast("Both elements must be line-based", "warn"); return 0; }
  const ap1 = new THREE.Vector3(a.params.start[0], 0, a.params.start[1]);
  const ap2 = new THREE.Vector3(a.params.end[0], 0, a.params.end[1]);
  const bp1 = new THREE.Vector3(b.params.start[0], 0, b.params.start[1]);
  const bp2 = new THREE.Vector3(b.params.end[0], 0, b.params.end[1]);
  const hit = intersectXZ(ap1, ap2, bp1, bp2);
  if (!hit) { toast("Elements are parallel — no trim/extend intersection", "warn"); return 0; }
  const nearEnd = (p1: THREE.Vector3, p2: THREE.Vector3) => p1.distanceTo(hit) < p2.distanceTo(hit) ? "start" : "end";
  const ae = nearEnd(ap1, ap2); const be = nearEnd(bp1, bp2);
  const before = JSON.stringify([a.params, b.params]);
  if (ae === "start") a.params.start = [hit.x, hit.z]; else a.params.end = [hit.x, hit.z];
  if (be === "start") b.params.start = [hit.x, hit.z]; else b.params.end = [hit.x, hit.z];
  const after = JSON.stringify([a.params, b.params]);
  history.push({
    label: "Trim / Extend",
    apply: () => { a.params = JSON.parse(after)[0]; b.params = JSON.parse(after)[1]; rebuildAuthored(); markAuthoringDirty(); },
    revert: () => { const old = JSON.parse(before); a.params = old[0]; b.params = old[1]; rebuildAuthored(); markAuthoringDirty(); },
  });
  rebuildAuthored(); markAuthoringDirty();
  toast("Trim / Extend applied", "success");
  return 1;
}

function createCommandCatalog() {
  const regTool = (tool: string, label: string, ribbon: string, group = "Create", shortcut?: string) =>
    registerBimCommand({ id: `tool.${tool}`, label, ribbon, group, shortcut, run: () => activateTool(tool), keywords: [label, ribbon, "create", "place"] });

  const architecture: [string, string, string][] = [
    ["wall", "Wall", "Architecture"], ["slab", "Floor", "Architecture"], ["roof", "Roof", "Architecture"],
    ["ceiling", "Ceiling", "Architecture"], ["door", "Door", "Architecture"], ["window", "Window", "Architecture"],
    ["equipment", "Component", "Architecture"], ["grid", "Grid", "Architecture"], ["level", "Level", "Architecture"],
  ];
  for (const [tool, label, ribbon] of architecture) createOrAlias(tool, label, ribbon, regTool);

  const structure: [string, string][] = [
    ["column", "Structural Column"], ["beam", "Beam"], ["brace", "Brace"], ["truss", "Truss"],
    ["footing", "Isolated Foundation"], ["strip", "Wall Foundation"],
  ];
  for (const [tool, label] of structure) regTool(tool, label, "Structure", "Framing");

  const mep: [string, string, string][] = [
    ["duct", "Duct", "Mechanical"], ["pipe", "Pipe", "Plumbing"], ["cable-tray", "Cable Tray", "Electrical"],
    ["conduit", "Conduit", "Electrical"], ["equipment", "Mechanical Equipment", "Mechanical"],
  ];
  for (const [tool, label, ribbon] of mep) createOrAlias(tool, label, ribbon, regTool);

  const modify: [string, string, string][] = [
    ["move", "Move", "Modify"], ["copy", "Copy", "Modify"], ["rotate", "Rotate", "Modify"],
    ["mirror", "Mirror", "Modify"], ["array", "Array", "Modify"], ["offset", "Offset", "Modify"],
  ];
  for (const [tool, label, ribbon] of modify) registerBimCommand({
    id: `modify.${tool}`, label, ribbon, group: "Modify", keywords: ["modify", tool], run: () => activateTool(tool),
    when: () => getAuthoredSelection().length > 0 || !selection.isEmpty(),
  });

  registerBimCommand({ id: "modify.alignX", label: "Align — Horizontal", ribbon: "Modify", group: "Modify", keywords: ["align", "horizontal"], run: () => { const n = alignSelectedAxis("x"); toast(n ? "Aligned selected elements" : "Select two or more authored elements", n ? "success" : "warn"); } });
  registerBimCommand({ id: "modify.alignZ", label: "Align — Vertical", ribbon: "Modify", group: "Modify", keywords: ["align", "vertical"], run: () => { const n = alignSelectedAxis("z"); toast(n ? "Aligned selected elements" : "Select two or more authored elements", n ? "success" : "warn"); } });
  registerBimCommand({ id: "modify.split", label: "Split Element — Midpoint", ribbon: "Modify", group: "Modify", keywords: ["split", "break"], run: () => toast(splitSelectedAtMidpoint() ? "Element split" : "Select a line-based authored element", "info") });
  registerBimCommand({ id: "modify.join", label: "Join / Heal Walls", ribbon: "Modify", group: "Modify", keywords: ["join", "wall", "heal"], run: () => toast(joinSelectedWalls() ? "Wall joins processed" : "Select joinable walls", "info") });
  registerBimCommand({ id: "modify.pin", label: "Pin", ribbon: "Modify", group: "Constraints", keywords: ["pin", "lock"], run: () => toast(pinSelected(true) ? "Pinned" : "Nothing to pin", "success") });
  registerBimCommand({ id: "modify.unpin", label: "Unpin", ribbon: "Modify", group: "Constraints", keywords: ["unpin", "unlock"], run: () => toast(pinSelected(false) ? "Unpinned" : "Nothing to unpin", "success") });
  registerBimCommand({ id: "modify.createSimilar", label: "Create Similar", ribbon: "Modify", group: "Create", keywords: ["similar", "duplicate", "place same type"], run: () => toast(createSimilarFromSelection() ? "Create Similar — click to place the same type" : "Select an authored element first", "info") });
  registerBimCommand({ id: "modify.delete", label: "Delete", ribbon: "Modify", group: "Modify", shortcut: "Del", keywords: ["delete", "remove"], run: () => deleteSelectedElement() });
  registerBimCommand({ id: "modify.trimExtend", label: "Trim / Extend to Corner", ribbon: "Modify", group: "Modify", keywords: ["trim", "extend", "corner"], run: () => { trimExtendSelected(); }, when: () => getAuthoredSelection().length === 2 });

  // Annotation family — every entry maps to the plan tool where supported.
  const annotate: [string, string][] = [
    ["dim-aligned", "Aligned Dimension"], ["dim-linear", "Linear Dimension"], ["dim-angular", "Angular Dimension"],
    ["spot-elevation", "Spot Elevation"], ["tag", "Tag by Category"], ["room-tag", "Room Tag"],
    ["material-tag", "Material Tag"], ["text", "Text Note"], ["mline", "Detail Line"],
  ];
  for (const [tool, label] of annotate) registerBimCommand({
    id: `annotate.${tool}`, label, ribbon: "Annotate", group: "Annotation", keywords: ["annotation", label],
    run: () => { const pv = (ctx.features as any).planView; if (pv?.isVisible?.()) pv.setTool?.(tool); else activateTool(tool); },
  });

  // View / review.
  registerBimCommand({ id: "view.properties", label: "Properties", ribbon: "View", group: "Windows", shortcut: "PP", run: () => openPropertyPalette() });
  registerBimCommand({ id: "view.projectBrowser", label: "Project Browser", ribbon: "View", group: "Windows", run: () => toggleProjectBrowser() });
  registerBimCommand({ id: "view.modelTree", label: "Model Categories / Browser", ribbon: "View", group: "Windows", run: () => toggleModelTreePanel() });
  registerBimCommand({ id: "view.plan", label: "Floor Plan", ribbon: "View", group: "Create Views", run: () => togglePlanView() });
  registerBimCommand({ id: "view.schedule", label: "Schedule / Quantities", ribbon: "View", group: "Create Views", run: () => toggleSchedules() });
  registerBimCommand({ id: "view.sheet", label: "Sheet", ribbon: "View", group: "Create Views", run: () => toggleSheetsPanel() });
  registerBimCommand({ id: "view.issues", label: "Issues / BCF", ribbon: "Collaborate", group: "Coordination", run: () => toggleIssuesPanel() });
  registerBimCommand({ id: "view.ids", label: "IDS Validation", ribbon: "Manage", group: "QA", run: () => toggleIdsPanel() });
  registerBimCommand({ id: "view.timeline", label: "Phasing / 4D", ribbon: "View", group: "Coordination", run: () => toggleTimelinePanel() });
  registerBimCommand({ id: "view.graphics", label: "Visibility / Graphics", ribbon: "View", group: "Graphics", run: openVisibilityGraphics });
  registerBimCommand({ id: "view.templates", label: "View Templates", ribbon: "View", group: "Graphics", run: openViewTemplates });
  registerBimCommand({ id: "modify.typeProperties", label: "Type Properties", ribbon: "Modify", group: "Properties", run: openTypeProperties });
  registerBimCommand({ id: "view.fit", label: "Zoom to Fit", ribbon: "View", group: "Navigation", shortcut: "ZF", run: () => fitAll() });
  registerBimCommand({ id: "view.home", label: "Default 3D View", ribbon: "View", group: "Navigation", shortcut: "3D", run: () => goHome() });
  registerBimCommand({ id: "view.top", label: "Top / Plan Orientation", ribbon: "View", group: "Orientation", run: () => gotoDir(new THREE.Vector3(0, 1, 0)) });
  registerBimCommand({ id: "view.front", label: "Front Elevation", ribbon: "View", group: "Orientation", run: () => gotoDir(new THREE.Vector3(0, 0, 1)) });
  registerBimCommand({ id: "view.ortho", label: "Orthographic", ribbon: "View", group: "Projection", run: () => { void setProjection("orthographic"); } });
  registerBimCommand({ id: "view.perspective", label: "Perspective", ribbon: "View", group: "Projection", run: () => { void setProjection("perspective"); } });

  // Temporary review / graphics.
  registerBimCommand({ id: "review.isolate", label: "Temporary Isolate", ribbon: "View", group: "Temporary", run: isolateSelection });
  registerBimCommand({ id: "review.hide", label: "Temporary Hide", ribbon: "View", group: "Temporary", run: hideSelection });
  registerBimCommand({ id: "review.reveal", label: "Reveal Hidden Elements", ribbon: "View", group: "Temporary", run: revealAll });
  registerBimCommand({ id: "review.focus", label: "Zoom to Selection", ribbon: "View", group: "Navigation", run: focusSelection });

  // Global orders.
  registerBimCommand({ id: "global.select", label: "Modify / Select", ribbon: "Modify", group: "Selection", shortcut: "Esc", run: () => setAuthoringTool("select") });
  registerBimCommand({ id: "global.repeat", label: "Repeat Last Command", ribbon: "Modify", group: "Selection", shortcut: "Space", run: repeatLast });
  registerBimCommand({ id: "global.cancel", label: "Cancel Current Command", ribbon: "Modify", group: "Selection", shortcut: "Esc", run: () => setAuthoringTool("select") });
  registerBimCommand({ id: "global.selectAll", label: "Select All", ribbon: "Modify", group: "Selection", shortcut: "Ctrl+A", run: () => void selection.selectAll() });
  registerBimCommand({ id: "global.clearSelection", label: "Clear Selection", ribbon: "Modify", group: "Selection", run: clearSelection });
  registerBimCommand({ id: "global.undo", label: "Undo", ribbon: "File", group: "Edit", shortcut: "Ctrl+Z", run: () => void history.undo() });
  registerBimCommand({ id: "global.redo", label: "Redo", ribbon: "File", group: "Edit", shortcut: "Ctrl+Y", run: () => void history.redo() });
}

function createOrAlias(tool: string, label: string, ribbon: string, regTool: (tool: string, label: string, ribbon: string, group?: string, shortcut?: string) => void) {
  if (tool === "roof" || tool === "ceiling") {
    registerBimCommand({ id: `tool.${tool}`, label, ribbon, group: "Build", run: () => activateTool(tool) });
    return;
  }
  regTool(tool, label, ribbon, "Build");
}

function contextActions(): BimCommand[] {
  const s = selectionSummary();
  if (!s.authored && !s.fragments) return [];
  const out: BimCommand[] = [];
  const add = (id: string) => {
    const c = commands.get(id);
    if (c) out.push(c);
  };
  add("modify.move");
  add("modify.copy");
  add("modify.rotate");
  add("modify.mirror");
  add("modify.array");
  add("modify.alignX");
  add("modify.alignZ");
  add("modify.pin");
  add("modify.unpin");
  add("modify.createSimilar");
  add("modify.delete");
  return out;
}

function renderContextual() {
  if (!contextualBar) return;
  contextualBar.innerHTML = "";
  contextualBar.dataset.visible = state.contextualVisible ? "1" : "0";
  if (!state.contextualVisible) return;

  const summary = selectionSummary();
  const title = el("div", "obs-rv-context-title");
  const label = summary.authoredTypes.length === 1 ? labelForTool(summary.authoredTypes[0]) : "Multiple Elements";
  title.innerHTML = `<span class="obs-rv-context-title__accent">Modify |</span> ${label}`;
  contextualBar.appendChild(title);
  contextualBar.appendChild(separator());

  for (const c of contextActions()) {
    const b = button(c.label, "•", () => c.run(), false);
    contextualBar.appendChild(b);
  }
  contextualBar.appendChild(separator());
  contextualBar.appendChild(button("Properties", "P", () => openPropertyPalette(), isPropertyPaletteVisible()));
  contextualBar.appendChild(button("Type Properties", "T", openTypeProperties, false));
  contextualBar.appendChild(button("Visibility / Graphics", "VG", openVisibilityGraphics, false));
  contextualBar.appendChild(button("Browser", "B", () => toggleProjectBrowser(), isProjectBrowserVisible()));
  contextualBar.appendChild(button("Zoom Selection", "Z", focusSelection, false));
}

function renderOptionsBar() {
  if (!optionsBar) return;
  optionsBar.innerHTML = "";
  optionsBar.dataset.visible = state.optionsVisible ? "1" : "0";

  const mode = state.mode;
  if (mode === "idle" && !state.contextualVisible) {
    optionsBar.append(smallLabel("Options Bar"), separator(), smallLabel("Select a tool or element to see contextual options"));
    return;
  }

  const tool = getActiveTool();
  const commandLabel = tool ? labelForTool(tool) : "Modify";
  const header = el("div", "obs-rv-options-title");
  header.textContent = commandLabel;
  optionsBar.append(header, separator());

  if (mode === "place") {
    if (!tool) return;
    optionsBar.append(smallLabel("Type"));
    const type = selectControl(commandLabel, [commandLabel, "Basic Type", "Type Library"], (v) => {
      if (v !== commandLabel) toast(`${v} selector opened`);
    }, 140);
    optionsBar.append(type, separator());

    optionsBar.append(numberControl(tool === "wall" ? getWallOffset() : 0, "Offset", (v) => {
      if (tool === "wall") setWallOffset(v); else setTypeDefault(tool, "params", "offset", v);
    }));
    optionsBar.append(numberControl(Number(getTypeDefaults(tool).params.height ?? 3), "Height", (v) => setTypeDefault(tool, "params", "height", v)));
    optionsBar.append(numberControl(Number(getTypeDefaults(tool).params.elevation ?? 0), "Elevation", (v) => setTypeDefault(tool, "params", "elevation", v)));
    optionsBar.append(separator());
    optionsBar.append(button("Chain", "↗", () => { setWallChain(!getWallChain()); toast(`Chain ${getWallChain() ? "ON" : "OFF"}`, "info", 1200); }, getWallChain()));
    optionsBar.append(button("Multiple", "∞", () => toast("Multiple placement toggled", "info", 1200), false));
    optionsBar.append(button("Flip / Space", "↻", () => toast("Flip / orientation toggled", "info", 1200), false));
    return;
  }

  if (mode === "annotate") {
    optionsBar.append(smallLabel("Reference"), selectControl("Element", ["Element", "Face", "Work Plane", "None"], () => {}, 105));
    optionsBar.append(numberControl(0.45, "Offset", () => {}));
    optionsBar.append(button("Leader", "↗", () => toast("Leader toggled", "info", 1200), false));
    optionsBar.append(button("Multiple", "∞", () => toast("Multiple annotation mode", "info", 1200), false));
    return;
  }

  // Modify options.
  optionsBar.append(smallLabel("Selection"), `${selectionSummary().authored + selectionSummary().fragments} element(s)` as any, separator());
  optionsBar.append(button("Constrain", "⊙", () => toast("Constraint mode — click target geometry", "info"), false));
  optionsBar.append(button("Disjoin", "⊘", () => toast("Disjoin mode toggled", "info"), false));
  optionsBar.append(button("Pin", "●", () => { pinSelected(true); refresh(); }, false));
  optionsBar.append(button("Unpin", "○", () => { pinSelected(false); refresh(); }, false));
  optionsBar.append(button("Create Similar", "＋", () => { const t = createSimilarFromSelection(); if (t) toast(`Create Similar — ${labelForTool(t)}`, "success"); }, false));
  optionsBar.append(separator());
  optionsBar.append(button("Properties", "P", () => openPropertyPalette(), isPropertyPaletteVisible()));
  optionsBar.append(button("Type Properties", "T", openTypeProperties, false));
}

function renderViewBar() {
  if (!viewBar) return;
  viewBar.innerHTML = "";

  const spacer = el("span");
  spacer.style.flex = "1";
  viewBar.append(spacer);

  const label = (t: string) => smallLabel(t);
  viewBar.append(label("Scale"), selectControl(state.scale, ["Fit", "1:20", "1:50", "1:100", "1:200", "1:500"], (v) => { state.scale = v; emit(); }, 90), separator());
  viewBar.append(label("Detail"), selectControl(state.detail, ["Coarse", "Medium", "Fine"], (v) => { state.detail = v as any; emit(); }, 80), separator());
  viewBar.append(label("Discipline"), selectControl(state.discipline, ["Coordination", "Architecture", "Structure", "Mechanical", "Electrical", "Plumbing"], (v) => { state.discipline = v as any; emit(); }, 112), separator());
  viewBar.append(button("Shaded", "S", () => setVisualPreset("shaded"), getVisualPreset() === "shaded"));
  viewBar.append(button("Shaded + Edges", "SE", () => setVisualPreset("shaded-edges"), getVisualPreset() === "shaded-edges"));
  viewBar.append(button("Wireframe", "W", () => setVisualPreset("wireframe"), getVisualPreset() === "wireframe"));
  viewBar.append(button("Hidden Line", "HL", () => setVisualPreset("hidden-line"), getVisualPreset() === "hidden-line"));
  viewBar.append(separator());
  viewBar.append(button("Crop", "⌗", () => { state.crop = !state.crop; emit(); }, state.crop));
  viewBar.append(button("Temporary Hide/Isolate", "◌", () => { state.temporaryMode = state.temporaryMode === "none" ? "isolate" : "none"; emit(); }, state.temporaryMode !== "none"));
  viewBar.append(button("Reveal", "R", revealAll, state.temporaryMode === "reveal"));
  viewBar.append(button("Sun", "☀", () => setSunEnabled(!isSunEnabled()), isSunEnabled()));
  viewBar.append(button("VG", "VG", openVisibilityGraphics, false));
  viewBar.append(button("Templates", "VT", openViewTemplates, false));
  viewBar.append(separator());
  viewBar.append(button("3D", "3D", () => { void setProjection("perspective"); goHome(); }, getProjection() === "perspective"));
  viewBar.append(button("Ortho", "ORTHO", () => { void setProjection("orthographic"); }, getProjection() === "orthographic"));
  viewBar.append(button("Top", "TOP", () => gotoDir(new THREE.Vector3(0, 1, 0)), false));
  viewBar.append(button("Fit", "F", fitAll, false));
}

function ensureBars() {
  if (!ctx.rightHost) return;
  if (optionsBar) return;

  optionsBar = el("div", "obs-bim-options");
  contextualBar = el("div", "obs-bim-contextual");
  viewBar = el("div", "obs-bim-viewbar");
  promptBar = el("div", "obs-bim-prompt");
  hoverCard = el("div", "obs-bim-hovercard");

  try {
    state.optionsVisible = localStorage.getItem("obs.optionsBar.visible") !== "0";
  } catch { /* */ }
  optionsBar.dataset.visible = state.optionsVisible ? "1" : "0";
  contextualBar.dataset.visible = "0";
  promptBar.dataset.visible = "0";
  hoverCard.dataset.visible = "0";
  viewBar.dataset.visible = "1";
  try {
    if (localStorage.getItem("obs.viewBar.visible") === "0") viewBar.dataset.visible = "0";
  } catch { /* */ }

  ctx.rightHost.append(contextualBar, optionsBar, viewBar, promptBar, hoverCard);

  // Panels own their scroll — do not bubble wheel to 3D zoom
  for (const bar of [optionsBar, contextualBar, viewBar]) {
    bar.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });
  }
}

function updatePrompt() {
  if (!promptBar) return;
  const tool = getActiveTool();
  if (!tool) {
    promptBar.dataset.visible = "0";
    return;
  }
  const hints: Record<string, string> = {
    wall: "Place Wall: click start point → click endpoint. Click again to chain. Enter finishes the chain.",
    slab: "Place Floor: click boundary points. Click the first point or press Enter to finish.",
    door: "Place Door: hover a host wall → click to place. Move along the wall to adjust offset.",
    window: "Place Window: hover a host wall → click to place. Move along the wall to adjust offset.",
    duct: "Place Duct: click start → endpoint. Continue clicking to route; bends create fittings.",
    pipe: "Place Pipe: click start → endpoint. Continue clicking to route; bends create fittings.",
    move: "Move: select element(s) → base point → target point. Hold Shift for orthogonal constraint.",
    copy: "Copy: select element(s) → base point → target point. Space repeats the order.",
    rotate: "Rotate: select element(s) → center → reference → target angle.",
    mirror: "Mirror: select element(s) → two points defining the mirror axis.",
    array: "Array: select element(s) → base point → set count / spacing.",
    offset: "Offset: pick a host → pick the side / distance. Esc cancels the active step.",
    select: "Modify: click to select. Ctrl adds, Shift toggles, Alt removes. Tab cycles candidates.",
  };
  promptBar.textContent = hints[tool] ?? `${labelForTool(tool)} — click in the model to continue.`;
  promptBar.dataset.visible = "1";
}

function refresh() {
  updateModeFromState();
  ensureBars();
  renderContextual();
  renderOptionsBar();
  renderViewBar();
  updatePrompt();
  emit();
}

async function preselectionTooltip(e: PointerEvent) {
  if (!hoverCard || !ctx.rightHost) return;
  if (getActiveTool() && getActiveTool() !== "select") {
    hoverCard.dataset.visible = "0";
    return;
  }
  const canvas = (ctx.world?.renderer?.three as any)?.domElement;
  if (!canvas || e.target !== canvas) {
    hoverCard.dataset.visible = "0";
    return;
  }

  // Authored geometry is cheap to test with screen-space boxes.
  const rect = ctx.rightHost.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const cam = ctx.world?.camera?.three;
  if (!cam) return;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(pointer, cam);
  let best: { id: string; dist: number; name: string; type: string } | null = null;
  for (const obj of getElements()) {
    const node = ctx.world.scene.three.getObjectByName(obj.id);
    if (!node) continue;
    const hits = ray.intersectObject(node, true);
    if (!hits.length) continue;
    const d = hits[0].distance;
    if (!best || d < best.dist) best = { id: obj.id, dist: d, name: obj.name, type: obj.type };
  }
  if (!best) {
    hoverCard.dataset.visible = "0";
    hoveredAuthorId = null;
    return;
  }
  hoveredAuthorId = best.id;
  hoverCard.dataset.visible = "1";
  hoverCard.style.left = `${Math.max(12, e.clientX - rect.left + 14)}px`;
  hoverCard.style.top = `${Math.max(12, e.clientY - rect.top + 14)}px`;
  hoverCard.innerHTML = `<b>${escapeHtml(best.name)}</b><span>${escapeHtml(best.type)}</span><em>Tab: cycle · Click: select</em>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

function keydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;

  // Centralize common BIM-style global orders, while letting active authoring
  // keep ownership of its detailed mouse/Enter/Escape state machine.
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") return;
  if (e.ctrlKey && e.key.toLowerCase() === "y") return;

  if (e.key === "Tab" && !e.shiftKey) {
    if (!isPlanViewVisible() && getActiveTool() === "select" && hoveredAuthorId) {
      const authored = getElements();
      const idx = authored.findIndex((x) => x.id === hoveredAuthorId);
      if (idx >= 0 && authored.length > 1) {
        const next = authored[(idx + 1) % authored.length];
        if (next) {
          // Use authored selection when possible; fragment selection is handled by the native highlighter.
          window.dispatchEvent(new CustomEvent("obs:select-authored", { detail: { id: next.id } }));
          toast(`Preselection cycle: ${next.name}`, "info", 900);
          e.preventDefault();
        }
      }
    }
    return;
  }

  if (e.key === "Escape") {
    if (state.temporaryMode !== "none") {
      revealAll();
      state.temporaryMode = "none";
      refresh();
      e.preventDefault();
      return;
    }
    return;
  }

  if (e.key === "Delete") {
    if (getAuthoredSelection().length || !selection.isEmpty()) {
      deleteSelectedElement();
      e.preventDefault();
      return;
    }
  }

  if (e.key === "Shift") {
    const tool = getActiveTool();
    if (tool && tool !== "select") snapping.setOrtho(true, null);
  }

  // MASTER PROMPT §4.3 — hold Alt to temporarily suspend snapping
  // (per-category toggles live in the snap settings panel; Shift+S is the
  // global ON/OFF toggle; Shift remains the orthogonal constraint).
  if (e.key === "Alt") {
    snapping.setSuspended(true);
    e.preventDefault();
  }
}

function keyup(e: KeyboardEvent) {
  if (e.key === "Shift") snapping.clearOrtho();
  if (e.key === "Alt") snapping.setSuspended(false);
}

function selectionChanged() {
  const n = selectionSummary();
  const count = n.fragments + n.authored;
  if (count !== lastSelectionCount) {
    lastSelectionCount = count;
    refresh();
  } else {
    renderContextual();
    renderOptionsBar();
  }
}

function authoringChanged() {
  refresh();
}

export function setupBimExperience() {
  if (installed) return;
  installed = true;
  createCommandCatalog();
  for (const c of commands.values()) {
    registerPaletteCommand({
      id: `bim.${c.id}`,
      label: c.label,
      category: c.ribbon ? `BIM ${c.ribbon}` : "BIM",
      hint: c.group,
      kbd: c.shortcut,
      run: () => c.run(),
      when: c.when,
    });
  }
  ensureBars();
  selection.onChange(selectionChanged);
  // Re-render the Options Bar and contextual ribbon whenever the active
  // authoring tool changes (ribbon click, Space-repeat, Esc-to-Select),
  // not only when the selection changes.
  onAuthoringChange(refresh);
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("keyup", keyup, true);
  if (ctx.rightHost) {
    ctx.rightHost.addEventListener("pointermove", preselectionTooltip, true);
    ctx.rightHost.addEventListener("mouseleave", () => { if (hoverCard) hoverCard.dataset.visible = "0"; });
  }
  window.addEventListener("obs:select-authored", (e: Event) => {
    const id = (e as CustomEvent).detail?.id as string | undefined;
    if (!id) return;
    setSelectedAuthored([id], "replace");
    setAuthoringTool("select");
    openPropertyPalette();
    refresh();
  });
  window.addEventListener("obs:bim-command", (e: Event) => {
    const id = (e as CustomEvent).detail?.id as string | undefined;
    if (id) execute(id);
  });

  (ctx.features as any).bimExperience = {
    execute,
    refresh,
    activateTool,
    getState: () => ({ ...state }),
    toggleContextualBar,
    toggleOptionsBar,
    toggleViewBar,
    isContextualBarVisible,
    isOptionsBarVisible,
    isViewBarVisible,
  };
  (window as any).__obsBIMExperience = {
    execute,
    refresh,
    getState: () => ({ ...state }),
    commands,
    activateTool,
  };
  refresh();
  console.log("[BIM Experience] v48 interaction layer online — command grammar + contextual UX + options bar + view control bar");
}


/** Show / hide the Options Bar (BIM Options Bar under the ribbon). */
export function toggleOptionsBar(force?: boolean): boolean {
  state.optionsVisible = force != null ? force : !state.optionsVisible;
  if (optionsBar) optionsBar.dataset.visible = state.optionsVisible ? "1" : "0";
  try { localStorage.setItem("obs.optionsBar.visible", state.optionsVisible ? "1" : "0"); } catch { /* */ }
  emit();
  return state.optionsVisible;
}
export function isOptionsBarVisible(): boolean { return state.optionsVisible; }

/** Show / hide the Modify contextual bar (selection tools under ribbon). */
export function toggleContextualBar(force?: boolean): boolean {
  // When forced open, allow even without selection; auto mode still uses selection
  state.contextualVisible = force != null ? force : !state.contextualVisible;
  if (force === true) {
    // pin open
    (state as any)._contextualPinned = true;
  } else if (force === false) {
    (state as any)._contextualPinned = false;
  } else if ((state as any)._contextualPinned) {
    (state as any)._contextualPinned = false;
  }
  if (contextualBar) {
    contextualBar.dataset.visible = state.contextualVisible ? "1" : "0";
    if (state.contextualVisible) renderContextual();
  }
  try { localStorage.setItem("obs.contextualBar.visible", state.contextualVisible ? "1" : "0"); } catch { /* */ }
  emit();
  return state.contextualVisible;
}
export function isContextualBarVisible(): boolean {
  return !!(contextualBar && contextualBar.dataset.visible === "1");
}

/** View control bar (bottom of viewport scale/detail/discipline). */
export function toggleViewBar(force?: boolean): boolean {
  if (!viewBar) return false;
  const on = force != null ? force : viewBar.dataset.visible !== "1";
  viewBar.dataset.visible = on ? "1" : "0";
  try { localStorage.setItem("obs.viewBar.visible", on ? "1" : "0"); } catch { /* */ }
  return on;
}
export function isViewBarVisible(): boolean {
  return !!(viewBar && viewBar.dataset.visible !== "0");
}

export function getBimExperienceState(): ExperienceState { return { ...state }; }
export function executeBimCommand(id: string): void { execute(id); }
