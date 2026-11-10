/**
 * Unified Selection & Snapping palette.
 *
 * Keeps the established selection and snap engines as the sources of truth;
 * this module provides a persistent drafting-profile layer and one UI surface.
 */
import { selection } from "./selection";
import { snapping, type SnapType } from "./snapping";
import { getSelectionPrefs, setSelectionPref } from "../core/selection-prefs";

type DraftingProfile = {
  id: string;
  name: string;
  snapEnabled: boolean;
  snapTypes: SnapType[];
  priorities: Partial<Record<SnapType, number>>;
  gridSize: number;
  tolerance: number;
  selectLinks: boolean;
  selectPinned: boolean;
  categories: string[];
};

const STORAGE_KEY = "obs.drafting-profiles.v1";
const ACTIVE_KEY = "obs.drafting-profile-active.v1";
const BUILTIN: DraftingProfile[] = [
  { id: "architectural", name: "Architectural", snapEnabled: true, snapTypes: ["endpoint","intersection","midpoint","center","perpendicular","nearest","grid","corner","vertex"], priorities: { endpoint:100, intersection:98, corner:95, midpoint:90, center:85, perpendicular:82, nearest:55, grid:20 }, gridSize:0.01, tolerance:16, selectLinks:true, selectPinned:true, categories:[] },
  { id: "structural", name: "Structural", snapEnabled: true, snapTypes: ["endpoint","intersection","midpoint","center","nearest","grid","vertex","face"], priorities: { endpoint:100, intersection:98, midpoint:92, center:86, vertex:80, face:65, nearest:55, grid:20 }, gridSize:0.01, tolerance:18, selectLinks:true, selectPinned:true, categories:[] },
  { id: "mep", name: "MEP Coordination", snapEnabled: true, snapTypes: ["endpoint","intersection","connector","midpoint","center","perpendicular","nearest","grid"], priorities: { connector:105, endpoint:100, intersection:98, midpoint:90, perpendicular:85, center:80, nearest:55, grid:15 }, gridSize:0.005, tolerance:20, selectLinks:true, selectPinned:true, categories:[] },
  { id: "precision", name: "Precision Drafting", snapEnabled: true, snapTypes: ["endpoint","intersection","midpoint","center","perpendicular","tangent","quadrant","vertex","nearest"], priorities: { endpoint:110, intersection:105, midpoint:95, center:90, perpendicular:88, tangent:85, quadrant:80, vertex:78, nearest:50 }, gridSize:0.001, tolerance:10, selectLinks:false, selectPinned:true, categories:[] },
];

function safeReadProfiles(): DraftingProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is DraftingProfile =>
      !!p && typeof p.id === "string" && typeof p.name === "string" &&
      Array.isArray(p.snapTypes) && Number.isFinite(p.gridSize) &&
      Number.isFinite(p.tolerance) && Array.isArray(p.categories));
  } catch { return []; }
}
function persistProfiles(profiles: DraftingProfile[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles)); } catch { /* storage may be unavailable */ }
}
function cloneProfile(p: DraftingProfile): DraftingProfile {
  return { ...p, snapTypes: [...p.snapTypes], priorities: { ...p.priorities }, categories: [...p.categories] };
}

let panel: HTMLDivElement | null = null;
let visible = false;
let activeProfileId = "architectural";
let customProfiles = safeReadProfiles();

function currentProfile(): DraftingProfile {
  const prefs = getSelectionPrefs();
  return {
    id: "current", name: "Current settings", snapEnabled: snapping.isEnabled(),
    snapTypes: snapping.getTypes(), priorities: snapping.getPriorities(),
    gridSize: snapping.getGridSize(), tolerance: snapping.getPixelTolerance(),
    selectLinks: prefs.links, selectPinned: prefs.pinned,
    categories: selection.getFilter() ?? [],
  };
}

function applyProfile(profile: DraftingProfile): void {
  snapping.setEnabled(profile.snapEnabled);
  snapping.setTypes(profile.snapTypes);
  snapping.setPriorities(profile.priorities);
  snapping.setGridSize(profile.gridSize);
  snapping.setPixelTolerance(profile.tolerance);
  setSelectionPref("links", profile.selectLinks);
  setSelectionPref("pinned", profile.selectPinned);
  selection.setFilter(profile.categories.length ? profile.categories : null);
  activeProfileId = profile.id;
  try { localStorage.setItem(ACTIVE_KEY, activeProfileId); } catch { /* */ }
  render();
}

