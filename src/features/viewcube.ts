/**
 * ViewCube — professional navigation widget (Autodesk Viewer–inspired).
 *
 * This is the DOM/feature layer of src/modules/navigation. It contains:
 *  - RealCameraAdapter: the CameraAdapter implementation over the existing
 *    viewer (ThatOpen OrthoPerspectiveCamera + camera-controls + the
 *    camera-tools primitives). No second orbit controller is introduced.
 *  - The floating widget in the upper-right viewport corner: a live SVG
 *    ViewCube (6 faces / 12 edges / 8 corners as real hit targets), N/E/S/W
 *    compass honoring Project/True North, curved rotation arrows with
 *    press-and-hold repeat, Home button and the full Home context menu.
 *
 * Every control routes through NavigationController — no placeholder
 * handlers, no visual-only state.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { notify } from "../core/notify";
import { tryUse } from "../core/services";
import {
  computeSceneBounds, getProjection, getSceneBox, setProjection, updateClipping,
} from "./camera-tools";
import { syncOrthoZoom } from "../core/ortho-zoom";
import { getNorthState, onNorthChanged } from "../modules/north/north";
import { getCurrentProject, onProjectChanged } from "../modules/projects/projects";
import { APP_VERSION } from "../version";
import {
  CUBE_CORNERS, CUBE_EDGES, CUBE_FACES,
  NavigationController,
  type CameraAdapter, type CoreProjection, type CubeCorner, type CubeEdge,
  type CubeFace, type ProjectionMode,
} from "../modules/navigation";
import {
  CUBE_GRAPH, compassScreenPos, edgeStripPoints, facePoints, projectCube,
  type CornerId, type EdgeId, type FaceId, type Quat, type Vec3,
} from "./viewcube-geometry";

/* ── Widget metrics ────────────────────────────────────────────────────── */

const SVG_SIZE = 140;
const CX = SVG_SIZE / 2;
const CY = SVG_SIZE / 2;
const CUBE_SCALE = 31;
const RING_RADIUS = 62;
const EDGE_HIT_WIDTH = 9;
const CORNER_HIT_R = 6.5;

const MODE_LABEL: Record<ProjectionMode, string> = {
  perspective: "Perspective",
  orthographic: "Orthographic",
  "perspective-ortho-faces": "Perspective + Ortho Faces",
};

/* ── Production camera adapter ─────────────────────────────────────────── */

function worldReady(): boolean {
  try {
    const w: any = (ctx as any).world;
    return !!w && !!w.camera && !!w.camera.three;
  } catch {
    return false;
  }
}

function activeCam(): any {
  return ctx.world.camera.three;
}

function controls(): any {
  return ctx.world.camera.controls;
}

function perspFovDeg(): number {
  try {
    const c: any = ctx.world.camera;
    if (!activeCam().isOrthographicCamera) return activeCam().fov ?? 60;
    return c.perspectiveCamera?.fov ?? 60;
  } catch {
    return 60;
  }
}

class RealCameraAdapter implements CameraAdapter {
  private selectionBox: THREE.Box3 | null = null;

  position(): THREE.Vector3 {
    if (!worldReady()) return new THREE.Vector3();
    return activeCam().position.clone();
  }

  target(): THREE.Vector3 {
    if (!worldReady()) return new THREE.Vector3();
    const c = controls();
    if (c?.target?.isVector3) return c.target.clone();
    const cam = activeCam();
    const d = new THREE.Vector3();
    cam.getWorldDirection(d);
    return cam.position.clone().addScaledVector(d, 5);
  }

  up(): THREE.Vector3 {
    if (!worldReady()) return new THREE.Vector3(0, 1, 0);
    return activeCam().up.clone();
  }

  fovY(): number {
    return THREE.MathUtils.degToRad(perspFovDeg());
  }

  aspect(): number {
    try {
      const a = activeCam().aspect;
      if (Number.isFinite(a) && a > 0) return a;
    } catch { /* */ }
    const host = ctx.rightHost;
    const w = host?.clientWidth || 1;
    const h = host?.clientHeight || 1;
    return Math.max(0.05, w / h);
  }

  orthoHalfHeight(): number {
    if (!worldReady()) return 10;
    const cam = activeCam();
    if (!cam.isOrthographicCamera) return 10;
    const zoom = Math.max(1e-3, cam.zoom || 1);
    return (cam.top - cam.bottom) / (2 * zoom);
  }

  setOrthoHalfHeight(h: number): void {
    if (!worldReady() || !Number.isFinite(h) || h <= 0) return;
    const cam = activeCam();
    if (!cam.isOrthographicCamera) return;
    const total = cam.top - cam.bottom;
    if (!(total > 1e-9)) return;
    cam.zoom = THREE.MathUtils.clamp(total / (2 * h), 0.01, 5000);
    syncOrthoZoom(cam);
    cam.updateProjectionMatrix();
  }

