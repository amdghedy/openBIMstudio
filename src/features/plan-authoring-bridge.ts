import * as THREE from "three";
import { ctx } from "../core/context";

export function setupPlanAuthoringBridge() {
  let svgEl: SVGSVGElement | null = null;

  const getSvg = (): SVGSVGElement | null => {
    return (document.querySelector('#obs-plan-view svg') ||
            document.querySelector('.obs-plan-view svg') ||
            document.querySelector('.plan-view svg') ||
            document.querySelector('.obs-plan-svg')) as SVGSVGElement | null;
  };

  const isDrawing = () => {
    const t = (ctx.features as any).authoring?.getActiveTool?.();
    return t && t !== "select" && t !== "pan" && t !== "zoom";
  };

  const forwardEvent = (e: PointerEvent) => {
    const svg = getSvg();
    if (!svg) return;

    // 1. Get SVG coordinate
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgP = pt.matrixTransform(svg.getScreenCTM()!.inverse());

    // 2. Map to World (x, z). Plan view uses screenY = -worldZ
    let wx = svgP.x;
    let wz = -svgP.y;

    // Use __obsPlanView for accurate mapping if available
    const pv = (window as any).__obsPlanView;
    if (pv && typeof pv.svgToWorld === "function") {
       const w = pv.svgToWorld(svgP.x, svgP.y);
       wx = w.x; wz = w.z;
    }

    // 3. Project World to 3D Screen
    const v = new THREE.Vector3(wx, 0, wz);
    v.project(ctx.world.camera.three);
    const canvas = ctx.world.renderer.three.domElement as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();

    const tx = (v.x * 0.5 + 0.5) * rect.width + rect.left;
    const ty = (-v.y * 0.5 + 0.5) * rect.height + rect.top;

    // 4. Dispatch synthetic event to 3D canvas
    const evtOpts: PointerEventInit = {
      clientX: tx, clientY: ty, bubbles: true, cancelable: true,
      pointerId: e.pointerId, button: e.button, buttons: e.buttons,
      pointerType: e.pointerType, isPrimary: true
    };
    canvas.dispatchEvent(new PointerEvent(e.type, evtOpts));
  };

  const handlePointerDown = (e: PointerEvent) => {
    if (!isDrawing()) return;
    e.preventDefault(); e.stopPropagation();
    forwardEvent(e);
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!isDrawing()) return;
    forwardEvent(e);
  };

  const handlePointerUp = (e: PointerEvent) => {
    if (!isDrawing()) return;
    e.preventDefault(); e.stopPropagation();
    forwardEvent(e);
  };

  setInterval(() => {
    const currentSvg = getSvg();
    if (currentSvg && currentSvg !== svgEl) {
      if (svgEl) {
        svgEl.removeEventListener("pointerdown", handlePointerDown, { capture: true });
        svgEl.removeEventListener("pointermove", handlePointerMove, { capture: true });
        svgEl.removeEventListener("pointerup", handlePointerUp, { capture: true });
      }
      svgEl = currentSvg;
      if (svgEl) {
        svgEl.addEventListener("pointerdown", handlePointerDown, { capture: true });
        svgEl.addEventListener("pointermove", handlePointerMove, { capture: true });
        svgEl.addEventListener("pointerup", handlePointerUp, { capture: true });
        console.log("[plan-authoring-bridge] Attached to 2D plan SVG");
      }
    }
  }, 1000);
}