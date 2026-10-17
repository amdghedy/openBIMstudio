import { ctx } from "../core/context";
import { notify } from "../core/notify";

export function setupPlanGridTool() {
  console.log("[plan-grid-tool] Initialized. Waiting for Grid tool...");
  
  let isDrawing = false;
  let startPt: {x: number, z: number} | null = null;
  let currentLabel = 1;

  // Monitor the active tool in the authoring engine
  setInterval(() => {
    const tool = (ctx.features as any).authoring?.getActiveTool?.();
    const active = tool === "grid" || tool === "gridline";
    
    if (active && !isDrawing) {
       isDrawing = true;
       startPt = null;
       attach();
    } else if (!active && isDrawing) {
       isDrawing = false;
       detach();
    }
  }, 300);

  function getSvg() {
     return document.querySelector('#obs-plan-view svg') || 
            document.querySelector('.obs-plan-view svg') || 
            document.querySelector('.plan-view-panel svg') || 
            document.querySelector('.obs-plan-svg') ||
            document.querySelector('svg[data-view="plan"]');
  }

  function attach() {
    const svg = getSvg();
    if (svg) {
      svg.addEventListener("pointerdown", handleClick, { capture: true });
      notify("info", "Grid tool active: click two points in the 2D plan");
    } else {
      notify("warn", "Open the 2D Floor Plan to draw grids.");
    }
  }

  function detach() {
    const svg = getSvg();
    if (svg) {
      svg.removeEventListener("pointerdown", handleClick, { capture: true });
    }
  }

  function handleClick(e: Event) {
     const evt = e as PointerEvent;
     if (!isDrawing) return;
     const svg = e.currentTarget as SVGSVGElement;
     
     // Prevent the 2D plan from selecting elements underneath
     e.stopPropagation();
     e.preventDefault();

     let world: { x: number, z: number } | null = null;
     const pv = (window as any).__obsPlanView;
     
     // 1. Try to use the plan view's built-in API if it exists
     if (pv && typeof pv.clientToWorld === 'function') {
        world = pv.clientToWorld(evt.clientX, evt.clientY);
     } else if (pv && typeof pv.screenToWorld === 'function') {
        world = pv.screenToWorld(evt.clientX, evt.clientY);
     } else {
        // 2. Fallback: map SVG coordinates to world (assuming 1:1 scale)
        // The plan generator draws with X right, Z up (which is -Y in SVG).
        const pt = svg.createSVGPoint();
        pt.x = evt.clientX;
        pt.y = evt.clientY;
        const svgP = pt.matrixTransform(svg.getScreenCTM()!.inverse());
        world = { x: svgP.x, z: -svgP.y }; 
     }

     if (!world) return;

     if (!startPt) {
        startPt = world;
        notify("info", "Start point set. Click the end point.");
     } else {
        const auth = (ctx.features as any).authoring;
        if (!auth) return;
        
        const gridEl = {
           id: "grid-" + Date.now().toString(36),
           type: "grid",
           name: `Grid ${currentLabel}`,
           params: {
              start: [startPt.x, startPt.z],
              end: [world.x, world.z],
              label: String(currentLabel),
              elevation: 0
           },
           properties: {}
        };
        
        const els = auth.getElements();
        els.push(gridEl);
        auth.rebuildAuthored();
        
        currentLabel++;
        startPt = null;
        notify("success", `Placed Grid ${currentLabel - 1}`);
     }
  }
}