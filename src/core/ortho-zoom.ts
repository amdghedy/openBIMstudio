import { ctx } from "./context";

/**
 * camera-controls keeps its own internal zoom for orthographic cameras and
 * writes it back to `camera.zoom` on every update, so assigning `cam.zoom`
 * directly is silently undone (ortho zoom appears "stuck"). Call this right
 * after changing `cam.zoom` so the controls adopt the new value.
 */
export function syncOrthoZoom(cam: any): void {
  try {
    if (!cam?.isOrthographicCamera) return;
    const c: any = (ctx as any).world?.camera?.controls;
    if (!c || typeof c.zoomTo !== "function") return;
    if (c.camera && c.camera !== cam) return; // controls drive another camera
    const r = c.zoomTo(cam.zoom, false);
    if (r && typeof r.catch === "function") r.catch(() => { /* */ });
  } catch { /* */ }
}
