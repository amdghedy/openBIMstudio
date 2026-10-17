/**
 * BIM Parity Bridge - single integration layer that:
 *   1. Registers palette / toolbox commands for every gap-closure module
 *   2. Places stairs, railings, curtain walls into the live THREE scene
 *   3. Hooks selection - temporary dimensions
 *   4. Applies visibility filter on authoring rebuild events
 *   5. Exposes Match Properties + Create Similar helpers
 *
 * Call setupBimParityBridge() from critical-gaps-boot (already wired).
 */

import * as THREE from "three";
import { ctx } from "../core/context";
import { notify } from "../core/notify";

type Any = Record<string, any>;

function scene(): THREE.Scene | null {
  return (ctx as Any).world?.scene?.three ?? null;
}

function getAuthoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? (window as Any).__obsAuthoring ?? null;
}

function getSelectionIds(): string[] {
  const sel = (ctx.features as Any)?.selection;
  try {
    if (sel?.getSelectedIds) return sel.getSelectedIds() ?? [];
    if (sel?.ids) return [...sel.ids()];
    if (sel?.size && sel.size() && sel.get) {
      // fallback
    }
  } catch { /* */ }
  return [];
}

function getElements(): Any[] {
  const a = getAuthoring();
  if (!a) return [];
  try {
    if (typeof a.getElements === "function") return a.getElements() ?? [];
    if (Array.isArray(a.elements)) return a.elements;
  } catch { /* */ }
  return [];
}

function rebuild(): void {
  const a = getAuthoring();
  if (!a) return;
  try {
    if (typeof a.rebuildAuthored === "function") a.rebuildAuthored();
    else if (typeof a.rebuild === "function") a.rebuild();
    if (typeof a.markAuthoringDirty === "function") a.markAuthoringDirty();
  } catch { /* */ }
}

/* -- Geometry placement helpers ------------------------------------------ */

const placedGroupName = "obs-parity-placed";

function placedRoot(): THREE.Group | null {
  const s = scene();
  if (!s) return null;
  let g = s.getObjectByName(placedGroupName) as THREE.Group | undefined;
  if (!g) {
    g = new THREE.Group();
    g.name = placedGroupName;
    s.add(g);
  }
  return g;
}

function placeObject(obj: THREE.Object3D, label: string): void {
  const root = placedRoot();
  if (!root) {
    notify("warn", "Scene not ready");
    return;
  }
  obj.userData.parityPlaced = true;
  obj.userData.label = label;
  root.add(obj);
  notify("success", `Placed ${label}`, { timeout: 1600 });
}

async function placeStair(runType: "straight" | "l-shape" | "u-shape" = "straight"): Promise<void> {
  const m = await import("../modules/stairs/stairs");
  const result = m.buildStair({
    totalRise: 3.0,
    width: 1.2,
    runType,
    origin: { x: 0, y: 0, z: 0 },
  });
  const comfort = m.stairComfort(result.riserHeight, 0.28);
  placeObject(result.object, `Stair (${runType}, ${result.riserCount} risers)`);
  if (!comfort.ok) notify("warn", comfort.message, { timeout: 3000 });
}

async function placeRailing(): Promise<void> {
  const m = await import("../modules/railings/railings");
  const result = m.buildRailing({
    path: [
      { x: 0, z: 0 },
      { x: 4, z: 0 },
      { x: 4, z: 3 },
    ],
    height: 1.1,
    balusterSpacing: 0.12,
  });
  placeObject(result.object, `Railing (${result.balusterCount} balusters)`);
}

async function placeCurtainWall(): Promise<void> {
  const m = await import("../modules/curtain-wall/curtain-wall");
  const result = m.buildCurtainWall({
    width: 6,
    height: 3.5,
    vDivisions: 4,
    hDivisions: 2,
    origin: { x: 0, y: 0, z: 0 },
  });
  placeObject(result.object, `Curtain wall (${result.panelCount} panels)`);
}

/* -- Match Properties ---------------------------------------------------- */

let matchSourceId: string | null = null;

function matchPropertiesPickSource(): void {
  const ids = getSelectionIds();
  if (ids.length !== 1) {
    notify("info", "Select exactly one element as the property source");
    return;
  }
  matchSourceId = ids[0];
  notify("info", "Match Properties: source set - select targets and run Apply", { timeout: 2500 });
}