  projection(): CoreProjection {
    if (!worldReady()) return "perspective";
    return getProjection();
  }

  setProjection(m: CoreProjection): boolean {
    if (!worldReady()) return false;
    return setProjection(m);
  }

  lookAt(pos: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3, animate: boolean): void {
    if (!worldReady()) return;
    const cam = activeCam();
    const c = controls();
    try { cam.up.copy(up).normalize(); } catch { /* */ }
    try {
      c.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, animate);
    } catch {
      cam.position.copy(pos);
      cam.lookAt(target);
    }
    if (!animate) {
      try { cam.updateMatrixWorld(); } catch { /* */ }
    }
    updateClipping();
  }

  focusBounds(): THREE.Box3 | null {
    return this.selectionBox ?? this.sceneBounds();
  }

  sceneBounds(): THREE.Box3 | null {
    if (!worldReady()) return null;
    try {
      computeSceneBounds();
      const box = getSceneBox();
      if (!box || box.isEmpty()) return null;
      return box;
    } catch {
      return null;
    }
  }

  onUserGesture(cb: () => void): () => void {
    const host = ctx.rightHost as HTMLElement | undefined;
    if (!host) return () => {};
    const handler = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && t.tagName === "CANVAS") cb();
    };
    host.addEventListener("pointerdown", handler, true);
    host.addEventListener("wheel", handler, { capture: true, passive: true });
    return () => {
      host.removeEventListener("pointerdown", handler, true);
      host.removeEventListener("wheel", handler, true);
    };
  }

  /** Keep a cached selection AABB for Focus commands (async service → cache). */
  watchSelection(): void {
    const sel: any = tryUse("selection") ?? (ctx.features as any).selection;
    if (!sel) return;
    const refresh = () => {
      try {
        void Promise.resolve(sel.boundingBox?.())
          .then((b: THREE.Box3 | null) => { this.selectionBox = b ?? null; })
          .catch(() => { this.selectionBox = null; });
      } catch { /* */ }
    };
    try { sel.onChange?.(() => refresh()); } catch { /* */ }
    refresh();
  }
}

/* ── DOM helpers ───────────────────────────────────────────────────────── */

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, css: string, parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (parent) parent.appendChild(e);
  return e;
}

function svgEl<K extends "svg" | "polygon" | "text" | "path" | "circle" | "g">(
  tag: K, attrs: Record<string, string | number>, parent?: SVGElement,
): SVGElement {
  const e = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

function makeInteractive(
  node: SVGElement, label: string, onClick: () => void,
): void {
  node.setAttribute("tabindex", "0");
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", label);
  node.style.cursor = "pointer";
  node.style.outline = "none";
  const activate = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  };
  node.addEventListener("click", activate);
  node.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") activate(ev);
    ev.stopPropagation();
  });
}

/* ── Face naming from the live orientation mapping ─────────────────────── */

interface WidgetRefs {
  container: HTMLDivElement;
  svg: SVGSVGElement;
  faceEls: Record<FaceId, SVGPolygonElement>;
  edgeEls: Record<EdgeId, SVGPolygonElement>;
  cornerEls: Record<CornerId, SVGCircleElement>;
  labelEls: Record<FaceId, SVGTextElement>;
  compassEls: Record<string, SVGTextElement>;
  orientLabel: HTMLDivElement;
}

const FACE_DISPLAY: Record<FaceId, string> = {
  front: "FRONT", back: "BACK", left: "LEFT", right: "RIGHT", top: "TOP", bottom: "BOTTOM",
};

/* ── Setup ─────────────────────────────────────────────────────────────── */

let installed = false;

/** Deferred menu opener: buildWidget closes over it before refs exist. */
let menuOpener: ((x: number, y: number) => void) | null = null;

export function setupViewCube(): void {
  if (installed) return;
  if (!ctx.rightHost || !worldReady()) {
    console.warn("[viewcube] viewer not ready — widget skipped");
    return;
  }
  installed = true;

  const adapter = new RealCameraAdapter();
  adapter.watchSelection();

  const controller = new NavigationController(adapter, {
    storage: safeLocalStorage(),
    projectId: safeProjectId(),
    events: {
      onToast: (kind, message) => notify(kind, message),
      onStateChange: () => transitionPump(),
    },
  });
  realAdapterInstance = adapter;

  // Project switches re-key Home + orientation persistence.
  try {
    onProjectChanged(() => controller.setProjectId(safeProjectId()));
  } catch { /* */ }

  const refs = buildWidget(controller, adapter);
  menuOpener = (x, y) => openNavigationMenu(controller, adapter, x, y, refs);
  wireTransitionLoop(controller);
  wireRenderLoop(controller, refs);
  wireGestureProjectionRestore(controller, adapter);
  exposeApi(controller, refs);
  registerPaletteCommands(controller, refs);
  console.log("[viewcube] ready");
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch { /* */ }
  return null;
}

