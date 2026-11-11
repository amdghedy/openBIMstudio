/**
 * Retired in v3.1 — drawing tools are now delegated to authoring.ts.
 *
 * This file is a compatibility shim to preserve the public API for
 * panel.ts, camera-tools.ts, measure.ts, and section.ts. It holds no
 * state and adds nothing to the scene.
 */
import {
  isDrawingActive as authoringIsDrawing,
  setAuthoringTool,
  getActiveTool,
  clearAllElements,
} from "./authoring";

/**
 * Live re-export of authoring's tool label so the panel and ribbon share one.
 *
 * This MUST stay a pure `export { … } from` re-export, not
 * `export const activeToolLabel = authoringLabel`. authoring.ts ↔ drawing.ts
 * sit in an import cycle (authoring → measure/section → drawing), and an
 * eagerly-evaluated snapshot binding is read at module-evaluation time: when
 * the entry graph reaches drawing.ts while authoring.ts is still
 * mid-evaluation, the read hits the TDZ and the whole app fails to boot with
 * "Cannot access 'activeToolLabel' before initialization" (white screen).
 * A pure re-export resolves lazily at each access — cycle-safe and live.
 */
export { activeToolLabel } from "./authoring";

/** True while any authoring tool (draw or modify) is active. */
export function isDrawingActive(): boolean {
  return authoringIsDrawing();
}

/**
 * Compatibility wrapper: toggles an authoring draw tool.
 * "wall" | "pipe" | "duct" are the three historic drawing tools.
 */
export function toggleDrawingTool(
  tool: "wall" | "pipe" | "duct",
): "wall" | "pipe" | "duct" | null {
  const cur = getActiveTool();
  if (cur === tool) {
    setAuthoringTool(null);
    return null;
  }
  setAuthoringTool(tool as any);
  return tool;
}

export function stopDrawing(): void {
  setAuthoringTool(null);
}

/** Historic name — now clears authored elements (with confirmation). */
export function clearAllDrawings(): void {
  clearAllElements();
}

/**
 * Kept for main.ts compatibility. Authoring owns the scene group and input
 * handling now; this is a no-op.
 */
export function setupDrawing(): void {
  // silent no-op — drawing tools live in authoring.ts
}