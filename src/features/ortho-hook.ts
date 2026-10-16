/**
 * Ortho hook.
 *
 * Whenever the camera switches to or from orthographic, re-fit the
 * frustum so the visible size stays consistent. Without this, switching
 * PERSP → ORTHO leaves the frustum sized for whatever the previous
 * ortho zoom was, which may be wildly off.
 *
 * Also cleans up any stale DOM overlay from features that draw inside
 * the viewport (e.g. the AccuDraw compass leftovers) on projection
 * changes.
 */
import { ctx } from "../core/context";
import { fitAll, getProjection, computeSceneBounds } from "./camera-tools";

let installed = false;
let lastProjection = "perspective";

export function setupOrthoHook(): void {
  if (installed) return;
  installed = true;

  try { lastProjection = getProjection(); } catch { /* */ }

  // Poll every 500 ms — cheap, avoids hooking into every projection-change
  // path in camera-tools.
  setInterval(() => {
    let cur = "perspective";
    try { cur = getProjection(); } catch { return; }
    if (cur === lastProjection) return;
    const was = lastProjection;
    lastProjection = cur;

    // Refit the frustum for the new projection.
    try {
      computeSceneBounds();
      fitAll();
    } catch { /* */ }

    // Clean up stray overlays that may have been left behind.
    try {
      const stray = ctx.rightHost.querySelectorAll<HTMLElement>('[data-obs-stale-overlay="1"]');
      stray.forEach((el) => el.remove());
    } catch { /* */ }

    console.log("[ortho-hook]", was, "→", cur, "· frustum refit");
  }, 500);

  console.log("[ortho-hook] ready");
}