function safeProjectId(): string | null {
  try { return getCurrentProject()?.id ?? null; } catch { return null; }
}

/* ── Widget construction ───────────────────────────────────────────────── */

function buildWidget(
  controller: NavigationController, adapter: RealCameraAdapter,
): WidgetRefs {
  const container = el("div", "position:absolute;top:14px;right:14px;z-index:40;" +
    "pointer-events:none;user-select:none;-webkit-user-select:none");
  container.id = "obs-viewcube";
  container.setAttribute("aria-label", "ViewCube navigation");

  const card = el("div", "pointer-events:auto;display:flex;flex-direction:column;gap:5px;" +
    "padding:7px 8px 8px;background:rgba(20,22,30,.88);border:1px solid #2a2e3a;" +
    "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.4);backdrop-filter:blur(8px)", container);
  card.oncontextmenu = (e) => e.preventDefault();

  // Header: Home · orientation label · menu
  const header = el("div", "display:flex;align-items:center;gap:6px;height:22px", card);

  const homeBtn = el("button", "display:flex;align-items:center;justify-content:center;" +
    "width:24px;height:22px;border-radius:5px;background:transparent;border:none;" +
    "color:#cbd5e1;cursor:pointer;padding:0", header);
  homeBtn.title = "Go Home (restore the saved Home view)";
  homeBtn.setAttribute("aria-label", "Go Home");
  homeBtn.innerHTML =
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/></svg>`;
  homeBtn.onmouseenter = () => { homeBtn.style.color = "#38bdf8"; };
  homeBtn.onmouseleave = () => { homeBtn.style.color = "#cbd5e1"; };
  homeBtn.onclick = (e) => { e.stopPropagation(); controller.goHome(); };

  const orientLabel = el("div", "flex:1;text-align:center;font:600 10px system-ui,sans-serif;" +
    "color:#9aa5b5;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", header);
  orientLabel.textContent = "Front · Perspective";

  const menuBtn = el("button", "display:flex;align-items:center;justify-content:center;" +
    "width:22px;height:22px;border-radius:5px;background:transparent;border:none;" +
    "color:#cbd5e1;cursor:pointer;font:700 14px/1 system-ui;padding:0", header);
  menuBtn.textContent = "⋮";
  menuBtn.title = "View options (right-click the cube)";
  menuBtn.setAttribute("aria-label", "Open view options menu");
  menuBtn.setAttribute("aria-haspopup", "menu");
  menuBtn.onmouseenter = () => { menuBtn.style.color = "#38bdf8"; };
  menuBtn.onmouseleave = () => { menuBtn.style.color = "#cbd5e1"; };
  menuBtn.onclick = (e) => {
    e.stopPropagation();
    const r = menuBtn.getBoundingClientRect();
    menuOpener?.(r.left, r.bottom + 6);
  };

  // SVG cube
  const svg = svgEl("svg", {
    width: SVG_SIZE, height: SVG_SIZE, viewBox: `0 0 ${SVG_SIZE} ${SVG_SIZE}`,
    display: "block",
  }) as unknown as SVGSVGElement;
  card.appendChild(svg);
  svg.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menuOpener?.(e.clientX, e.clientY);
  });
  svg.addEventListener("pointerdown", (e) => e.stopPropagation());

  const gCompass = svgEl("g", {}, svg);
  const gFaces = svgEl("g", {}, svg);
  const gEdges = svgEl("g", {}, svg);
  const gCorners = svgEl("g", {}, svg);
  const gLabels = svgEl("g", {}, svg);
  const gArrows = svgEl("g", {}, svg);

  // Compass letters (N/E/S/W) — positions updated per frame.
  const compassEls: Record<string, SVGTextElement> = {};
  for (const [id, letter] of [["N", "N"], ["E", "E"], ["S", "S"], ["W", "W"]] as const) {
    const t = svgEl("text", {
      "font-size": 10, "font-weight": 700, "text-anchor": "middle",
      "dominant-baseline": "middle", fill: "#cbd5e1", opacity: 0.9,
      "font-family": "system-ui,sans-serif",
      "paint-order": "stroke", stroke: "rgba(6,8,12,.85)", "stroke-width": 3,
    }, gCompass) as SVGTextElement;
    t.textContent = letter;
    t.setAttribute("data-compass", id);
    compassEls[id] = t;
  }

  // Faces
  const faceEls = {} as Record<FaceId, SVGPolygonElement>;
  for (const f of CUBE_FACES) {
    const p = svgEl("polygon", {
      fill: "#aab3c0", "fill-opacity": 0.35, stroke: "#0f1117", "stroke-width": 1,
      "stroke-linejoin": "round",
    }, gFaces) as SVGPolygonElement;
    makeInteractive(p, `${capitalize(f)} view`, () => { controller.navigateToFace(f); });
    trackHover(p);
    p.addEventListener("mouseenter", () => { p.setAttribute("fill", "#7cc7f7"); p.setAttribute("fill-opacity", "0.6"); });
    p.addEventListener("mouseleave", () => { p.setAttribute("fill", "#aab3c0"); });
    faceEls[f] = p;
  }

  // Edges
  const edgeEls = {} as Record<EdgeId, SVGPolygonElement>;
  for (const e of CUBE_EDGES) {
    const p = svgEl("polygon", {
      fill: "transparent", stroke: "none", "pointer-events": "all",
    }, gEdges) as SVGPolygonElement;
    makeInteractive(p, `${edgeLabel(e)} view`, () => { controller.navigateToEdge(e); });
    p.addEventListener("mouseenter", () => { p.setAttribute("fill", "rgba(56,189,248,.45)"); });
    p.addEventListener("mouseleave", () => { p.setAttribute("fill", "transparent"); });
    edgeEls[e] = p;
  }

  // Corners
  const cornerEls = {} as Record<CornerId, SVGCircleElement>;
  for (const c of CUBE_CORNERS) {
    const circ = svgEl("circle", {
      r: CORNER_HIT_R, fill: "transparent", stroke: "none", "pointer-events": "all",
    }, gCorners) as SVGCircleElement;
    makeInteractive(circ, `${cornerLabel(c)} view`, () => { controller.navigateToCorner(c); });
    circ.addEventListener("mouseenter", () => { circ.setAttribute("fill", "rgba(56,189,248,.5)"); });
    circ.addEventListener("mouseleave", () => { circ.setAttribute("fill", "transparent"); });
    cornerEls[c] = circ;
  }

  // Face labels
  const labelEls = {} as Record<FaceId, SVGTextElement>;
  for (const f of CUBE_FACES) {
    const t = svgEl("text", {
      "font-size": 8.6, "font-weight": 700, "text-anchor": "middle",
      "dominant-baseline": "middle", fill: "#f2f5f9", "letter-spacing": ".5",
      "font-family": "system-ui,sans-serif", "pointer-events": "none",
      "paint-order": "stroke", stroke: "rgba(6,8,12,.8)", "stroke-width": 2.4,
    }, gLabels) as SVGTextElement;
    t.textContent = FACE_DISPLAY[f];
    labelEls[f] = t;
  }

  buildRotationArrows(gArrows, controller);

  (ctx.rightHost as HTMLElement).appendChild(container);

  return { container, svg, faceEls, edgeEls, cornerEls, labelEls, compassEls, orientLabel };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function edgeLabel(e: EdgeId): string {
  return e.split("-").map(capitalize).join(" ");
}

function cornerLabel(c: CornerId): string {
  return c.split("-").map(capitalize).join(" ");
}

/* ── Rotation arrows ───────────────────────────────────────────────────── */

interface ArrowDef {
  angleDeg: number;
  sweep: 1 | -1;
  title: string;
  run: (c: NavigationController) => unknown;
}

const ARROW_DEFS: readonly ArrowDef[] = [
  { angleDeg: 135, sweep: -1, title: "Rotate left (counterclockwise) — hold to repeat", run: (c) => c.rotateLeft() },
  { angleDeg: 45, sweep: 1, title: "Rotate right (clockwise) — hold to repeat", run: (c) => c.rotateRight() },
  { angleDeg: 225, sweep: -1, title: "Rotate up — hold to repeat", run: (c) => c.rotateUp() },
  { angleDeg: 315, sweep: 1, title: "Rotate down — hold to repeat", run: (c) => c.rotateDown() },
];

function buildRotationArrows(parent: SVGElement, controller: NavigationController): void {
  for (const def of ARROW_DEFS) {
    const g = svgEl("g", {}, parent) as SVGGElement;
    const rad = (def.angleDeg * Math.PI) / 180;
    const px = CX + Math.cos(rad) * RING_RADIUS;
    const py = CY - Math.sin(rad) * RING_RADIUS;

    // Curved arc around the widget center through the anchor point.
    const rArc = RING_RADIUS;
    const span = 26 * (Math.PI / 180) * def.sweep;
    const a0 = rad - span / 2, a1 = rad + span / 2;
    const x0 = CX + Math.cos(a0) * rArc, y0 = CY - Math.sin(a0) * rArc;
    const x1 = CX + Math.cos(a1) * rArc, y1 = CY - Math.sin(a1) * rArc;
    const sweepFlag = def.sweep === 1 ? 0 : 1; // SVG y-axis is flipped
    const arc = svgEl("path", {
      d: `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${rArc} ${rArc} 0 0 ${sweepFlag} ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      fill: "none", stroke: "#94a3b8", "stroke-width": 1.8, "stroke-linecap": "round",
    }, g);

    // Arrowhead at the trailing end.
    const tx = CX + Math.cos(a1) * rArc, ty = CY - Math.sin(a1) * rArc;
    const tang = def.sweep === 1 ? a1 + Math.PI / 2 : a1 - Math.PI / 2;
    const hx = Math.cos(tang), hy = -Math.sin(tang);
    const pxp = -hy, pyp = hx;
    const head = svgEl("polygon", {
      points: [
        [tx + hx * 5, ty + hy * 5],
        [tx - hx * 2 + pxp * 3, ty - hy * 2 + pyp * 3],
        [tx - hx * 2 - pxp * 3, ty - hy * 2 - pyp * 3],
      ].map((p) => p.map((n) => n.toFixed(2)).join(",")).join(" "),
      fill: "#94a3b8",
    }, g);

    const hit = svgEl("circle", {
      cx: px, cy: py, r: 10, fill: "transparent", "pointer-events": "all",
    }, g);

    const activate = () => { def.run(controller); };
    makeInteractive(hit, def.title.replace(" — hold to repeat", ""), activate);
    let holdTimer: number | null = null;
    hit.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const period = controller.config.rotateHoldMs;
      holdTimer = window.setInterval(activate, Math.max(80, period));
      const stop = () => {
        if (holdTimer != null) { window.clearInterval(holdTimer); holdTimer = null; }
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    });
    hit.addEventListener("mouseenter", () => { arc.setAttribute("stroke", "#38bdf8"); head.setAttribute("fill", "#38bdf8"); });
    hit.addEventListener("mouseleave", () => { arc.setAttribute("stroke", "#94a3b8"); head.setAttribute("fill", "#94a3b8"); });
    hit.addEventListener("click", (e) => e.stopPropagation());
  }
}

