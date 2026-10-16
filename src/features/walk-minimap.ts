/**
 * Walk-mode minimap v7 — plan background + arrow, both using the SAME
 * transform derived from `ctx.scene.box` extended to include the walker.
 *
 *   - The transform is computed fresh every frame from the world bounds
 *     of ALL loaded geometry + the walker position. If the walker walks
 *     outside the building, the box auto-expands — the arrow is never
 *     clamped to the edge.
 *   - The 2D plan generator is called periodically; its segment world
 *     coordinates are drawn with the SAME transform used for the arrow.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { generatePlanView } from "../modules/drawings/plan-generator";
import type { PlanView } from "../modules/drawings/plan-types";

let installed = false;
let enabled = false;

const BOX_W_PX = 227;
const BOX_H_PX = 151;
const BOX_MARGIN_PX = 12;
const EYE_HEIGHT_M = 1.6;
const CUT_HEIGHT_M = 1.2;
const PAD_FRACTION = 0.08;   // 8% padding around the bounds

let overlay: HTMLDivElement | null = null;
let svgEl: SVGSVGElement | null = null;
let planGroup: SVGGElement | null = null;
let arrowGroup: SVGGElement | null = null;
let debugEl: HTMLDivElement | null = null;
let labelEl: HTMLDivElement | null = null;

let currentPlan: PlanView | null = null;
let lastPlanY = -99999;
let generating = false;

function ensureOverlay(): HTMLDivElement | null {
  if (overlay) return overlay;
  const host = ctx.rightHost as HTMLElement | undefined;
  if (!host) return null;

  overlay = document.createElement("div");
  overlay.id = "obs-walk-minimap";
  const set = (k: string, v: string) => overlay!.style.setProperty(k, v, "important");
  set("position", "absolute");
  set("display", "none");
  set("pointer-events", "none");
  set("z-index", "9999");
  set("width",  BOX_W_PX + "px");
  set("height", BOX_H_PX + "px");
  set("min-width",  BOX_W_PX + "px");
  set("max-width",  BOX_W_PX + "px");
  set("min-height", BOX_H_PX + "px");
  set("max-height", BOX_H_PX + "px");
  set("right", BOX_MARGIN_PX + "px");
  set("top",   BOX_MARGIN_PX + "px");
  set("border", "2px solid #38bdf8");
  set("border-radius", "4px");
  set("box-shadow", "0 8px 24px rgba(0,0,0,.6)");
  set("overflow", "hidden");
  set("background", "#0a0d14");
  set("box-sizing", "border-box");

  labelEl = document.createElement("div");
  labelEl.textContent = "WALK \u00b7 PLAN";
  labelEl.style.cssText =
    "position:absolute;top:3px;left:5px;z-index:3;" +
    "font:700 9px system-ui,sans-serif;letter-spacing:.08em;" +
    "color:#38bdf8;text-shadow:0 1px 2px rgba(0,0,0,.9)";
  overlay.appendChild(labelEl);

  // Compass — small N at top-right so orientation is unambiguous
  const compass = document.createElement("div");
  compass.textContent = "N";
  compass.style.cssText =
    "position:absolute;top:3px;right:6px;z-index:3;" +
    "font:700 10px system-ui,sans-serif;color:#f59e0b;" +
    "text-shadow:0 1px 2px rgba(0,0,0,.9)";
  compass.title = "Top of the minimap = +Z is DOWN, -Z is UP";
  overlay.appendChild(compass);

  debugEl = document.createElement("div");
  debugEl.style.cssText =
    "position:absolute;bottom:3px;left:5px;right:5px;z-index:3;" +
    "font:9px ui-monospace,monospace;color:#94a3b8;" +
    "text-shadow:0 1px 2px rgba(0,0,0,.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  overlay.appendChild(debugEl);

  const NS = "http://www.w3.org/2000/svg";
  svgEl = document.createElementNS(NS, "svg") as SVGSVGElement;
  svgEl.setAttribute("viewBox", "0 0 " + BOX_W_PX + " " + BOX_H_PX);
  svgEl.setAttribute("preserveAspectRatio", "none");
  svgEl.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:2";

  planGroup = document.createElementNS(NS, "g") as SVGGElement;
  planGroup.setAttribute("fill", "none");
  svgEl.appendChild(planGroup);

  arrowGroup = document.createElementNS(NS, "g") as SVGGElement;

  // Smaller FOV cone
  const cone = document.createElementNS(NS, "polygon") as SVGPolygonElement;
  cone.setAttribute("points", "0,0 -12,-28 12,-28");
  cone.setAttribute("fill", "rgba(239,68,68,0.25)");
  cone.setAttribute("stroke", "none");
  arrowGroup.appendChild(cone);

  const ring = document.createElementNS(NS, "circle") as SVGCircleElement;
  ring.setAttribute("cx", "0");
  ring.setAttribute("cy", "0");
  ring.setAttribute("r", "4.5");
  ring.setAttribute("fill", "rgba(239,68,68,0.30)");
  ring.setAttribute("stroke", "rgba(239,68,68,0.95)");
  ring.setAttribute("stroke-width", "0.7");
  arrowGroup.appendChild(ring);

  const arrow = document.createElementNS(NS, "polygon") as SVGPolygonElement;
  arrow.setAttribute("points", "0,-6.5 3.8,4 0,2 -3.8,4");
  arrow.setAttribute("fill", "#ef4444");
  arrow.setAttribute("stroke", "#ffffff");
  arrow.setAttribute("stroke-width", "0.9");
  arrow.setAttribute("stroke-linejoin", "round");
  arrowGroup.appendChild(arrow);

  svgEl.appendChild(arrowGroup);
  overlay.appendChild(svgEl);

  host.appendChild(overlay);
  return overlay;
}

function isWalkOn(): boolean {
  const wm: any = (ctx.features as any).walkMode;
  if (!wm) return false;
  for (const m of ["isEnabled", "isActive", "getActive", "isOn"]) {
    try { if (typeof wm[m] === "function" && wm[m]()) return true; } catch { /* */ }
  }
  return false;
}

