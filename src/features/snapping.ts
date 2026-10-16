/**
 * Object snap system (AutoCAD / Revit class).
 *
 * Each snap type has:
 *   - A priority level. Higher priority wins over a closer low-priority
 *     snap — same as Revit. Endpoint (100) beats Nearest (55) even if
 *     Nearest is a few pixels closer.
 *   - A distinctive SVG marker drawn at the snapped point.
 *   - A short label shown next to the marker.
 *
 * Snaps are gated by the current tool — dims prefer endpoints/corners/faces;
 * wall placement prefers grid/endpoint/midpoint.
 */
import * as THREE from "three";
import { ctx } from "../core/context";

export type SnapType =
  | "endpoint"
  | "intersection"
  | "corner"
  | "midpoint"
  | "center"
  | "perpendicular"
  | "tangent"
  | "quadrant"
  | "vertex"
  | "face"
  | "nearest"
  | "parallel"
  | "extension"
  | "grid";

export interface SnapResult {
  point: THREE.Vector3;
  type: SnapType;
  screenDist: number;
}

/** Priority table — higher wins. Matches Revit's hierarchy. */
const SNAP_PRIORITY: Record<SnapType, number> = {
  endpoint:      100,
  intersection:   95,
  corner:         92,
  midpoint:       90,
  center:         85,
  perpendicular:  80,
  tangent:        75,
  quadrant:       70,
  vertex:         65,
  face:           60,
  nearest:        55,
  parallel:       45,
  extension:      40,
  grid:           15,
};

const ALL_TYPES: SnapType[] = [
  "endpoint", "intersection", "corner", "midpoint", "center",
  "perpendicular", "tangent", "quadrant", "vertex", "face",
  "nearest", "parallel", "extension", "grid",
];