/* ── Hover tracking (render must not fight hover feedback) ─────────────── */

const hoveredEls = new WeakSet<SVGElement>();

function trackHover(node: SVGElement): void {
  node.addEventListener("mouseenter", () => hoveredEls.add(node));
  node.addEventListener("mouseleave", () => hoveredEls.delete(node));
}

/* ── Live render loop ──────────────────────────────────────────────────── */

function wireRenderLoop(controller: NavigationController, refs: WidgetRefs): void {
  let rafPending = 0;

  const render = () => {
    if (!worldReady()) return;
    const cam = activeCam();
    const q = cam.quaternion as THREE.Quaternion;
    const qInv: Quat = { x: -q.x, y: -q.y, z: -q.z, w: q.w };

    const pc = projectCube({ qInv, scale: CUBE_SCALE, cx: CX, cy: CY });

    // Face labels follow the live orientation mapping (custom Front/Top).
    const faceName = faceNameLookup(controller);

    // Faces — painter's order (farthest first), then visibility/hover states.
    const order = CUBE_FACES.slice().sort((a, b) => pc.depth[b] - pc.depth[a]);
    for (const f of order) {
      const poly = refs.faceEls[f];
      if (!pc.visible[f]) {
        poly.setAttribute("visibility", "hidden");
        poly.setAttribute("pointer-events", "none");
        continue;
      }
      poly.setAttribute("visibility", "visible");
      poly.setAttribute("pointer-events", "all");
      poly.setAttribute("points", facePoints(pc, f));
      if (!hoveredEls.has(poly)) {
        poly.setAttribute("fill-opacity", (0.26 + 0.5 * pc.facing[f]).toFixed(3));
      }
    }
    // Re-append in depth order (appendChild moves existing nodes).
    const gFaces = refs.faceEls.front.parentElement;
    if (gFaces) for (const f of order) gFaces.appendChild(refs.faceEls[f]);

    // Current-orientation highlight.
    const current = controller.currentOrientation();
    for (const f of CUBE_FACES) {
      const active = current.kind === "face" && current.id === f && pc.visible[f];
      refs.faceEls[f].setAttribute("stroke", active ? "#38bdf8" : "#0f1117");
      refs.faceEls[f].setAttribute("stroke-width", active ? "1.8" : "1");
    }

    // Edges
    for (const e of CUBE_EDGES) {
      const poly = refs.edgeEls[e];
      if (!pc.edgeVisible[e]) {
        poly.setAttribute("visibility", "hidden");
        poly.setAttribute("pointer-events", "none");
        continue;
      }
      poly.setAttribute("visibility", "visible");
      poly.setAttribute("pointer-events", "all");
      poly.setAttribute("points", edgeStripPoints(pc, e, EDGE_HIT_WIDTH));
    }

    // Corners
    for (const c of CUBE_CORNERS) {
      const circ = refs.cornerEls[c];
      if (!pc.cornerVisible[c]) {
        circ.setAttribute("visibility", "hidden");
        circ.setAttribute("pointer-events", "none");
        continue;
      }
      const [x, y] = pc.screen[CUBE_GRAPH.corners[c].v];
      circ.setAttribute("visibility", "visible");
      circ.setAttribute("pointer-events", "all");
      circ.setAttribute("cx", x.toFixed(2));
      circ.setAttribute("cy", y.toFixed(2));
    }

    // Labels
    for (const f of CUBE_FACES) {
      const t = refs.labelEls[f];
      if (!pc.visible[f]) { t.setAttribute("visibility", "hidden"); continue; }
      const verts = CUBE_GRAPH.faces[f].vertices;
      let sx = 0, sy = 0;
      for (const k of verts) { sx += pc.screen[k][0]; sy += pc.screen[k][1]; }
      t.setAttribute("visibility", "visible");
      t.setAttribute("x", (sx / 4).toFixed(2));
      t.setAttribute("y", (sy / 4).toFixed(2));
      t.setAttribute("opacity", (0.45 + 0.55 * pc.facing[f]).toFixed(3));
      t.textContent = faceName[f];
    }

    // Compass ring (N/E/S/W) honoring Project/True North.
    const tna = safeNorthAngle();
    const dirs: Record<string, Vec3> = {
      N: { x: Math.sin(rad(tna)), y: 0, z: Math.cos(rad(tna)) },
      E: { x: Math.sin(rad(tna + 90)), y: 0, z: Math.cos(rad(tna + 90)) },
      S: { x: Math.sin(rad(tna + 180)), y: 0, z: Math.cos(rad(tna + 180)) },
      W: { x: Math.sin(rad(tna + 270)), y: 0, z: Math.cos(rad(tna + 270)) },
    };
    for (const id of Object.keys(dirs)) {
      const t = refs.compassEls[id];
      const p = compassScreenPos(dirs[id], { qInv, cx: CX, cy: CY }, RING_RADIUS);
      const planar = Math.hypot(p.x - CX, p.y - CY);
      if (planar < 14) { t.setAttribute("opacity", "0"); continue; } // pointing at the viewer
      t.setAttribute("x", p.x.toFixed(2));
      t.setAttribute("y", p.y.toFixed(2));
      t.setAttribute("opacity", (0.9 - 0.55 * p.behind).toFixed(3));
    }

    // Orientation label
    const mode = controller.projectionMode();
    refs.orientLabel.textContent = `${current.label} · ${MODE_LABEL[mode]}`;
    refs.container.title =
      `Current view: ${current.label} (${MODE_LABEL[mode]})\n` +
      `Click faces, edges or corners to navigate · Right-click for options`;
  };

  const markDirty = () => {
    if (rafPending) return;
    rafPending = requestAnimationFrame(() => {
      rafPending = 0;
      try { render(); } catch (err) { console.warn("[viewcube] render failed", err); }
    });
  };

  try { controls().addEventListener("update", markDirty); } catch { /* */ }
  window.addEventListener("resize", markDirty);
  try { onNorthChanged(() => markDirty()); } catch { /* */ }
  markDirty();
}

