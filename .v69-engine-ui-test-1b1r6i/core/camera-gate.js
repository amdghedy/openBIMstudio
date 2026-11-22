"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetCameraGateCache = resetCameraGateCache;
exports.pauseCameraControls = pauseCameraControls;
exports.cameraControlsPaused = cameraControlsPaused;
exports.forceResumeCameraControls = forceResumeCameraControls;
/**
 * Camera-controls gating.
 *
 * Different @thatopen/components versions expose the underlying
 * CameraControls instance at different paths. This module probes once,
 * caches the reference, and provides a reference-counted pause so multiple
 * features (gizmo, box-select, authoring grip drag) can hold the camera
 * paused simultaneously without one re-enabling it while another still
 * needs it disabled.
 */
const context_1 = require("./context");
let cached = null;
let cacheAttempted = false;
function findControls() {
    if (cacheAttempted)
        return cached;
    cacheAttempted = true;
    try {
        const cam = context_1.ctx.world?.camera;
        if (!cam)
            return (cached = null);
        // Prefer an object that exposes `.enabled` directly (the actual controls).
        if (cam.controls && typeof cam.controls === "object") {
            if (typeof cam.controls.enabled === "boolean")
                return (cached = cam.controls);
            if (cam.controls.controls && typeof cam.controls.controls.enabled === "boolean") {
                return (cached = cam.controls.controls);
            }
        }
        if (cam.cameraControls && typeof cam.cameraControls.enabled === "boolean") {
            return (cached = cam.cameraControls);
        }
    }
    catch {
        /* swallow — a missing controls object is a valid state during boot */
    }
    return (cached = null);
}
function resetCameraGateCache() {
    cached = null;
    cacheAttempted = false;
    holders = 0;
    lastEnabled = null;
}
let holders = 0;
let lastEnabled = null;
function applyEnabled(on) {
    if (lastEnabled === on)
        return;
    const c = findControls();
    if (c)
        c.enabled = on;
    lastEnabled = on;
}
/**
 * Pause camera interaction. Returns a release function. Callers must call
 * the release exactly once. Nested calls are supported via refcount.
 */
function pauseCameraControls() {
    holders++;
    applyEnabled(false);
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        holders = Math.max(0, holders - 1);
        if (holders === 0)
            applyEnabled(true);
    };
}
function cameraControlsPaused() {
    return holders > 0;
}
/** Force-reset the gate — used by recovery code after a stuck gesture. */
function forceResumeCameraControls() {
    holders = 0;
    applyEnabled(true);
}