function matchPropertiesApply(): number {
  if (!matchSourceId) {
    notify("warn", "No source - run Match Properties (Pick Source) first");
    return 0;
  }
  const elements = getElements();
  const source = elements.find((e) => e.id === matchSourceId);
  if (!source) {
    notify("warn", "Source element no longer exists");
    matchSourceId = null;
    return 0;
  }
  const targets = getSelectionIds().filter((id) => id !== matchSourceId);
  if (!targets.length) {
    notify("info", "Select target elements to paint properties onto");
    return 0;
  }

  // Copy type-level visual / identity properties (not geometry params)
  const paintKeys = ["color", "familyId", "familyTypeId"];
  const paintProps = source.properties ? { ...source.properties } : {};
  let n = 0;
  for (const id of targets) {
    const el = elements.find((e) => e.id === id);
    if (!el) continue;
    for (const k of paintKeys) {
      if (k in source) (el as Any)[k] = (source as Any)[k];
    }
    el.properties = { ...(el.properties ?? {}), ...paintProps };
    // Phase / design option
    if ((source as Any).phaseCreated != null) (el as Any).phaseCreated = (source as Any).phaseCreated;
    if ((source as Any).designOptionId != null) (el as Any).designOptionId = (source as Any).designOptionId;
    n++;
  }
  rebuild();
  notify("success", `Matched properties onto ${n} element(s)`, { timeout: 1800 });
  return n;
}

/* -- Create Similar ------------------------------------------------------ */

function createSimilar(): void {
  const a = getAuthoring();
  if (!a) return;
  if (typeof a.createSimilarFromSelection === "function") {
    a.createSimilarFromSelection();
    return;
  }
  const ids = getSelectionIds();
  if (ids.length !== 1) {
    notify("info", "Select one element to create similar");
    return;
  }
  const el = getElements().find((e) => e.id === ids[0]);
  if (!el) return;
  if (typeof a.setAuthoringTool === "function") {
    a.setAuthoringTool(el.type);
    if (el.familyId && typeof a.setActiveFamily === "function") {
      a.setActiveFamily(el.familyId, el.familyTypeId ?? null);
    }
    notify("success", `Tool: ${el.type} (similar)`, { timeout: 1600 });
  }
}

/* -- Selection - temp dims ----------------------------------------------- */

function hookTempDims(): void {
  const sel = (ctx.features as Any)?.selection;
  if (!sel?.onChange) return;
  sel.onChange(() => {
    const td = (ctx.features as Any)?.tempDimensions ?? (window as Any).__obsTempDims;
    if (!td?.autoForElement) return;
    const ids = getSelectionIds();
    if (ids.length !== 1) {
      td.clear?.();
      return;
    }
    const el = getElements().find((e) => e.id === ids[0]);
    if (el) td.autoForElement(el);
  });
}

/* -- Visibility on authoring-changed ------------------------------------- */

function hookVisibility(): void {
  window.addEventListener("obs:authoring-changed", () => {
    const vis = (window as Any).__obsVisibility;
    if (!vis?.isVisible) return;
    // Soft filter: mark userData; full mesh hide is left to authoring rebuild consumers
    const elements = getElements();
    for (const el of elements) {
      const visible = vis.isVisible({
        id: el.id,
        category: el.type,
        phaseCreated: (el as Any).phaseCreated ?? el.properties?.phaseCreated,
        phaseDemolished: (el as Any).phaseDemolished ?? el.properties?.phaseDemolished,
        designOptionId: (el as Any).designOptionId ?? el.properties?.designOptionId,
      });
      (el as Any)._visHidden = !visible;
    }
  });
}

/* -- Command palette registration ---------------------------------------- */