function rad(d: number): number { return (d * Math.PI) / 180; }

function safeNorthAngle(): number {
  try { return getNorthState().trueNorthAngle || 0; } catch { return 0; }
}

/**
 * Map each world cube face to its name under the live orientation mapping
 * (Set-current-view-as-Front/Top renames the whole cube).
 */
function faceNameLookup(controller: NavigationController): Record<FaceId, string> {
  const mapping = controller.orientationMapping();
  // Derive all six face directions from the mapping anchors.
  const f = mapping.front;
  const rightDir = f.up.clone().cross(f.dir).normalize();
  const t = mapping.top;
  const map: Array<[FaceId, THREE.Vector3]> = [
    ["front", f.dir], ["back", f.dir.clone().negate()],
    ["right", rightDir], ["left", rightDir.clone().negate()],
    ["top", t.dir], ["bottom", t.dir.clone().negate()],
  ];
  // World face outward normals:
  const worldNormals: Record<FaceId, THREE.Vector3> = {
    front: new THREE.Vector3(0, 0, 1), back: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0), left: new THREE.Vector3(-1, 0, 0),
    top: new THREE.Vector3(0, 1, 0), bottom: new THREE.Vector3(0, -1, 0),
  };
  const out = {} as Record<FaceId, string>;
  for (const wf of CUBE_FACES) {
    let best = "face", bestDot = -2;
    for (const [name, dir] of map) {
      const d = worldNormals[wf].dot(dir);
      if (d > bestDot) { bestDot = d; best = name; }
    }
    out[wf] = FACE_DISPLAY[best as FaceId] ?? FACE_DISPLAY[wf];
  }
  return out;
}

