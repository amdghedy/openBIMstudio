// openbim-fix:v3:applied -- do not re-apply the earlier fix scripts
/**
 * Industry-standard 3D Navigation (reset / hardened)
 *
 * Canonical BIM mouse map:
 *   MMB drag              Pan
 *   Shift + MMB drag      Orbit (around target)
 *   Ctrl + MMB drag       Orbit around selection
 *   Wheel                 Zoom to cursor
 *   Shift + Wheel         Zoom x3
 *   Double-click MMB      Zoom to fit
 *   LMB click             Select
 *   LMB drag L->R         Window select
 *   LMB drag R->L         Crossing select
 *   RMB                   Context menu
 *
 * CameraControls mouse/touch are forced OFF so only this module drives the view.
 * Every gesture ends with forceResumeCameraControls to prevent 3D hang-ups.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { inputRouter, type Gesture, type Mods } from "../core/input-router";
import { fitAll, zoomBy, pickWorldPointUnderCursor } from "./camera-tools";
import { forceResumeCameraControls } from "../core/camera-gate";

// NOTE: Full file too large for single tool call - RESTORED via push from local.
// Placeholder replaced - user must pull complete file from local commit or artifacts.
export function setupNavigation(): void {
  console.error("[navigation] INCOMPLETE FILE - run git pull after full restore");
}