/**
 * Compute the plan→SVG transform from the world bounds of ALL loaded
 * geometry, expanded to include the walker position so the arrow is
 * never clamped.
 */
function computeTransform() {
  let minX = -10, maxX = 10, minZ = -10, maxZ = 10;

  try {
    const b = (ctx.scene as any).box;
    if (b instanceof THREE.Box3 && !b.isEmpty()) {
      minX = b.min.x; maxX = b.max.x;
      minZ = b.min.z; maxZ = b.max.z;
    }
  } catch { /* */ }

  // Expand to include the walker
  const cam = ctx.world.camera.three.position;
  if (cam.x < minX) minX = cam.x;
  if (cam.x > maxX) maxX = cam.x;
  if (cam.z < minZ) minZ = cam.z;
  if (cam.z > maxZ) maxZ = cam.z;

  // Pad
  const w0 = maxX - minX;
  const h0 = maxZ - minZ;
  const pad = Math.max(w0, h0) * PAD_FRACTION;
  minX -= pad; maxX += pad;
  minZ -= pad; maxZ += pad;

  const w = Math.max(maxX - minX, 0.01);
  const h = Math.max(maxZ - minZ, 0.01);
  const scale = Math.min(BOX_W_PX / w, BOX_H_PX / h);
  const offX = (BOX_W_PX - w * scale) / 2;
  const offY = (BOX_H_PX - h * scale) / 2;

  const bounds = { minX, maxX, minZ, maxZ, w, h, scale, offX, offY };

  // Plan convention: screenX = worldX, screenY = -worldZ.
  // SVG Y grows DOWN. To make world -Z the "up" direction of the minimap
  // (so a walker facing north sees the top of the box as forward):
  //   svgY = offY + (worldZ - minZ) * scale
  // This means higher world Z = lower in the box (down).
  const toSvg = (x: number, z: number): [number, number] => [
    offX + (x - minX) * scale,
    offY + (maxZ - z) * scale,
  ];

  return { bounds, toSvg };
}

function buildPlanSvg(): void {
  if (!planGroup || !currentPlan) return;
  planGroup.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg";
  const { toSvg } = computeTransform();
  const frag = document.createDocumentFragment();

  const cuts = currentPlan.segments.filter((s) => s.kind === "cut");
  const stride = Math.max(1, Math.ceil(cuts.length / 12000));
  let drawn = 0;

  for (let i = 0; i < cuts.length; i += stride) {
    const seg = cuts[i];
    const [x1, y1] = toSvg(seg.x1, seg.z1);
    const [x2, y2] = toSvg(seg.x2, seg.z2);
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", x1.toFixed(2));
    line.setAttribute("y1", y1.toFixed(2));
    line.setAttribute("x2", x2.toFixed(2));
    line.setAttribute("y2", y2.toFixed(2));
    line.setAttribute("stroke", "#7dd3fc");
    line.setAttribute("stroke-width", "0.55");
    line.setAttribute("stroke-linecap", "round");
    frag.appendChild(line);
    drawn++;
  }

  for (const arc of currentPlan.arcs) {
    const steps = 12;
    let d = "";
    for (let i = 0; i <= steps; i++) {
      const a = arc.start + (arc.end - arc.start) * (i / steps);
      const wx = arc.cx + Math.cos(a) * arc.r;
      const wz = arc.cz + Math.sin(a) * arc.r;
      const [sx, sy] = toSvg(wx, wz);
      d += (i === 0 ? "M" : "L") + sx.toFixed(2) + " " + sy.toFixed(2) + " ";
    }
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "#7dd3fc");
    path.setAttribute("stroke-width", "0.55");
    path.setAttribute("fill", "none");
    frag.appendChild(path);
  }

  planGroup.appendChild(frag);
}