/* ── Transition driver ─────────────────────────────────────────────────── */

/** Starts/stops the rAF loop that advances NavigationController transitions. */
let transitionPump: () => void = () => {};

function wireTransitionLoop(controller: NavigationController): void {
  let raf: number | null = null;
  let last: number | null = null;

  const step = (now: number) => {
    raf = null;
    const dt = last == null ? 16 : Math.min(64, now - last);
    last = now;
    const active = controller.tick(dt);
    if (active) raf = requestAnimationFrame(step);
    else last = null;
  };

  transitionPump = () => {
    if (raf == null && controller.isTransitioning()) {
      last = null;
      raf = requestAnimationFrame(step);
    }
  };
}

/* ── Gesture-driven projection restore (Perspective with Ortho Faces) ──── */

function wireGestureProjectionRestore(controller: NavigationController, adapter: RealCameraAdapter): void {
  adapter.onUserGesture(() => {
    if (controller.projectionMode() === "perspective-ortho-faces" &&
        adapter.projection() === "orthographic" &&
        !controller.isTransitioning()) {
      adapter.setProjection("perspective");
    }
  });
}

/* ── Command wiring + palette ──────────────────────────────────────────── */

function runCommand(fn: () => unknown): void {
  // onStateChange (wired at controller construction) drives the transition
  // loop, so any command that starts a transition animates immediately.
  void fn();
}