function allProfiles(): DraftingProfile[] {
  return [...BUILTIN, ...customProfiles];
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function style(node: HTMLElement, css: string): void { node.style.cssText = css; }
function button(label: string, action: () => void): HTMLButtonElement {
  const b = el("button", label);
  b.type = "button";
  style(b, "background:#263449;border:1px solid #40516a;color:#e8eef8;border-radius:6px;padding:6px 9px;cursor:pointer;font:inherit");
  b.addEventListener("click", action);
  return b;
}
function fieldLabel(label: string, control: HTMLElement): HTMLLabelElement {
  const wrap = el("label");
  style(wrap, "display:flex;align-items:center;justify-content:space-between;gap:10px;margin:7px 0;color:#cbd5e1");
  wrap.append(el("span", label), control);
  return wrap;
}
function numeric(value: number, min: number, max: number, step: number, onChange: (n:number)=>void): HTMLInputElement {
  const input = el("input");
  input.type = "number"; input.value = String(value); input.min = String(min); input.max = String(max); input.step = String(step);
  style(input, "width:92px;background:#111c2b;border:1px solid #40516a;color:#f1f5f9;border-radius:5px;padding:5px");
  input.addEventListener("change", () => onChange(Math.max(min, Math.min(max, Number(input.value)))));
  return input;
}
function checkbox(label: string, checked: boolean, onChange: (v:boolean)=>void): HTMLLabelElement {
  const wrap = el("label");
  style(wrap, "display:flex;align-items:center;gap:7px;padding:4px 2px;color:#dbe5f3;cursor:pointer");
  const input = el("input"); input.type = "checkbox"; input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  wrap.append(input, el("span", label));
  return wrap;
}
function section(title: string): HTMLDivElement {
  const s = el("section");
  style(s, "border-top:1px solid #34445a;padding-top:10px;margin-top:10px");
  const h = el("div", title.toUpperCase());
  style(h, "font-size:10px;letter-spacing:.09em;color:#8fa5c1;font-weight:700;margin-bottom:7px");
  s.append(h);
  return s;
}

function render(): void {
  if (!panel) return;
  panel.replaceChildren();
  const header = el("div");
  style(header, "display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #34445a");
  const title = el("strong", "Selection & Snapping");
  style(title, "font-size:13px;color:#f8fafc");
  header.append(title, button("×", () => setSelectionSnappingPaletteVisible(false)));
  panel.append(header);

  const body = el("div");
  style(body, "padding:12px 14px;max-height:min(72vh,680px);overflow:auto");
  const profiles = section("Drafting profile");
  const select = el("select");
  style(select, "flex:1;min-width:0;background:#111c2b;border:1px solid #40516a;color:#f1f5f9;border-radius:5px;padding:6px");
  for (const p of allProfiles()) {
    const option = el("option", p.name); option.value = p.id; option.selected = p.id === activeProfileId; select.append(option);
  }
  select.addEventListener("change", () => {
    const chosen = allProfiles().find(p => p.id === select.value);
    if (chosen) applyProfile(cloneProfile(chosen));
  });
  profiles.append(fieldLabel("Profile", select));
  const profileActions = el("div");
  style(profileActions, "display:flex;gap:6px;margin-top:8px");
  profileActions.append(button("Save current as…", () => {
    const name = window.prompt("Name this drafting profile");
    if (!name?.trim()) return;
    const id = "custom-" + Date.now().toString(36);
    customProfiles = [{ ...currentProfile(), id, name: name.trim() }, ...customProfiles];
    persistProfiles(customProfiles); activeProfileId = id; render();
  }), button("Delete custom", () => {
    if (!activeProfileId.startsWith("custom-")) return;
    customProfiles = customProfiles.filter(p => p.id !== activeProfileId);
    persistProfiles(customProfiles); activeProfileId = "architectural"; applyProfile(cloneProfile(BUILTIN[0]));
  }));
  profiles.append(profileActions);
  body.append(profiles);

  const selectionSection = section("Selection filters");
  const prefs = getSelectionPrefs();
  selectionSection.append(
    checkbox("Allow linked-model selection", prefs.links, v => setSelectionPref("links", v)),
    checkbox("Allow pinned-element selection", prefs.pinned, v => setSelectionPref("pinned", v)),
  );
  const category = el("input");
  category.type = "text"; category.placeholder = "e.g. IfcWall, IfcDoor (blank = all)";
  category.value = (selection.getFilter() ?? []).join(", ");
  style(category, "width:100%;box-sizing:border-box;background:#111c2b;border:1px solid #40516a;color:#f1f5f9;border-radius:5px;padding:7px");
  category.addEventListener("change", () => selection.setFilter(category.value.split(",").map(x=>x.trim()).filter(Boolean)));
  selectionSection.append(fieldLabel("IFC categories", category));
  body.append(selectionSection);

  const snapSection = section("Object snaps");
  snapSection.append(checkbox("Enable object snapping", snapping.isEnabled(), v => { snapping.setEnabled(v); render(); }));
  const grid = numeric(snapping.getGridSize(), 0.001, 10000, 0.001, v => snapping.setGridSize(v));
  const tolerance = numeric(snapping.getPixelTolerance(), 4, 100, 1, v => snapping.setPixelTolerance(v));
  snapSection.append(fieldLabel("Grid spacing (m)", grid), fieldLabel("Pick tolerance (px)", tolerance));
  const typesGrid = el("div");
  style(typesGrid, "display:grid;grid-template-columns:1fr 1fr;gap:1px 8px");
  const active = new Set(snapping.getTypes());
  for (const type of snapping.getAllTypes()) {
    typesGrid.append(checkbox(type[0].toUpperCase()+type.slice(1), active.has(type), v => { snapping.toggleType(type, v); }));
  }
  snapSection.append(typesGrid);
  body.append(snapSection);

  const priorities = section("Snap priority");
  const priorityGrid = el("div");
  style(priorityGrid, "display:grid;grid-template-columns:1fr 1fr;gap:4px 12px");
  const priorityValues = snapping.getPriorities();
  for (const type of snapping.getAllTypes()) {
    priorityGrid.append(fieldLabel(type, numeric(priorityValues[type], 0, 1000, 1, v => snapping.setPriority(type, v))));
  }
  priorities.append(priorityGrid);
  body.append(priorities);

  const footer = el("div");
  style(footer, "display:flex;justify-content:space-between;gap:8px;margin-top:12px");
  footer.append(button("Reset profile", () => applyProfile(cloneProfile(BUILTIN[0]))), button("Close", () => setSelectionSnappingPaletteVisible(false)));
  body.append(footer);
  panel.append(body);
}

function ensurePanel(): void {
  if (panel) return;
  panel = el("div");
  panel.id = "obs-selection-snapping-palette";
  style(panel, "position:fixed;left:16px;bottom:54px;width:min(390px,calc(100vw - 32px));max-height:78vh;z-index:9000;display:none;background:#182334;color:#e2e8f0;border:1px solid #40516a;border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.45);font:12px/1.45 system-ui,sans-serif");
  document.body.append(panel);
}

export function isSelectionSnappingPaletteVisible(): boolean { return visible; }
export function toggleSelectionSnappingPalette(): void { setSelectionSnappingPaletteVisible(!visible); }
export function setSelectionSnappingPaletteVisible(on: boolean): void {
  visible = on; ensurePanel();
  if (!panel) return;
  panel.style.display = on ? "block" : "none";
  if (on) render();
}

export function setupSelectionSnappingPalette(): void {
  try { activeProfileId = localStorage.getItem(ACTIVE_KEY) || "architectural"; } catch { /* */ }
  const initial = allProfiles().find(p => p.id === activeProfileId);
  if (initial) applyProfile(cloneProfile(initial));
  ensurePanel();
  window.addEventListener("keydown", e => {
    const target = e.target as HTMLElement | null;
    const editing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (e.key === "Alt" && !editing) snapping.setSuspended(true);
    if (editing) return;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault(); toggleSelectionSnappingPalette();
    }
  }, true);
  window.addEventListener("keyup", e => { if (e.key === "Alt") snapping.setSuspended(false); }, true);
  window.addEventListener("blur", () => snapping.setSuspended(false));
}