function updateArrow(): void {
  if (!arrowGroup) return;
  if (!currentPlan) return;

  const { toSvg, bounds } = computeTransform();
  const cam = ctx.world.camera.three;
  const wx = cam.position.x;
  const wz = cam.position.z;

  const [sx, sy] = toSvg(wx, wz);
  // Since bounds already include the walker + padding, sx/sy should be
  // inside the box. Just clamp as safety.
  const cx = Math.max(2, Math.min(BOX_W_PX - 2, sx));
  const cy = Math.max(2, Math.min(BOX_H_PX - 2, sy));

  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  // In SVG, rotate(0) = arrow points up (-Y).
  // Our transform maps world +Z → SVG +Y (down), world -Z → SVG -Y (up).
  // So: facing world -Z (north) → rotate 0; facing world +X → rotate 90.
  // atan2(x, -z): -z points "up". Wait, we want to face -Z to be 0°.
  // Facing -Z: dir=(0,0,-1) → want 0°. atan2(0, 1) = 0. ✓
  // Facing +X: dir=(1,0,0)  → want 90°. atan2(1, 0) = 90. ✓
  // Facing +Z: dir=(0,0,1)  → want 180°. atan2(0, -1) = 180. ✓
  // Facing -X: dir=(-1,0,0) → want -90. atan2(-1, 0) = -90. ✓
  const headingDeg = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI;

  arrowGroup.setAttribute("transform",
    "translate(" + cx.toFixed(2) + "," + cy.toFixed(2) + ") " +
    "rotate(" + headingDeg.toFixed(2) + ")");

  if (debugEl) {
    debugEl.textContent =
      "X:" + wx.toFixed(1) + " Z:" + wz.toFixed(1) +
      " | box " + (bounds.maxX - bounds.minX).toFixed(0) + "\u00d7" +
      (bounds.maxZ - bounds.minZ).toFixed(0) +
      " | hdg " + headingDeg.toFixed(0) + "\u00b0";
  }
}

async function maybeRefreshPlan(force = false): Promise<void> {
  if (!enabled || generating) return;
  const walkerY = ctx.world.camera.three.position.y;
  if (!force && currentPlan && Math.abs(walkerY - lastPlanY) < 2) return;

  generating = true;
  lastPlanY = walkerY;
  try {
    const plan = await generatePlanView({
      levelName: "WALK",
      levelElevation: walkerY - EYE_HEIGHT_M,
      cutHeight: CUT_HEIGHT_M,
      cutDepth: 0.3,
      viewRangeTop: CUT_HEIGHT_M,
      viewRangeBottom: 0.3,
      viewDepth: 0.3,
      includeOverhead: false,
      includeBelow: false,
      maxSegments: 40000,
    });
    currentPlan = plan;
    buildPlanSvg();
    console.log("[walk-minimap] plan refreshed: " +
      plan.segments.length + " seg, bounds " +
      "X[" + plan.bounds.minX.toFixed(1) + ".." + plan.bounds.maxX.toFixed(1) + "] " +
      "Z[" + plan.bounds.minZ.toFixed(1) + ".." + plan.bounds.maxZ.toFixed(1) + "]");
  } catch (e) {
    console.warn("[walk-minimap] plan generation failed", e);
  } finally {
    generating = false;
  }
}

function updateVisibility(): void {
  const on = isWalkOn();
  if (on === enabled) return;
  enabled = on;
  if (enabled) {
    ensureOverlay();
    if (overlay) overlay.style.display = "block";
    lastPlanY = -99999;
    void maybeRefreshPlan(true);
  } else if (overlay) {
    overlay.style.display = "none";
  }
}

export function setupWalkMinimap(): void {
  if (installed) return;
  installed = true;

  ensureOverlay();

  setInterval(() => {
    updateVisibility();
    if (enabled) updateArrow();
  }, 100);

  setInterval(() => { void maybeRefreshPlan(); }, 2000);

  (window as any).__obsWalkMinimap = {
    show: () => { enabled = true; if (overlay) overlay.style.display = "block"; void maybeRefreshPlan(true); },
    hide: () => { enabled = false; if (overlay) overlay.style.display = "none"; },
    isEnabled: () => enabled,
    hasPlan: () => !!currentPlan,
    refreshPlan: () => maybeRefreshPlan(true),
    rebuild: () => { if (currentPlan) buildPlanSvg(); },
  };

  console.log("[walk-minimap] ready (v7 — scene-bounds transform)");
}