function exposeApi(controller: NavigationController, refs: WidgetRefs): void {
  const w = window as any;
  w.__obsNavigation = {
    controller,
    isVisible: () => refs.container.style.display !== "none",
    show: () => {
      refs.container.style.display = "";
      window.dispatchEvent(new CustomEvent("obs-viewcube-visibility", { detail: { visible: true } }));
    },
    hide: () => {
      refs.container.style.display = "none";
      window.dispatchEvent(new CustomEvent("obs-viewcube-visibility", { detail: { visible: false } }));
    },
    openMenu: (x?: number, y?: number) => {
      const r = refs.container.getBoundingClientRect();
      if (!realAdapterInstance) return;
      openNavigationMenu(controller, realAdapterInstance, x ?? r.right - 40, y ?? r.top + 30, refs);
    },
    version: APP_VERSION,
  };
  (ctx.features as any).viewCube = w.__obsNavigation;
}

/** Registered by exposeApi; the adapter instance for this boot. */
let realAdapterInstance: RealCameraAdapter | null = null;

function registerPaletteCommands(controller: NavigationController, refs: WidgetRefs): void {
  import("./command-palette").then((m) => {
    const reg = (id: string, label: string, hint: string, run: () => unknown) =>
      m.registerCommand({ id, label, category: "View", hint, run: () => runCommand(run) });
    reg("nav-go-home", "Go Home", "Restore the saved Home view", () => controller.goHome());
    reg("nav-ortho", "Orthographic View", "Switch to parallel (orthographic) projection", () => controller.setProjectionMode("orthographic"));
    reg("nav-persp", "Perspective View", "Switch to perspective projection", () => controller.setProjectionMode("perspective"));
    reg("nav-pwof", "Perspective with Ortho Faces", "Perspective orbiting with orthographic face snaps", () => controller.setProjectionMode("perspective-ortho-faces"));
    reg("nav-set-home", "Set current view as Home", "Save the current view as the Home view", () => controller.setCurrentViewAsHome());
    reg("nav-focus-home", "Focus and set as Home", "Frame the selection (or model) and save it as Home", () => focusAndSetHome(controller));
    reg("nav-reset-home", "Reset Home", "Restore the default Home configuration", () => controller.resetHome());
    reg("nav-set-front", "Set current view as Front", "Define the current orientation as Front", () => controller.setCurrentViewAsFront());
    reg("nav-set-top", "Set current view as Top", "Define the current orientation as Top", () => controller.setCurrentViewAsTop());
    reg("nav-reset-orientation", "Reset orientation", "Restore the default project orientation", () => controller.resetOrientation());
    void refs;
  }).catch((e) => console.warn("[viewcube] palette registration failed", e));
}

/** Resolve selection bounds (async) then focus + save Home. */
async function focusAndSetHome(controller: NavigationController): Promise<unknown> {
  const sel: any = tryUse("selection") ?? (ctx.features as any).selection;
  let bounds: THREE.Box3 | null | undefined;
  try {
    bounds = sel?.boundingBox ? await Promise.resolve(sel.boundingBox()) : undefined;
  } catch { bounds = undefined; }
  return controller.focusAndSetHome(bounds ?? undefined);
}

/* ── Navigation menu (the Home context menu) ───────────────────────── */

interface MenuItemDef {
  label: string;
  hint?: string;
  kind?: "command" | "radio";
  checked?: boolean;
  disabled?: boolean;
  run?: () => unknown;
  separatorBefore?: boolean;
}

