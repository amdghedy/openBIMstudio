/**
 * Command Palette — VSCode-style fuzzy command launcher.
 *
 *   Ctrl+P       open
 *   Type         fuzzy filter across label + category + hint
 *   ↑ / ↓        navigate
 *   Enter        run selected command
 *   Esc          close
 *
 * Commands are contributed by any module via `registerCommand()`; the palette
 * itself ships a bootstrap list of application commands on first setup.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { services } from "../core/services";
import { notify } from "../core/notify";
import {
  fitAll, goHome, gotoDir, takeScreenshot, setProjection, getProjection,
  recenterSceneNow, alignOriginToOrigin, resetOffsets,
} from "./camera-tools";
import { toggleMeasure, isMeasureEnabled } from "./measure";
import { toggleSection, isSectionOn } from "./section";
import { toggleIssuesPanel, isIssuesPanelVisible } from "./issues-panel";
import { toggleCostPanel, isCostPanelVisible, recalculateTakeoff } from "./cost-panel";
import { toggleIdsPanel, isIdsPanelVisible } from "./ids-panel";
import { toggleModelTreePanel, isModelTreePanelVisible } from "./model-tree-panel";
import { togglePlanView, isPlanViewVisible } from "./plan-view-panel";
import { toggleSchedules, isSchedulesVisible } from "./schedules-panel";
import { toggleWalkMode, isWalkModeEnabled } from "./walk-mode";
import { toggleSavedViewsPanel, isSavedViewsPanelVisible } from "./saved-views";
import {
  setAuthoringTool, getActiveTool,
  deleteSelectedElement, clearAllElements,
} from "./authoring";
import {
  runElementClashDetection, clearClash,
} from "./clash";
import { history } from "./history";
import { selection } from "./selection";
import { saveProject, createProject, getCurrentProject } from "../modules/projects/projects";
import { showHome } from "../shell/home-screen";
import { pickAndImport } from "./file-interop";

/* ═════════════════════════════════════════════════════════════════════════
   Types
   ═════════════════════════════════════════════════════════════════════════ */
export interface PaletteCommand {
  id: string;
  label: string;
  category?: string;
  hint?: string;
  kbd?: string;
  run: () => unknown;
  /** Return false to hide the command in the current state. */
  when?: () => boolean;
}

interface Ranked {
  cmd: PaletteCommand;
  score: number;
}

/* ═════════════════════════════════════════════════════════════════════════
   Fuzzy matcher — simple subsequence score
   ═════════════════════════════════════════════════════════════════════════ */
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  if (!q) return 1;
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi++;
      streak++;
      score += 2 + streak;
      // Bonus: word boundary
      if (i === 0 || /[\s\-_./]/.test(t[i - 1])) score += 6;
    } else {
      streak = 0;
      score -= 0.2;
    }
  }
  return qi < q.length ? -1 : score;
}

/* ═════════════════════════════════════════════════════════════════════════
   Registry
   ═════════════════════════════════════════════════════════════════════════ */
const commands = new Map<string, PaletteCommand>();

export function registerCommand(cmd: PaletteCommand): void {
  commands.set(cmd.id, cmd);
}
export function unregisterCommand(id: string): void {
  commands.delete(id);
}
export function listCommands(): PaletteCommand[] {
  return [...commands.values()];
}

/* ═════════════════════════════════════════════════════════════════════════
   DOM
   ═════════════════════════════════════════════════════════════════════════ */
let root: HTMLDivElement | null = null;
let input: HTMLInputElement | null = null;
let listEl: HTMLDivElement | null = null;
let results: Ranked[] = [];
let activeIndex = 0;
let open = false;

const T_BTN =
  "display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:6px;" +
  "cursor:pointer;font:12px/1.35 system-ui,sans-serif;color:inherit";

