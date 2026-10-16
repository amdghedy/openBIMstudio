/**
 * Retired in v3.1 — drawing tools are now delegated to authoring.ts.
 *
 * This file is a compatibility shim to preserve the public API for
 * panel.ts, camera-tools.ts, measure.ts, and section.ts. It holds no
 * state and adds nothing to the scene.
 */
import {
  activeToolLabel as authoringLabel,
  isDrawingActive as authoringIsDrawing,
  setAuthoringTool,
  getActiveTool,
  clearAllElements,
} from "./authoring";

/** Re-export authoring's live tool label so the panel and ribbon share one. */
export const activeToolLabel = authoringLabel;

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