let openMenuEl: HTMLDivElement | null = null;

function closeNavigationMenu(): void {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
}

function openNavigationMenu(
  controller: NavigationController,
  adapter: RealCameraAdapter,
  x: number, y: number,
  refs: WidgetRefs,
): void {
  closeNavigationMenu();

  const mode = controller.projectionMode();
  const hasModel = !!adapter.sceneBounds();

  const items: MenuItemDef[] = [
    { label: "Go Home", hint: "Restore the saved Home view", run: () => controller.goHome() },
    { label: "Orthographic", kind: "radio", checked: mode === "orthographic", run: () => controller.setProjectionMode("orthographic") },
    { label: "Perspective", kind: "radio", checked: mode === "perspective", run: () => controller.setProjectionMode("perspective") },
    { label: "Perspective with Ortho Faces", kind: "radio", checked: mode === "perspective-ortho-faces", hint: "Perspective orbiting; cube faces snap to orthographic views", run: () => controller.setProjectionMode("perspective-ortho-faces") },
    { label: "Set current view as Home", run: () => controller.setCurrentViewAsHome(), separatorBefore: true },
    { label: "Focus and set as Home", hint: hasModel ? "Frame the selection (or model) and save it as Home" : "No model loaded", disabled: !hasModel, run: () => { void focusAndSetHome(controller); } },
    { label: "Reset Home", run: () => controller.resetHome() },
    { label: "Set current view as Front", run: () => controller.setCurrentViewAsFront(), separatorBefore: true },
    { label: "Set current view as Top", run: () => controller.setCurrentViewAsTop() },
    { label: "Reset orientation", run: () => controller.resetOrientation() },
  ];

  const menu = el("div", "position:fixed;z-index:9600;min-width:240px;padding:4px 0;" +
    "background:#1c1e28;color:#e8eaf0;border:1px solid #2a2e3a;border-radius:8px;" +
    "box-shadow:0 18px 46px rgba(0,0,0,.55);font:12.5px system-ui,sans-serif;user-select:none");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "ViewCube navigation options");

  const focusables: HTMLDivElement[] = [];

  for (const item of items) {
    if (item.separatorBefore) {
      el("div", "height:1px;background:#2a2e3a;margin:4px 0", menu);
    }
    const row = el("div",
      "display:flex;align-items:center;gap:9px;padding:7px 14px;cursor:pointer;outline:none",
      menu);
    row.setAttribute("role", item.kind === "radio" ? "menuitemradio" : "menuitem");
    if (item.kind === "radio") row.setAttribute("aria-checked", String(!!item.checked));
    if (item.hint) row.title = item.hint;

    const mark = el("span", "width:14px;flex:none;text-align:center;font-weight:700;color:#38bdf8", row);
    mark.textContent = item.checked ? "\u2713" : "";

    const label = el("span", item.disabled ? "flex:1;opacity:.4" : "flex:1", row);
    label.textContent = item.label;

    if (item.disabled) {
      row.style.cursor = "default";
    } else {
      focusables.push(row);
      row.tabIndex = -1;
      row.onmouseenter = () => { row.style.background = "rgba(56,189,248,.14)"; };
      row.onmouseleave = () => { row.style.background = "transparent"; };
      row.onclick = (e) => {
        e.stopPropagation();
        closeNavigationMenu();
        runCommand(() => item.run?.());
      };
    }
  }

  // Viewport-safe positioning.
  document.body.appendChild(menu);
  const mw = menu.offsetWidth || 240;
  const mh = menu.offsetHeight || 320;
  let px = x, py = y;
  if (px + mw > window.innerWidth - 8) px = window.innerWidth - mw - 8;
  if (py + mh > window.innerHeight - 8) py = Math.max(8, y - mh - 12);
  menu.style.left = `${Math.max(8, px)}px`;
  menu.style.top = `${Math.max(8, py)}px`;

  // Close on outside pointerdown (capture so viewport clicks never leak in).
  const outside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) closeNavigationMenu();
  };
  window.addEventListener("pointerdown", outside, true);
  menu.addEventListener("keydown", (e: KeyboardEvent) => {
    e.stopPropagation();
    const idx = focusables.indexOf(document.activeElement as HTMLDivElement);
    if (e.key === "Escape") {
      // Escape closes the menu AND cancels an active navigation animation.
      controller.cancelTransition();
      closeNavigationMenu();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusables[Math.min(focusables.length - 1, idx + 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusables[Math.max(0, idx - 1)]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      focusables[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      focusables[focusables.length - 1]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      (document.activeElement as HTMLDivElement)?.click?.();
    }
  });
  const obs = new MutationObserver(() => {
    if (!document.body.contains(menu)) {
      window.removeEventListener("pointerdown", outside, true);
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true });

  openMenuEl = menu;
  focusables[0]?.focus();
  void refs;
}