function ensureDOM(): void {
  if (root) return;

  root = document.createElement("div");
  root.id = "obs-command-palette";
  root.style.cssText =
    "position:fixed;inset:0;z-index:9500;display:none;align-items:flex-start;" +
    "justify-content:center;padding-top:14vh;background:rgba(8,9,12,.55);" +
    "backdrop-filter:blur(3px)";

  const card = document.createElement("div");
  card.style.cssText =
    "width:min(640px,92vw);background:var(--bg-floating,#1c1e28);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
    "box-shadow:0 30px 80px rgba(0,0,0,.55);overflow:hidden;" +
    "display:flex;flex-direction:column";

  const inputWrap = document.createElement("div");
  inputWrap.style.cssText =
    "display:flex;align-items:center;gap:10px;padding:12px 14px;" +
    "border-bottom:1px solid var(--border-subtle,#1e2029)";

  const searchIcon = document.createElement("div");
  searchIcon.style.cssText = "color:var(--text-tertiary,#6b7280);display:flex";
  searchIcon.innerHTML =
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<circle cx="11" cy="11" r="7"/><path d="M20 20 L16.65 16.65"/></svg>`;

  input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type a command…  (e.g. wall, clash, export)";
  input.style.cssText =
    "flex:1;background:transparent;border:none;outline:none;color:" +
    "var(--text-primary,#e8eaf0);font:14px/1.3 system-ui,sans-serif";
  input.autocomplete = "off";
  input.spellcheck = false;

  inputWrap.append(searchIcon, input);

  listEl = document.createElement("div");
  listEl.style.cssText =
    "max-height:52vh;overflow-y:auto;padding:6px;display:flex;" +
    "flex-direction:column;gap:2px";

  card.append(inputWrap, listEl);
  root.appendChild(card);

  // Click outside closes.
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) closePalette();
  });

  document.body.appendChild(root);

  input.addEventListener("input", () => updateResults());
  input.addEventListener("keydown", onInputKeyDown);
}

/* ═════════════════════════════════════════════════════════════════════════
   Filtering + rendering
   ═════════════════════════════════════════════════════════════════════════ */
function filterCommands(query: string): Ranked[] {
  const out: Ranked[] = [];
  for (const cmd of commands.values()) {
    if (cmd.when && !cmd.when()) continue;
    const haystack = `${cmd.label} ${cmd.category ?? ""} ${cmd.hint ?? ""}`;
    const score = query ? fuzzyScore(query, haystack) : 1;
    if (score >= 0) out.push({ cmd, score });
  }
  out.sort((a, b) => b.score - a.score || a.cmd.label.localeCompare(b.cmd.label));
  return out.slice(0, 40);
}

function renderResults(): void {
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!results.length) {
    const empty = document.createElement("div");
    empty.style.cssText =
      "padding:20px;text-align:center;color:var(--text-tertiary,#6b7280);" +
      "font:12px/1.5 system-ui,sans-serif";
    empty.textContent = "No matching commands.";
    listEl.appendChild(empty);
    return;
  }

  for (let i = 0; i < results.length; i++) {
    const { cmd } = results[i];
    const row = document.createElement("div");
    row.style.cssText =
      T_BTN +
      (i === activeIndex
        ? ";background:var(--accent-dim,rgba(56,189,248,.14));color:var(--accent,#38bdf8)"
        : "");
    row.onmouseenter = () => {
      if (activeIndex === i) return;
      activeIndex = i;
      renderResults();
    };
    row.onclick = () => execute(i);

    const label = document.createElement("div");
    label.style.cssText = "flex:1;display:flex;flex-direction:column;gap:1px";
    const top = document.createElement("div");
    top.style.cssText = "font-weight:600";
    top.textContent = cmd.label;
    label.appendChild(top);
    if (cmd.category) {
      const cat = document.createElement("div");
      cat.style.cssText = "font-size:10.5px;opacity:.65;letter-spacing:.2px";
      cat.textContent = cmd.hint ? `${cmd.category} · ${cmd.hint}` : cmd.category;
      label.appendChild(cat);
    }

    row.appendChild(label);

    if (cmd.kbd) {
      const k = document.createElement("div");
      k.style.cssText =
        "font:10px/1 var(--font-mono,monospace);padding:3px 6px;border-radius:4px;" +
        "background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);" +
        "color:var(--text-tertiary,#6b7280)";
      k.textContent = cmd.kbd;
      row.appendChild(k);
    }

    listEl.appendChild(row);
  }
}

function updateResults(): void {
  if (!input) return;
  results = filterCommands(input.value);
  activeIndex = 0;
  renderResults();
}

async function execute(index: number): Promise<void> {
  const r = results[index];
  if (!r) return;
  closePalette();
  try {
    await r.cmd.run();
  } catch (err) {
    console.error("[palette] command failed", r.cmd.id, err);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Keyboard
   ═════════════════════════════════════════════════════════════════════════ */
function onInputKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closePalette();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex = (activeIndex + 1) % Math.max(1, results.length);
    renderResults();
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex = (activeIndex - 1 + results.length) % Math.max(1, results.length);
    renderResults();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    void execute(activeIndex);
    return;
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Public
   ═════════════════════════════════════════════════════════════════════════ */
export function isCommandPaletteOpen(): boolean {
  return open;
}

export function openPalette(): void {
  ensureDOM();
  if (!root || !input) return;
  open = true;
  root.style.display = "flex";
  input.value = "";
  results = filterCommands("");
  activeIndex = 0;
  renderResults();
  requestAnimationFrame(() => input?.focus());
}

export function closePalette(): void {
  if (!root) return;
  open = false;
  root.style.display = "none";
}

export function togglePalette(): void {
  open ? closePalette() : openPalette();
}

/* ═════════════════════════════════════════════════════════════════════════
   Bootstrap commands
   ═════════════════════════════════════════════════════════════════════════ */
function bootstrapCommands(): void {
  // Project
  registerCommand({ id: "project.save", label: "Save project", category: "Project", kbd: "Ctrl+S", run: () => void saveProject() });
  registerCommand({ id: "project.new", label: "New project", category: "Project", kbd: "Ctrl+N", run: () => {
    const name = prompt("New project name:", "Untitled");
    if (name == null) return;
    void createProject(name.trim() || "Untitled");
  }});
  registerCommand({ id: "project.home", label: "Home screen", category: "Project", kbd: "Ctrl+H", run: () => showHome() });
  registerCommand({ id: "project.open", label: "Open any file…", category: "Project", kbd: "Ctrl+O", run: () => void pickAndImport() });

  // Tools
  const tool = (name: string, tool: string, kbd?: string) =>
    registerCommand({
      id: `tool.${tool}`,
      label: `Tool: ${name}`,
      category: "Authoring tools",
      kbd,
      run: () => setAuthoringTool(tool as any),
      when: () => getActiveTool() !== (tool as any),
    });

  tool("Wall", "wall", "WA");
  tool("Slab / Floor", "slab", "SL");
  tool("Column", "column", "CM");
  tool("Beam", "beam", "BM");
  tool("Brace", "brace", "BR");
  tool("Truss", "truss", "TR");
  tool("Isolated Footing", "footing", "FT");
  tool("Strip Footing", "strip", "SF");
  tool("Door", "door", "DR");
  tool("Window", "window", "WN");
  tool("Duct", "duct", "DU");
  tool("Pipe", "pipe", "PP");
  tool("Cable Tray", "cable-tray");
  tool("Conduit", "conduit");
  tool("Equipment", "equipment");
  tool("Grid", "grid", "GR");
  tool("Level", "level", "LV");
  tool("Move", "move", "G");
  tool("Copy", "copy");
  tool("Rotate", "rotate", "R");
  tool("Mirror", "mirror");
  tool("Array", "array");
  tool("Offset", "offset");

  // Deactivate any active tool
  registerCommand({
    id: "tool.none",
    label: "Cancel active tool",
    category: "Authoring tools",
    kbd: "Esc",
    run: () => setAuthoringTool(null),
    when: () => getActiveTool() !== null,
  });

  // Edit
  registerCommand({ id: "edit.undo", label: "Undo", category: "Edit", kbd: "Ctrl+Z", run: () => void history.undo(), when: () => history.canUndo() });
  registerCommand({ id: "edit.redo", label: "Redo", category: "Edit", kbd: "Ctrl+Y", run: () => void history.redo(), when: () => history.canRedo() });
  registerCommand({ id: "edit.selectAll", label: "Select all elements", category: "Edit", kbd: "Ctrl+A", run: () => void selection.selectAll() });
  registerCommand({ id: "edit.clearSelection", label: "Clear selection", category: "Edit", run: async () => { selection.clear(); await selection.applyToHighlighter(); }, when: () => !selection.isEmpty() });
  registerCommand({ id: "edit.delete", label: "Delete selected authored elements", category: "Edit", kbd: "Del", run: () => deleteSelectedElement() });
  registerCommand({ id: "edit.clearAll", label: "Clear all authored elements", category: "Edit", run: () => clearAllElements() });

  // View
  registerCommand({ id: "view.fit", label: "Fit to view", category: "View", kbd: "F", run: () => fitAll() });
  registerCommand({ id: "view.home", label: "Go to home view", category: "View", kbd: "H", run: () => goHome() });
  registerCommand({ id: "view.top", label: "Top view", category: "View", run: () => gotoDir(new THREE.Vector3(0, 1, 0)) });
  registerCommand({ id: "view.front", label: "Front view", category: "View", run: () => gotoDir(new THREE.Vector3(0, 0, 1)) });
  registerCommand({ id: "view.isoNE", label: "Isometric NE", category: "View", run: () => gotoDir(new THREE.Vector3(1, 0.7, -1)) });
  registerCommand({ id: "view.isoNW", label: "Isometric NW", category: "View", run: () => gotoDir(new THREE.Vector3(-1, 0.7, -1)) });
  registerCommand({ id: "view.perspective", label: "Perspective view", category: "View", run: () => setProjection("perspective"), when: () => getProjection() !== "perspective" });
  registerCommand({ id: "view.ortho", label: "Orthographic view", category: "View", run: () => setProjection("orthographic"), when: () => getProjection() !== "orthographic" });
  registerCommand({ id: "view.screenshot", label: "Take screenshot", category: "View", run: () => takeScreenshot() });

  // Tools
  registerCommand({ id: "tools.measure", label: toggleLabel("Measure", isMeasureEnabled), category: "Tools", kbd: "M", run: () => toggleMeasure() });
  registerCommand({ id: "tools.section", label: toggleLabel("Section plane", isSectionOn), category: "Tools", run: () => toggleSection() });
  registerCommand({ id: "annotate.auto-dim", label: "Auto Dimension (pick first and last edge)", category: "Annotate", run: () => {
    try {
      const pv: any = (ctx.features as any).planView;
      if (!isPlanViewVisible()) togglePlanView();
      setTimeout(() => pv?.setTool?.("auto-dim"), 60);
    } catch { /* */ }
  } });
  registerCommand({ id: "file.save-to-file", label: "Save project to file (.obsproj)", category: "File", run: () => { void import("../modules/projects/project-file-io").then((m) => m.saveProjectToFile(false)); } });
  registerCommand({ id: "file.save-as-file", label: "Save project as new file (copy / backup)", category: "File", run: () => { void import("../modules/projects/project-file-io").then((m) => m.saveProjectToFile(true)); } });
  registerCommand({ id: "file.open-file", label: "Open project from file (.obsproj)", category: "File", run: () => { void import("../modules/projects/project-file-io").then((m) => m.openProjectFromFile()); } });
  registerCommand({ id: "tools.walk", label: toggleLabel("Walk mode", isWalkModeEnabled), category: "Tools", run: () => toggleWalkMode() });
  registerCommand({
    id: "tools.moveConnectedMep",
    label: toggleLabel("Move connected MEP parts together", () => { try { return (window as any).__obsMoveConnected !== false; } catch { return true; } }),
    category: "Tools",
    run: () => {
      void import("./authoring").then((a) => {
        const on = !a.isMoveConnectedMep();
        a.setMoveConnectedMep(on);
        (window as any).__obsMoveConnected = on;
        notify("info", on ? "Moving an MEP part now moves everything connected to it" : "MEP parts move independently");
      });
    },
  });
  registerCommand({ id: "app.install", label: "Install as desktop app (works offline)", category: "File", run: () => { void import("../core/pwa").then((m) => m.installApp()); } });
  registerCommand({ id: "tools.clash", label: "Run clash detection", category: "Tools", kbd: "F5", run: () => void runElementClashDetection() });
  registerCommand({ id: "tools.clashClear", label: "Clear clash results", category: "Tools", run: () => void clearClash() });

  // Panels
  registerCommand({ id: "panel.tree", label: toggleLabel("Model tree", isModelTreePanelVisible), category: "Panels", run: () => toggleModelTreePanel() });
  registerCommand({ id: "panel.plan", label: toggleLabel("Plan view", isPlanViewVisible), category: "Panels", run: () => togglePlanView() });
  registerCommand({ id: "panel.schedules", label: toggleLabel("Schedules", isSchedulesVisible), category: "Panels", run: () => toggleSchedules() });
  registerCommand({ id: "panel.ids", label: toggleLabel("IDS validation", isIdsPanelVisible), category: "Panels", run: () => toggleIdsPanel() });
  registerCommand({ id: "panel.cost", label: toggleLabel("5D Cost panel", isCostPanelVisible), category: "Panels", run: () => toggleCostPanel() });
  registerCommand({ id: "panel.issues", label: toggleLabel("Issues / BCF panel", isIssuesPanelVisible), category: "Panels", run: () => toggleIssuesPanel() });
  registerCommand({ id: "panel.savedViews", label: toggleLabel("Saved views", isSavedViewsPanelVisible), category: "Panels", run: () => toggleSavedViewsPanel() });
  registerCommand({ id: "familyBrowser.toggle", label: "Toggle Family Browser", category: "Panels", kbd: "Ctrl+Shift+B", run: () => (window as any).__obsFamilyBrowser?.toggle?.() });
  registerCommand({ id: "familyBrowser.open", label: "Open Family Browser", category: "Panels", run: () => (window as any).__obsFamilyBrowser?.open?.() });
  registerCommand({ id: "familyBrowser.close", label: "Close Family Browser", category: "Panels", run: () => (window as any).__obsFamilyBrowser?.close?.() });
  registerCommand({ id: "panel.standards.toggle", label: "Toggle Standards", category: "Panels", kbd: "Ctrl+Shift+D", run: () => (ctx.features as any).standardsPanel?.toggle?.() });
  registerCommand({ id: "panel.standards.open", label: "Open Standards", category: "Panels", run: () => (ctx.features as any).standardsPanel?.open?.() });
  registerCommand({ id: "panel.cde.toggle", label: "Toggle Common Data Environment", category: "Panels", kbd: "Ctrl+Shift+E", run: () => (ctx.features as any).cdePanel?.toggle?.() });
  registerCommand({ id: "panel.cde.open", label: "Open Common Data Environment", category: "Panels", run: () => (ctx.features as any).cdePanel?.open?.() });
  registerCommand({ id: "panel.modelHealth.toggle", label: "Toggle Model Health", category: "Panels", run: () => (ctx.features as any).modelHealthPanel?.toggle?.() });
  registerCommand({ id: "clash.review.toggle", label: "Toggle Clash Review window", category: "Clash", kbd: "Ctrl+Shift+C", run: () => (window as any).__obs_toggleClashReview?.() });
  registerCommand({ id: "bim.contextualBar.toggle", label: "Toggle Modify Bar (contextual ribbon)", category: "BIM Experience", run: () => (ctx.features as any).bimExperience?.toggleContextualBar?.() });
  registerCommand({ id: "bim.optionsBar.toggle", label: "Toggle Options Bar", category: "BIM Experience", run: () => (ctx.features as any).bimExperience?.toggleOptionsBar?.() });
  registerCommand({ id: "bim.viewBar.toggle", label: "Toggle View Control Bar", category: "BIM Experience", run: () => (ctx.features as any).bimExperience?.toggleViewBar?.() });

  // Recalc
  registerCommand({ id: "cost.recalculate", label: "Recalculate takeoff", category: "5D Cost", run: () => recalculateTakeoff() });

  // Coordinates
  registerCommand({ id: "coords.origin", label: "Origin to origin (shared coords)", category: "Coordinates", run: () => alignOriginToOrigin() });
  registerCommand({ id: "coords.recenter", label: "Recenter scene at origin", category: "Coordinates", run: () => recenterSceneNow() });
  registerCommand({ id: "coords.reset", label: "Reset placement offsets", category: "Coordinates", run: () => resetOffsets() });
}

function toggleLabel(base: string, isOn: () => boolean): string {
  try { return `${isOn() ? "Hide" : "Show"} — ${base}`; } catch { return base; }
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup
   ═════════════════════════════════════════════════════════════════════════ */

/* ═════════════════════════════════════════════════════════════════════════
   Week 5 — bulk command registration
   ═════════════════════════════════════════════════════════════════════════ */
function prettyToolLabel(id: string): string {
  return id
    .split("-")
    .map((w) => (w[0] ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function registerAuthoringCommands(): void {
  const toolAliases: Record<string, string> = {
    wall: "WA", slab: "SL", column: "CM", beam: "BM", brace: "BR",
    truss: "TR", footing: "FT", strip: "SF", mline: "ML",
    door: "DR", window: "WN",
    stairs: "ST", railing: "RL", ramp: "RP",
    grid: "GR", level: "LV",
    duct: "DU", pipe: "PP", "cable-tray": "CT", conduit: "CD",
    equipment: "EQ",
    pile: "PL",
    "air-handler": "AHU", fan: "FAN", pump: "PU",
    chiller: "CH", boiler: "BL", valve: "VL", damper: "DP",
    diffuser: "DF", "sprinkler": "SP",
    "panel": "PNL", switch: "SW", outlet: "OU",
    "lighting-fixture": "LF", furniture: "FRN",
  };

  for (const [tool, kbd] of Object.entries(toolAliases)) {
    registerCommand({
      id: `authoring.tool.${tool}`,
      label: `Tool: ${prettyToolLabel(tool)}`,
      category: "Authoring",
      hint: `Place ${prettyToolLabel(tool)} in the viewport`,
      kbd,
      run: () => {
        const auth = services.tryUse("authoring");
        if (!auth) return;
        auth.setAuthoringTool(tool);
      },
      when: () => {
        const auth = services.tryUse("authoring");
        return !!auth && auth.getActiveTool() !== tool;
      },
    });
  }

  for (const [tool, kbd] of [["move", "G"], ["copy", ""], ["rotate", "R"], ["mirror", "M"], ["array", ""], ["offset", "O"]] as const) {
    registerCommand({
      id: `authoring.modify.${tool}`,
      label: `Modify: ${prettyToolLabel(tool)}`,
      category: "Authoring",
      kbd: kbd || undefined,
      run: () => services.tryUse("authoring")?.setAuthoringTool(tool),
    });
  }

  registerCommand({
    id: "authoring.pin",
    label: "Pin selected authored elements",
    category: "Authoring",
    run: () => {
      const n = services.tryUse("authoring")?.pinSelected(true) ?? 0;
      notify("success", `Pinned ${n} element(s)`);
    },
  });
  registerCommand({
    id: "authoring.unpin",
    label: "Unpin selected authored elements",
    category: "Authoring",
    run: () => {
      const n = services.tryUse("authoring")?.pinSelected(false) ?? 0;
      notify("success", `Unpinned ${n} element(s)`);
    },
  });
  registerCommand({
    id: "authoring.splitMidpoint",
    label: "Split selected linear elements at midpoint",
    category: "Authoring",
    run: () => {
      const n = services.tryUse("authoring")?.splitSelectedAtMidpoint() ?? 0;
      if (n) notify("success", `Split ${n} element(s)`);
      else notify("warn", "Select wall / beam / MEP runs first");
    },
  });
  registerCommand({
    id: "authoring.joinWalls",
    label: "Join selected walls to neighbors",
    category: "Authoring",
    run: () => {
      const n = services.tryUse("authoring")?.joinSelectedWalls() ?? 0;
      if (n) notify("success", `Joined ${n} wall(s)`);
      else notify("warn", "No joinable walls selected");
    },
  });
  registerCommand({
    id: "authoring.alignX",
    label: "Align selected to first (X)",
    category: "Authoring",
    run: () => {
      const n = services.tryUse("authoring")?.alignSelectedAxis("x") ?? 0;
      if (n) notify("success", `Aligned ${n} element(s)`);
    },
  });
  registerCommand({
    id: "authoring.alignZ",
    label: "Align selected to first (Z)",
    category: "Authoring",
    run: () => {
      const n = services.tryUse("authoring")?.alignSelectedAxis("z") ?? 0;
      if (n) notify("success", `Aligned ${n} element(s)`);
    },
  });
  registerCommand({
    id: "authoring.createSimilar",
    label: "Create Similar from selection",
    category: "Authoring",
    run: () => {
      const tool = services.tryUse("authoring")?.createSimilarFromSelection();
      if (tool) notify("success", `Create Similar → ${prettyToolLabel(tool)}`);
      else notify("warn", "Select one authored element first");
    },
  });
  registerCommand({
    id: "authoring.fragEditPanel",
    label: "Open Native Twin panel",
    category: "Authoring",
    run: () => services.tryUse("fragEdit")?.togglePanel(),
  });
}

function registerPanelCommands(): void {
  const panels: Array<[string, string, string]> = [
    ["schedulesPanel", "Schedules", "Ctrl+Shift+S"],
    ["sheetsPanel", "Sheets", ""],
    ["issuesPanel", "Issues / BCF", "Ctrl+I"],
    ["timelinePanel", "Timeline", ""],
    ["idsPanel", "IDS Validation", ""],
    ["savedViewsPanel", "Saved Views", ""],
    ["modelTreePanel", "Model Tree", "Ctrl+T"],
    ["costPanel", "5D Cost", ""],
    ["automationPanel", "Automation", ""],
    ["bimToolbox", "BIM Command Center", ""],
    ["bimObjectStudio", "BIM Object Studio", ""],
    ["projectBrowser", "Project Browser", ""],
    ["propertyPalette", "Properties", "Ctrl+1"],
    ["planView", "Plan View", "Ctrl+2"],
    ["walkMode", "Walk Mode", ""],
    ["mepColoring", "MEP Discipline Colors", ""],
    ["aiChat", "AI Assistant", ""],
    ["fragEdit", "Native Twin Panel", ""],
  ];

  for (const [key, label, kbd] of panels) {
    registerCommand({
      id: `panel.${key}.toggle`,
      label: `Toggle ${label}`,
      category: "Panels",
      kbd: kbd || undefined,
      run: () => {
        const svc = services.tryUse(key as any) as { toggle?: () => void } | null;
        if (svc?.toggle) svc.toggle();
        else notify("warn", `${label} panel is not loaded`);
      },
    });
  }
}

function registerClashCommands(): void {
  // Drop stale scenario commands before re-adding.
  for (const c of listCommands()) {
    if (c.id.startsWith("clash.scenario.")) unregisterCommand(c.id);
  }

  registerCommand({
    id: "clash.run",
    label: "Run clash detection",
    category: "Clash",
    kbd: "F5",
    run: () => void services.tryUse("clash")?.run(),
  });
  registerCommand({
    id: "clash.clear",
    label: "Clear clash results",
    category: "Clash",
    run: () => void services.tryUse("clash")?.clear(),
  });
  registerCommand({
    id: "clash.review.open",
    label: "Open Clash Review window",
    category: "Clash",
    kbd: "Ctrl+Shift+C",
    run: () => (window as any).__obs_openClashReview?.(),
  });
  registerCommand({
    id: "clash.next",
    label: "Next clash",
    category: "Clash",
    kbd: "N",
    run: () => void services.tryUse("clash")?.focusNextClash(),
  });
  registerCommand({
    id: "clash.prev",
    label: "Previous clash",
    category: "Clash",
    kbd: "Shift+N",
    run: () => void services.tryUse("clash")?.focusPreviousClash(),
  });
  registerCommand({
    id: "clash.cycleStatus",
    label: "Cycle active clash status",
    category: "Clash",
    run: () => services.tryUse("clash")?.cycleActiveClashStatus(),
  });
  registerCommand({
    id: "clash.markAllReviewed",
    label: "Mark all clashes reviewed",
    category: "Clash",
    run: () => services.tryUse("clash")?.setStatusForAll("reviewed"),
  });
  registerCommand({
    id: "clash.markAllResolved",
    label: "Mark all clashes resolved",
    category: "Clash",
    run: () => services.tryUse("clash")?.setStatusForAll("resolved"),
  });
  registerCommand({
    id: "clash.exportCsv",
    label: "Export clash CSV",
    category: "Clash",
    run: () => services.tryUse("clash")?.exportCsv(),
  });
  registerCommand({
    id: "clash.groups.next",
    label: "Next clash group",
    category: "Clash",
    run: () => {
      const svc = services.tryUse("clash") as any;
      const groups = svc?.listGroups?.() ?? [];
      if (!groups.length) { notify("warn", "Run a test first"); return; }
      const cur = svc.getActiveGroupId?.();
      const i = groups.findIndex((g: any) => g.id === cur);
      const next = groups[(i + 1) % groups.length];
      svc.focusGroup?.(next.id);
    },
  });

  const clash = services.tryUse("clash");
  const scenarios = clash?.listScenarios() ?? [];
  for (const s of scenarios) {
    registerCommand({
      id: `clash.scenario.${s.id}`,
      label: `Run scenario: ${s.name}`,
      category: "Clash scenarios",
      hint: `${(s as any).method ?? "hard-triangle"}`,
      run: async () => {
        const svc = services.tryUse("clash");
        if (!svc) return;
        await svc.loadScenario(s.id);
        await svc.run();
      },
    });
  }
}

export function setupCommandPalette(): void {
  bootstrapCommands();
  registerAuthoringCommands();
  registerPanelCommands();
  registerClashCommands();
  void import("../modules/schedules/schedule-templates")
    .then((m) => m.registerScheduleCommands?.())
    .catch(() => { /* schedules optional */ });

  window.addEventListener("obs-clash-scenarios-changed", () => {
    registerClashCommands();
  });

  // Ctrl+P globally. Capture phase, and stopImmediatePropagation so nothing
  // else (walk mode, ribbon) sees this keystroke.
  window.addEventListener(
    "keydown",
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopImmediatePropagation();
        togglePalette();
      }
    },
    true,
  );

  ctx.features.commandPalette = {
    open: openPalette,
    close: closePalette,
    toggle: togglePalette,
    isOpen: isCommandPaletteOpen,
    register: registerCommand,
    unregister: unregisterCommand,
    list: listCommands,
  };
}