/* Revit-style SVG markers — 32×32 viewBox. */
const SVG_MARKER: Record<SnapType, string> = {
  endpoint:
    `<rect x="9" y="9" width="14" height="14" fill="#F59E0B" stroke="#0B0D12" stroke-width="2"/>`,
  intersection:
    `<path d="M6 6 L26 26 M26 6 L6 26" stroke="#EF4444" stroke-width="3" fill="none" stroke-linecap="round"/>`,
  corner:
    `<path d="M8 8 L8 24 L24 24" stroke="#FBBF24" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="8" cy="8" r="2.5" fill="#FBBF24"/>`,
  midpoint:
    `<polygon points="16,8 26,24 6,24" fill="#22C55E" stroke="#0B0D12" stroke-width="2" stroke-linejoin="round"/>`,
  center:
    `<circle cx="16" cy="16" r="9" fill="none" stroke="#38BDF8" stroke-width="2.5"/>` +
    `<circle cx="16" cy="16" r="2.4" fill="#38BDF8"/>`,
  perpendicular:
    `<path d="M8 8 L8 26 L26 26" stroke="#C084FC" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<rect x="8" y="20" width="6" height="6" fill="#C084FC"/>`,
  tangent:
    `<circle cx="18" cy="18" r="8" fill="none" stroke="#F472B6" stroke-width="2.5"/>` +
    `<line x1="3" y1="10" x2="29" y2="10" stroke="#F472B6" stroke-width="2.5" stroke-linecap="round"/>`,
  quadrant:
    `<circle cx="16" cy="16" r="9" fill="none" stroke="#34D399" stroke-width="2"/>` +
    `<circle cx="16" cy="7" r="2" fill="#34D399"/>` +
    `<circle cx="25" cy="16" r="2" fill="#34D399"/>` +
    `<circle cx="16" cy="25" r="2" fill="#34D399"/>` +
    `<circle cx="7" cy="16" r="2" fill="#34D399"/>`,
  vertex:
    `<rect x="11" y="11" width="10" height="10" fill="#38BDF8" stroke="#0B0D12" stroke-width="2" transform="rotate(45 16 16)"/>`,
  face:
    `<rect x="8" y="8" width="16" height="16" fill="none" stroke="#38BDF8" stroke-width="2"/>` +
    `<circle cx="16" cy="16" r="2.6" fill="#38BDF8"/>`,
  nearest:
    `<circle cx="16" cy="16" r="4" fill="#F59E0B"/>` +
    `<circle cx="16" cy="16" r="9" fill="none" stroke="#F59E0B" stroke-width="1.5" opacity="0.55"/>`,
  parallel:
    `<path d="M8 12 H24 M8 20 H24" stroke="#A78BFA" stroke-width="2.5" stroke-linecap="round"/>`,
  extension:
    `<path d="M4 16 H28 M22 10 L28 16 L22 22" stroke="#F472B6" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  grid:
    `<path d="M6 16 H26 M16 6 V26" stroke="#38BDF8" stroke-width="2" stroke-linecap="round"/>` +
    `<circle cx="16" cy="16" r="3" fill="none" stroke="#38BDF8" stroke-width="1.5"/>`,
};

const SVG_LABEL: Record<SnapType, string> = {
  endpoint:       "End",
  intersection:   "Int",
  corner:         "Corner",
  midpoint:       "Mid",
  center:         "Cen",
  perpendicular:  "Perp",
  tangent:        "Tan",
  quadrant:       "Quad",
  vertex:         "Vtx",
  face:           "Face",
  nearest:        "Near",
  parallel:       "Par",
  extension:      "Ext",
  grid:           "Grid",
};

type AuthoredLite = {
  id: string;
  type: string;
  params: {
    start?: [number, number];
    end?: [number, number];
    point?: [number, number];
    polygon?: [number, number][];
    elevation?: number;
    height?: number;
    width?: number;
    depth?: number;
    thickness?: number;
  };
};

function getAuthoredSafe(): AuthoredLite[] {
  try {
    const mod = (window as any).__obsAuthoring;
    if (mod?.getElements) return mod.getElements() as AuthoredLite[];
  } catch { /* */ }
  try {
    const auth = (ctx.features as any)?.authoring;
    if (auth?.getElements) return auth.getElements();
  } catch { /* */ }
  return [];
}

class SnapManager {
  private enabled = true;
  private types: Set<SnapType> = new Set(ALL_TYPES);
  private gridSize = 0.1;
  private pixelTolerance = 16;
  private workPlaneY = 0;

  private orthoOn = false;
  private orthoBase: THREE.Vector3 | null = null;
  private orthoAxis: "x" | "y" | "z" | null = null;

  private overlay: HTMLDivElement | null = null;
  private marker: HTMLDivElement | null = null;
  private label: HTMLDivElement | null = null;

  private lastPointer = { x: 0, y: 0 };

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.hideIndicator();
  }
  isEnabled() { return this.enabled; }

  setGridSize(m: number) { this.gridSize = Math.max(0.001, m); }
  getGridSize() { return this.gridSize; }
  setPixelTolerance(px: number) { this.pixelTolerance = Math.max(4, px); }
  getPixelTolerance() { return this.pixelTolerance; }
  setWorkPlaneY(y: number) { this.workPlaneY = y; }
  getWorkPlaneY() { return this.workPlaneY; }

  setTypes(types: SnapType[]) { this.types = new Set(types); }
  getTypes(): SnapType[] { return [...this.types]; }
  getAllTypes(): SnapType[] { return [...ALL_TYPES]; }

  toggleType(t: SnapType, on?: boolean) {
    const enable = on ?? !this.types.has(t);
    if (enable) this.types.add(t);
    else this.types.delete(t);
  }
  enableAllTypes() { this.types = new Set(ALL_TYPES); }
  disableAllTypes() { this.types.clear(); }

  setOrtho(on: boolean, base: THREE.Vector3 | null, axis: "x" | "y" | "z" | null = null) {
    this.orthoOn = on;
    this.orthoBase = base ? base.clone() : null;
    this.orthoAxis = axis;
  }
  clearOrtho() {
    this.orthoOn = false;
    this.orthoBase = null;
    this.orthoAxis = null;
  }
  isOrtho() { return this.orthoOn; }

  private ensureOverlay() {
    if (this.overlay) return;
    try {
      const host = ctx.rightHost;
      if (!host) return;
      this.overlay = document.createElement("div");
      this.overlay.style.cssText =
        "position:absolute;inset:0;pointer-events:none;z-index:22;overflow:hidden";
      this.marker = document.createElement("div");
      this.marker.style.cssText =
        "position:absolute;width:32px;height:32px;transform:translate(-50%,-50%);display:none";
      this.label = document.createElement("div");
      this.label.style.cssText =
        "position:absolute;transform:translate(-50%,calc(-100% - 18px));" +
        "font:700 10px system-ui,sans-serif;color:#0B0D12;background:#FBBF24;" +
        "padding:2px 7px;border-radius:3px;white-space:nowrap;display:none;" +
        "box-shadow:0 2px 6px rgba(0,0,0,.35);letter-spacing:.2px";
      this.overlay.append(this.marker, this.label);
      host.appendChild(this.overlay);
    } catch (e) {
      console.warn("[snap] overlay init failed", e);
    }
  }

  showIndicator(result: SnapResult | null) {
    try {
      this.ensureOverlay();
      if (!result || !this.marker || !this.label || !ctx.world?.camera?.three) {
        if (this.marker) this.marker.style.display = "none";
        if (this.label) this.label.style.display = "none";
        return;
      }
      const cam = ctx.world.camera.three;
      const p = result.point.clone().project(cam);
      const rect = ctx.rightHost.getBoundingClientRect();
      const x = (p.x * 0.5 + 0.5) * rect.width;
      const y = (-p.y * 0.5 + 0.5) * rect.height;
      this.marker.innerHTML = `<svg width="32" height="32" viewBox="0 0 32 32">${SVG_MARKER[result.type]}</svg>`;
      this.marker.style.left = `${x}px`;
      this.marker.style.top = `${y}px`;
      this.marker.style.display = "block";
      this.label.textContent = SVG_LABEL[result.type];
      // Match label color to marker color
      const colorByType: Partial<Record<SnapType, string>> = {
        endpoint: "#F59E0B",
        intersection: "#EF4444",
        corner: "#FBBF24",
        midpoint: "#22C55E",
        center: "#38BDF8",
        perpendicular: "#C084FC",
        tangent: "#F472B6",
        quadrant: "#34D399",
        vertex: "#38BDF8",
        face: "#38BDF8",
        nearest: "#F59E0B",
        parallel: "#A78BFA",
        extension: "#F472B6",
        grid: "#38BDF8",
      };
      this.label.style.background = colorByType[result.type] ?? "#FBBF24";
      this.label.style.left = `${x}px`;
      this.label.style.top = `${y}px`;
      this.label.style.display = "block";
    } catch { /* never crash the modeling loop */ }
  }

  hideIndicator() { this.showIndicator(null); }

  /** Best snap for a pointer event. Priority-aware, never throws. */
  async query(e: MouseEvent, cursorWorld: THREE.Vector3 | null): Promise<SnapResult | null> {
    try {
      if (!this.enabled) return null;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      const host = ctx.rightHost;
      if (!host || !ctx.world?.camera?.three) return null;
      const rect = host.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;

      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );

      const candidates: SnapResult[] = [];
      const add = (point: THREE.Vector3, type: SnapType) => {
        const px = this.screenDistToPointer(point, rect, e.clientX, e.clientY);
        if (px <= this.pixelTolerance) {
          candidates.push({ point: point.clone(), type, screenDist: px });
        }
      };

      // Grid snap
      if (this.types.has("grid") && cursorWorld) {
        const g = this.gridSize;
        const gp = new THREE.Vector3(
          Math.round(cursorWorld.x / g) * g,
          this.workPlaneY,
          Math.round(cursorWorld.z / g) * g,
        );
        add(gp, "grid");
      }

      // Authored element snaps (endpoint, midpoint, center, corner, face, quadrant)
      const authored = getAuthoredSafe();
      for (const el of authored) {
        this.collectAuthoredSnaps(el, add, authored);
      }

      // Raycast — nearest + vertex
      if (this.types.has("nearest") || this.types.has("vertex") || this.types.has("face")) {
        try {
          const ray = new THREE.Raycaster();
          ray.setFromCamera(ndc, ctx.world.camera.three);
          const targets: THREE.Object3D[] = [];
          if (ctx.groundPlane) targets.push(ctx.groundPlane);
          if (ctx.fragments?.list) {
            for (const [, model] of ctx.fragments.list) {
              if (model?.object) targets.push(model.object);
            }
          }
          if (targets.length) {
            const hits = ray.intersectObjects(targets, true);
            if (hits.length && this.types.has("nearest")) {
              add(hits[0].point, "nearest");
            }
          }
        } catch { /* raycast can fail on disposed geometry */ }
      }

      // Ortho constraint — project candidates onto the axis
      if (this.orthoOn && this.orthoBase) {
        for (const c of candidates) {
          const d = c.point.clone().sub(this.orthoBase);
          if (this.orthoAxis === "x") {
            c.point.set(this.orthoBase.x + d.x, this.orthoBase.y, this.orthoBase.z);
          } else if (this.orthoAxis === "y") {
            c.point.set(this.orthoBase.x, this.orthoBase.y + d.y, this.orthoBase.z);
          } else if (this.orthoAxis === "z") {
            c.point.set(this.orthoBase.x, this.orthoBase.y, this.orthoBase.z + d.z);
          } else {
            const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
            if (ax >= ay && ax >= az) c.point.set(this.orthoBase.x + d.x, this.orthoBase.y, this.orthoBase.z);
            else if (ay >= az) c.point.set(this.orthoBase.x, this.orthoBase.y + d.y, this.orthoBase.z);
            else c.point.set(this.orthoBase.x, this.orthoBase.y, this.orthoBase.z + d.z);
          }
          c.screenDist = this.screenDistToPointer(c.point, rect, e.clientX, e.clientY);
        }
      }

      if (!candidates.length) return null;

      // Priority-aware sort — a higher-priority snap wins over a closer
      // lower-priority one, exactly like Revit.
      candidates.sort((a, b) => {
        const pa = SNAP_PRIORITY[a.type] ?? 0;
        const pb = SNAP_PRIORITY[b.type] ?? 0;
        if (pa !== pb) return pb - pa;
        return a.screenDist - b.screenDist;
      });

      return candidates[0];
    } catch (err) {
      console.warn("[snap] query failed", err);
      return null;
    }
  }

  private collectAuthoredSnaps(
    el: AuthoredLite,
    add: (p: THREE.Vector3, t: SnapType) => void,
    all: readonly AuthoredLite[],
  ) {
    try {
      const y = el.params.elevation ?? this.workPlaneY;
      const p = el.params;

      if (p.start && p.end) {
        const a = new THREE.Vector3(p.start[0], y, p.start[1]);
        const b = new THREE.Vector3(p.end[0], y, p.end[1]);
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const L = Math.hypot(dx, dz) || 1;
        const ux = dx / L;
        const uz = dz / L;
        const nx = -uz;
        const nz = ux;

        if (this.types.has("endpoint")) { add(a, "endpoint"); add(b, "endpoint"); }

        if (this.types.has("midpoint")) {
          add(new THREE.Vector3((a.x + b.x) / 2, y, (a.z + b.z) / 2), "midpoint");
        }

        // Corner — this endpoint coincides with another element's endpoint
        if (this.types.has("corner")) {
          const tol = 0.2;
          for (const endpoint of [a, b]) {
            for (const other of all) {
              if (other.id === el.id) continue;
              const op = other.params;
              if (!op.start || !op.end) continue;
              const oy = op.elevation ?? this.workPlaneY;
              const os = new THREE.Vector3(op.start[0], oy, op.start[1]);
              const oe = new THREE.Vector3(op.end[0], oy, op.end[1]);
              if (endpoint.distanceTo(os) < tol || endpoint.distanceTo(oe) < tol) {
                add(endpoint, "corner");
                break;
              }
            }
          }
        }

        // Face — sample points along both faces of a wall-like element
        if (this.types.has("face")) {
          const half = Math.max(0.02, (p.thickness ?? 0.2) / 2);
          const faceTypes = new Set(["wall", "duct", "pipe", "cable-tray", "conduit", "beam", "strip"]);
          if (faceTypes.has(el.type)) {
            for (const t of [0.25, 0.5, 0.75]) {
              const cx = a.x + dx * t;
              const cz = a.z + dz * t;
              add(new THREE.Vector3(cx + nx * half, y, cz + nz * half), "face");
              add(new THREE.Vector3(cx - nx * half, y, cz - nz * half), "face");
            }
          }
        }

        // Tangent — only meaningful for arc-based elements; skip silently
        // for linear elements. Activate when arc elements exist.

        // Extension — points slightly beyond each end
        if (this.types.has("extension")) {
          add(a.clone().addScaledVector(new THREE.Vector3(ux, 0, uz), -0.5), "extension");
          add(b.clone().addScaledVector(new THREE.Vector3(ux, 0, uz), 0.5), "extension");
        }
      }

      if (p.point) {
        const c = new THREE.Vector3(p.point[0], y, p.point[1]);
        if (this.types.has("center") || this.types.has("endpoint")) add(c, "center");
        if (this.types.has("quadrant") && (p.width || p.depth)) {
          const hw = (p.width ?? p.depth ?? 0.3) / 2;
          const hd = (p.depth ?? p.width ?? 0.3) / 2;
          add(new THREE.Vector3(c.x + hw, y, c.z), "quadrant");
          add(new THREE.Vector3(c.x - hw, y, c.z), "quadrant");
          add(new THREE.Vector3(c.x, y, c.z + hd), "quadrant");
          add(new THREE.Vector3(c.x, y, c.z - hd), "quadrant");
        }
      }

      if (p.polygon && p.polygon.length >= 2) {
        for (let i = 0; i < p.polygon.length; i++) {
          const pt = p.polygon[i];
          const v = new THREE.Vector3(pt[0], y, pt[1]);
          if (this.types.has("vertex") || this.types.has("endpoint")) add(v, "vertex");
          if (this.types.has("midpoint")) {
            const n = p.polygon[(i + 1) % p.polygon.length];
            add(new THREE.Vector3((pt[0] + n[0]) / 2, y, (pt[1] + n[1]) / 2), "midpoint");
          }
        }
      }
    } catch { /* skip broken element */ }
  }

  private screenDistToPointer(
    p: THREE.Vector3,
    rect: DOMRect,
    clientX: number,
    clientY: number,
  ): number {
    try {
      const v = p.clone().project(ctx.world.camera.three);
      const sx = (v.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
      return Math.hypot(sx - clientX, sy - clientY);
    } catch { return 9999; }
  }
}

export const snapping = new SnapManager();

/* -- Snap settings panel (unchanged API) ------------------------------ */

let snapPanel: HTMLElement | null = null;
let snapPanelVisible = false;

export function toggleSnapSettings() {
  setSnapSettingsVisible(!snapPanelVisible);
}

export function isSnapSettingsVisible() { return snapPanelVisible; }

export function setSnapSettingsVisible(on: boolean) {
  snapPanelVisible = on;
  if (!snapPanel) buildSnapPanel();
  if (snapPanel) snapPanel.style.display = on ? "block" : "none";
  if (on) renderSnapPanel();
}

function buildSnapPanel() {
  snapPanel = document.createElement("div");
  snapPanel.style.cssText =
    "position:fixed;bottom:48px;left:12px;width:300px;z-index:8500;" +
    "background:#1e2430;color:#e2e8f0;border:1px solid #334155;border-radius:10px;" +
    "box-shadow:0 8px 32px rgba(0,0,0,.4);font:12px/1.4 system-ui,sans-serif;display:none";
  document.body.appendChild(snapPanel);
}

function renderSnapPanel() {
  if (!snapPanel) return;
  const types = snapping.getAllTypes();
  const active = new Set(snapping.getTypes());

  // Color chips matching the marker colors
  const colorByType: Record<string, string> = {
    endpoint: "#F59E0B", intersection: "#EF4444", corner: "#FBBF24",
    midpoint: "#22C55E", center: "#38BDF8", perpendicular: "#C084FC",
    tangent: "#F472B6", quadrant: "#34D399", vertex: "#38BDF8",
    face: "#38BDF8", nearest: "#F59E0B", parallel: "#A78BFA",
    extension: "#F472B6", grid: "#38BDF8",
  };

  const checkboxes = types.map((t) => {
    const on = active.has(t);
    const color = colorByType[t] ?? "#94a3b8";
    return (
      '<label style="display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;cursor:pointer;' +
      (on ? "background:#0f172a;" : "background:transparent;") + '">' +
      '<input type="checkbox" data-snap="' + t + '" ' + (on ? "checked" : "") +
      ' style="accent-color:' + color + '"/>' +
      '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + color + ';flex:none"></span>' +
      '<span style="flex:1">' + SVG_LABEL_FOR_PANEL(t) + '</span>' +
      '</label>'
    );
  }).join("");

  snapPanel.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #334155;font-weight:600">' +
      '<span>Object Snaps</span>' +
      '<button type="button" id="obs-snap-close" style="background:none;border:none;color:#94a3b8;font-size:16px;cursor:pointer">×</button>' +
    '</div>' +
    '<div style="padding:10px 12px">' +
      '<div style="display:flex;gap:6px;margin-bottom:8px">' +
        '<button type="button" id="obs-snap-all" style="flex:1;background:#334155;border:1px solid #475569;color:#e2e8f0;border-radius:6px;padding:4px;cursor:pointer">All</button>' +
        '<button type="button" id="obs-snap-none" style="flex:1;background:#334155;border:1px solid #475569;color:#e2e8f0;border-radius:6px;padding:4px;cursor:pointer">None</button>' +
        '<button type="button" id="obs-snap-toggle" style="flex:1;background:' + (snapping.isEnabled() ? "#1d4ed8" : "#334155") + ';border:1px solid #475569;color:#e2e8f0;border-radius:6px;padding:4px;cursor:pointer">' +
          (snapping.isEnabled() ? "ON" : "OFF") +
        '</button>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;margin-bottom:10px">' + checkboxes + '</div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:11px;color:#94a3b8">' +
        'Grid size (m)' +
        '<input type="number" id="obs-snap-grid" value="' + snapping.getGridSize() + '" step="0.05" min="0.001" ' +
          'style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:4px 6px"/>' +
      '</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:11px;color:#94a3b8;margin-top:6px">' +
        'Tolerance (px)' +
        '<input type="number" id="obs-snap-tol" value="' + snapping.getPixelTolerance() + '" step="1" min="4" ' +
          'style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:4px 6px"/>' +
      '</label>' +
      '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #334155;font-size:10px;color:#64748b;line-height:1.4">' +
        'Higher priority wins over closer snaps. Endpoint / Intersection / Corner beat Nearest and Grid.' +
      '</div>' +
    '</div>';

  snapPanel.querySelector("#obs-snap-close")?.addEventListener("click", () => setSnapSettingsVisible(false));
  snapPanel.querySelector("#obs-snap-all")?.addEventListener("click", () => { snapping.enableAllTypes(); renderSnapPanel(); });
  snapPanel.querySelector("#obs-snap-none")?.addEventListener("click", () => { snapping.disableAllTypes(); renderSnapPanel(); });
  snapPanel.querySelector("#obs-snap-toggle")?.addEventListener("click", () => {
    snapping.setEnabled(!snapping.isEnabled());
    renderSnapPanel();
  });
  snapPanel.querySelectorAll("[data-snap]").forEach((el) => {
    el.addEventListener("change", () => {
      const t = (el as HTMLInputElement).dataset.snap as SnapType;
      snapping.toggleType(t, (el as HTMLInputElement).checked);
    });
  });
  snapPanel.querySelector("#obs-snap-grid")?.addEventListener("change", (e) => {
    snapping.setGridSize(Number((e.target as HTMLInputElement).value) || 0.1);
  });
  snapPanel.querySelector("#obs-snap-tol")?.addEventListener("change", (e) => {
    snapping.setPixelTolerance(Number((e.target as HTMLInputElement).value) || 16);
  });
}

function SVG_LABEL_FOR_PANEL(t: string): string {
  const map: Record<string, string> = {
    endpoint: "Endpoint", intersection: "Intersection", corner: "Corner",
    midpoint: "Midpoint", center: "Center", perpendicular: "Perpendicular",
    tangent: "Tangent", quadrant: "Quadrant", vertex: "Vertex",
    face: "Face", nearest: "Nearest", parallel: "Parallel",
    extension: "Extension", grid: "Grid",
  };
  return map[t] ?? t;
}