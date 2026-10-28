/**
 * Right-click context menu (Autodesk-style).
 *
 * Extended in v3.1 with:
 *   - Edit operations for authored selection (Move/Copy/Rotate/Mirror/Array/Offset/Delete)
 *   - Multi-select actions (Select all / Invert / Select similar / Clear)
 *   - Selection sets (save / load / delete)
 *   - Undo / Redo with live labels
 *   - Gizmo mode toggle
 *   - Snapping toggle
 */
import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { ctx } from "../core/context";
import { inputRouter } from "../core/input-router";
import {
  fitToMap, focusOnPoint, focusOnBox, zoomBy, gotoDir, saveHome, goHome, fitAll, handleRightClickFocus,
  setOrbitPivot, pivotOnSelection,
  takeScreenshot, setProjection, getProjection,
} from "./camera-tools";
import { isMeasureEnabled, toggleMeasure } from "./measure";
import { isSectionOn, toggleSection } from "./section";
import { getItemMeta } from "./item-meta";
import { history } from "./history";
import { selection } from "./selection";
import { snapping } from "./snapping";
import { gizmo, type GizmoMode } from "./gizmo";
import {
  getActiveTool as getAuthoringTool,
  getSelectedIds as getAuthoredSelection,
  setAuthoringTool,
  deleteSelectedElement,
} from "./authoring";
import { beginEdit, beginEditFromSelection, openFragEditPanel } from "./frag-edit";
import { toggleBimObjectStudio } from "./bim-object-studio";

// FILE RESTORE IN PROGRESS - full content follows in next commit if truncated
export function setupContextMenu() {
  console.error("[context-menu] Incomplete restore — apply bulk convert patch from release assets");
}