async function registerCommands(): Promise<void> {
  let register: ((cmd: Any) => void) | null = null;
  try {
    const cp = await import("./command-palette");
    register = (cp as Any).registerCommand ?? null;
  } catch {
    return;
  }
  if (!register) return;

  const cmds: Any[] = [
    {
      id: "parity.stair.straight",
      label: "Place Stair (Straight)",
      category: "Architecture",
      run: () => void placeStair("straight"),
    },
    {
      id: "parity.stair.lshape",
      label: "Place Stair (L-Shape)",
      category: "Architecture",
      run: () => void placeStair("l-shape"),
    },
    {
      id: "parity.stair.ushape",
      label: "Place Stair (U-Shape)",
      category: "Architecture",
      run: () => void placeStair("u-shape"),
    },
    {
      id: "parity.railing",
      label: "Place Railing",
      category: "Architecture",
      run: () => void placeRailing(),
    },
    {
      id: "parity.curtainWall",
      label: "Place Curtain Wall",
      category: "Architecture",
      run: () => void placeCurtainWall(),
    },
    {
      id: "parity.align.x",
      label: "Align Selection (X)",
      category: "Modify",
      kbd: "AL",
      run: () => (window as Any).__obsAlign?.alignSelection?.("x", "min"),
    },
    {
      id: "parity.align.z",
      label: "Align Selection (Z)",
      category: "Modify",
      run: () => (window as Any).__obsAlign?.alignSelection?.("z", "min"),
    },
    {
      id: "parity.distribute.x",
      label: "Distribute Selection (X)",
      category: "Modify",
      run: () => (window as Any).__obsAlign?.distributeSelection?.("x"),
    },
    {
      id: "parity.match.pick",
      label: "Match Properties - Pick Source",
      category: "Modify",
      kbd: "MA",
      run: () => matchPropertiesPickSource(),
    },
    {
      id: "parity.match.apply",
      label: "Match Properties - Apply",
      category: "Modify",
      run: () => matchPropertiesApply(),
    },
    {
      id: "parity.createSimilar",
      label: "Create Similar",
      category: "Modify",
      kbd: "CS",
      run: () => createSimilar(),
    },
    {
      id: "parity.tempHide",
      label: "Temporary Hide Selected",
      category: "View",
      kbd: "HH",
      run: () => {
        const ids = getSelectionIds();
        (window as Any).__obsVisibility?.hideElements?.(ids);
        notify("info", `Hidden ${ids.length} element(s)`, { timeout: 1400 });
      },
    },
    {
      id: "parity.isolate",
      label: "Temporary Isolate Selected",
      category: "View",
      kbd: "HI",
      run: () => {
        const ids = getSelectionIds();
        (window as Any).__obsVisibility?.isolateElements?.(ids);
        notify("info", `Isolated ${ids.length} element(s)`, { timeout: 1400 });
      },
    },
    {
      id: "parity.resetTemp",
      label: "Reset Temporary Hide/Isolate",
      category: "View",
      kbd: "HR",
      run: () => {
        (window as Any).__obsVisibility?.resetTemporary?.();
        notify("success", "Temporary visibility reset", { timeout: 1400 });
      },
    },
    {
      id: "parity.panel.rooms",
      label: "Rooms & Areas Panel",
      category: "Panels",
      run: () => window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "rooms" } })),
    },
    {
      id: "parity.panel.phases",
      label: "Phasing Panel",
      category: "Panels",
      run: () => window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "phases" } })),
    },
    {
      id: "parity.panel.options",
      label: "Design Options Panel",
      category: "Panels",
      run: () => window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "design-options" } })),
    },
    {
      id: "parity.panel.groups",
      label: "Model Groups Panel",
      category: "Panels",
      run: () => window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "groups" } })),
    },
    {
      id: "parity.panel.copyMonitor",
      label: "Copy / Monitor Panel",
      category: "Panels",
      run: () => window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "copy-monitor" } })),
    },
    {
      id: "parity.group.create",
      label: "Create Group from Selection",
      category: "Modify",
      run: () => {
        const ids = getSelectionIds();
        if (!ids.length) {
          notify("info", "Select elements to group");
          return;
        }
        const name = window.prompt("Group name:", "Group") ?? "Group";
        const g = (window as Any).__obsGroups?.createFromSelection?.(name, ids, true);
        if (g) notify("success", `Group "${name}" created`, { timeout: 1800 });
      },
    },
    {
      id: "parity.room.create",
      label: "Create Room (sample boundary)",
      category: "Architecture",
      run: () => {
        const r = (window as Any).__obsRooms?.createRoom?.({
          name: "Room",
          boundary: [
            { x: 0, z: 0 },
            { x: 4, z: 0 },
            { x: 4, z: 3 },
            { x: 0, z: 3 },
          ],
        });
        if (r) notify("success", `Room ${r.number} - ${r.area.toFixed(1)} m2`, { timeout: 2000 });
      },
    },
    {
      id: "parity.workplane.xy",
      label: "Set Work Plane - Floor (XY)",
      category: "Architecture",
      run: () => {
        (window as Any).__obsRefPlanes?.setActiveWorkPlane?.("rp-xy");
        notify("success", "Work plane: Floor (XY)", { timeout: 1400 });
      },
    },
    {
      id: "parity.workplane.xz",
      label: "Set Work Plane - Front (XZ)",
      category: "Architecture",
      run: () => {
        (window as Any).__obsRefPlanes?.setActiveWorkPlane?.("rp-xz");
        notify("success", "Work plane: Front (XZ)", { timeout: 1400 });
      },
    },
  ];

  for (const c of cmds) {
    try {
      register(c);
    } catch { /* */ }
  }
  console.log(`[bim-parity-bridge] registered ${cmds.length} commands`);
}

/* -- Setup --------------------------------------------------------------- */

export function setupBimParityBridge(): void {
  hookTempDims();
  hookVisibility();
  void registerCommands();

  (ctx.features as Any).revitParity = {
    placeStair,
    placeRailing,
    placeCurtainWall,
    matchPropertiesPickSource,
    matchPropertiesApply,
    createSimilar,
  };
  (window as Any).__obsBimParity = (ctx.features as Any).revitParity;

  console.log("[bim-parity-bridge] ready");
}
