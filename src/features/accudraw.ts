/**
 * AccuDraw v2 — Bentley-style axis guidance with shift-ortho, angle snaps,
 * and typed distance entry.
 *
 * Keyboard (active only while a base point is placed):
 *   X / Z / Y     toggle axis lock
 *   Tab           cycle Free → X → Z → Y
 *   Shift (hold)  Ortho — force-project onto the nearest axis
 *   A             cycle angle-increment lock: Off → 15° → 30° → 45° → 90°
 *   0-9 .         typed distance; Enter commits the point at that distance
 *   Backspace     erase last digit
 *   Esc           clear lock (chain survives); press again to end
 *
 * Auto-lock: within 12° of an axis → snap to that axis automatically.
 *
 * Angles: when an angle-lock is active, the candidate point is rotated to
 * the nearest multiple of the increment from the base point.
 */
import * as THREE from "three";
import { ctx } from "../core/context";

export type AccuAxis = "free" | "x" | "y" | "z";
export type AngleLock = 0 | 15 | 30 | 45 | 90;

const AUTO_ANGLE_DEG = 12;
const AUTO_MIN_DISTANCE = 0.15;
const COMPASS_SIZE = 132;

const ANGLE_CYCLE: AngleLock[] = [0, 15, 30, 45, 90];

class AccuDrawManager {
  private enabled = false;
  private lock: AccuAxis = "free";
  private autoLock = true;
  private angleLock: AngleLock = 0;
  private basePoint: THREE.Vector3 | null = null;

  // Shift-ortho (transient, only while Shift held)
  private shiftOrtho = false;

  // Typed distance buffer
  private typedBuffer = "";

  // Screen tracking for Y-lock math
  private lastScreenX = 0;
  private lastScreenY = 0;

  // DOM
  private host: HTMLDivElement | null = null;
  private svg: SVGSVGElement | null = null;
  private armX: SVGLineElement | null = null;
  private armY: SVGLineElement | null = null;
  private armZ: SVGLineElement | null = null;
  private armXHead: SVGPolygonElement | null = null;
  private armYHead: SVGPolygonElement | null = null;
  private armZHead: SVGPolygonElement | null = null;
  private statusText: SVGTextElement | null = null;
  private deltaX: SVGTextElement | null = null;
  private deltaY: SVGTextElement | null = null;
  private deltaZ: SVGTextElement | null = null;
  private angleText: SVGTextElement | null = null;
  private typedText: SVGTextElement | null = null;

  // Cursor tooltip (distance + angle near pointer)
  private tooltip: HTMLDivElement | null = null;

  private listeners = new Set<() => void>();

  /* ── Setup ───────────────────────────────────────────────────────── */
  init(): void {
    if (this.enabled) return;
    this.enabled = true;

    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    ctx.rightHost.addEventListener("mousemove", this.onMouseMove);

    console.log("[accudraw] enabled");
  }

  destroy(): void {
    this.enabled = false;
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    ctx.rightHost.removeEventListener("mousemove", this.onMouseMove);
    this.hideCompass();
    this.hideTooltip();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit() {
    for (const cb of this.listeners) {
      try { cb(); } catch { /* */ }
    }
  }

  /* ── Public state ────────────────────────────────────────────────── */
  getLock(): AccuAxis { return this.lock; }
  getAngleLock(): AngleLock { return this.angleLock; }
  getBasePoint(): THREE.Vector3 | null { return this.basePoint ? this.basePoint.clone() : null; }
  isActive(): boolean { return this.basePoint !== null; }
  isOrtho(): boolean { return this.shiftOrtho; }

  setLock(axis: AccuAxis): void {
    this.lock = axis;
    this.refreshCompass();
    this.emit();
  }

  cycleLock(): void {
    const order: AccuAxis[] = ["free", "x", "z", "y"];
    const i = order.indexOf(this.lock);
    this.lock = order[(i + 1) % order.length];
    this.refreshCompass();
    this.emit();
  }

  clearLock(): void {
    this.lock = "free";
    this.typedBuffer = "";
    this.refreshCompass();
    this.emit();
  }

  cycleAngleLock(): void {
    const i = ANGLE_CYCLE.indexOf(this.angleLock);
    this.angleLock = ANGLE_CYCLE[(i + 1) % ANGLE_CYCLE.length];
    this.refreshCompass();
    this.emit();
  }

  setAutoLock(on: boolean): void { this.autoLock = on; this.emit(); }
  isAutoLock(): boolean { return this.autoLock; }

  begin(base: THREE.Vector3): void {
    this.basePoint = base.clone();
    this.lock = "free";
    this.typedBuffer = "";
    this.ensureCompass();
    this.ensureTooltip();
    this.showCompass();
    this.emit();
  }

  end(): void {
    this.basePoint = null;
    this.typedBuffer = "";
    this.hideCompass();
    this.hideTooltip();
    this.emit();
  }

  /* ── Constrain ───────────────────────────────────────────────────── */
  constrain(candidate: THREE.Vector3): THREE.Vector3 {
    if (!this.enabled || !this.basePoint) return candidate;

    const base = this.basePoint;
    const dxWorld = candidate.x - base.x;
    const dzWorld = candidate.z - base.z;

    // ── Typed distance takes precedence ──
    if (this.typedBuffer.length > 0) {
      const dist = parseFloat(this.typedBuffer);
      if (Number.isFinite(dist) && dist > 0) {
        const dir = this.currentDirection(candidate, base);
        const out = base.clone().add(dir.multiplyScalar(dist));
        this.updateDeltas(base, out);
        this.updateTooltip(base, out, candidate);
        return out;
      }
    }

    // ── Determine effective axis ──
    let axis: AccuAxis = this.lock;

    // Shift-ortho overrides auto-lock and forces the nearest axis.
    if (this.shiftOrtho && axis === "free") {
      const horiz = Math.hypot(dxWorld, dzWorld);
      if (horiz >= AUTO_MIN_DISTANCE) {
        const nx = Math.abs(dxWorld) / horiz;
        const nz = Math.abs(dzWorld) / horiz;
        axis = nx >= nz ? "x" : "z";
      }
    }

    // Auto-lock (skipped when Shift-ortho already resolved the axis)
    if (axis === "free" && this.autoLock && !this.shiftOrtho) {
      const horiz = Math.hypot(dxWorld, dzWorld);
      if (horiz >= AUTO_MIN_DISTANCE) {
        const nx = Math.abs(dxWorld) / horiz;
        const nz = Math.abs(dzWorld) / horiz;
        const threshold = Math.cos(THREE.MathUtils.degToRad(AUTO_ANGLE_DEG));
        if (nx >= threshold) axis = "x";
        else if (nz >= threshold) axis = "z";
      }
    }

    const out = candidate.clone();

    // ── Project onto axis ──
    if (axis === "x") {
      out.x = base.x + dxWorld;
      out.z = base.z;
      out.y = base.y;
    } else if (axis === "z") {
      out.z = base.z + dzWorld;
      out.x = base.x;
      out.y = base.y;
    } else if (axis === "y") {
      const dy = this.computeVerticalDelta();
      out.x = base.x;
      out.z = base.z;
      out.y = base.y + dy;
    }

    // ── Angle lock ──
    if (this.angleLock > 0 && axis !== "y") {
      const horiz = new THREE.Vector2(out.x - base.x, out.z - base.z);
      const len = horiz.length();
      if (len > 0.001) {
        const step = THREE.MathUtils.degToRad(this.angleLock);
        const ang = Math.atan2(horiz.y, horiz.x);
        const snapped = Math.round(ang / step) * step;
        out.x = base.x + Math.cos(snapped) * len;
        out.z = base.z + Math.sin(snapped) * len;
        out.y = base.y;
      }
    }

    this.updateDeltas(base, out);
    this.updateTooltip(base, out, candidate);
    return out;
  }

  /** Direction from base to candidate, respecting the active axis lock. */
  private currentDirection(candidate: THREE.Vector3, base: THREE.Vector3): THREE.Vector3 {
    if (this.lock === "x") return new THREE.Vector3(1, 0, 0);
    if (this.lock === "z") return new THREE.Vector3(0, 0, 1);
    if (this.lock === "y") return new THREE.Vector3(0, 1, 0);

    // Otherwise: the direction from base to the candidate, normalised.
    const d = candidate.clone().sub(base);
    if (d.lengthSq() < 1e-9) return new THREE.Vector3(1, 0, 0);
    return d.normalize();
  }

  isReadyForConstraint(): boolean {
    return this.enabled && this.basePoint !== null;
  }

  /** Consume the typed distance (called by authoring on Enter). */
  consumeTypedDistance(): number | null {
    if (!this.typedBuffer) return null;
    const n = parseFloat(this.typedBuffer);
    this.typedBuffer = "";
    this.refreshCompass();
    return Number.isFinite(n) ? n : null;
  }

  /* ── Vertical (screen-driven) ────────────────────────────────────── */
  private computeVerticalDelta(): number {
    if (!this.basePoint) return 0;
    const cam = ctx.world.camera.three as THREE.PerspectiveCamera;
    const dist = cam.position.distanceTo(this.basePoint);
    let worldPerPixel: number;
    if ((cam as any).isPerspectiveCamera) {
      const vFov = THREE.MathUtils.degToRad(cam.fov ?? 60);
      const viewportH = ctx.rightHost.clientHeight || 800;
      worldPerPixel = (2 * Math.tan(vFov / 2) * dist) / viewportH;
    } else {
      const ortho = cam as unknown as THREE.OrthographicCamera;
      const viewportH = ctx.rightHost.clientHeight || 800;
      worldPerPixel = (ortho.top - ortho.bottom) / viewportH;
    }
    const baseScreen = this.projectToScreen(this.basePoint);
    if (!baseScreen) return 0;
    const dyScreen = baseScreen.y - this.lastScreenY;
    return dyScreen * worldPerPixel;
  }

  private projectToScreen(p: THREE.Vector3): THREE.Vector2 | null {
    try {
      const v = p.clone().project(ctx.world.camera.three);
      const rect = ctx.rightHost.getBoundingClientRect();
      return new THREE.Vector2(
        (v.x * 0.5 + 0.5) * rect.width,
        (-v.y * 0.5 + 0.5) * rect.height,
      );
    } catch { return null; }
  }

  /* ── Keyboard ────────────────────────────────────────────────────── */
  private onKeyDown = (e: KeyboardEvent): void => {
    // Shift-ortho engages even before a base point (we set the flag and wait).
    if (e.key === "Shift" && !e.repeat) {
      this.shiftOrtho = true;
      if (this.basePoint) this.refreshCompass();
      return;
    }
    if (!this.enabled || !this.basePoint) return;

    const t = e.target as HTMLElement | null;
    if (t) {
      const tag = t.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || t.isContentEditable) return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const k = e.key.toLowerCase();

    if (k === "x") {
      e.preventDefault(); e.stopImmediatePropagation();
      this.setLock(this.lock === "x" ? "free" : "x");
      return;
    }
    if (k === "z") {
      e.preventDefault(); e.stopImmediatePropagation();
      this.setLock(this.lock === "z" ? "free" : "z");
      return;
    }
    if (k === "y") {
      e.preventDefault(); e.stopImmediatePropagation();
      this.setLock(this.lock === "y" ? "free" : "y");
      return;
    }
    if (k === "a") {
      e.preventDefault(); e.stopImmediatePropagation();
      this.cycleAngleLock();
      return;
    }
    if (k === "tab") {
      e.preventDefault(); e.stopImmediatePropagation();
      this.cycleLock();
      return;
    }
    if (k === "escape") {
      // Clear AccuDraw state but do NOT stop propagation —
      // global Esc handler must still cancel the active tool (Revit-style).
      if (this.lock !== "free" || this.typedBuffer || this.basePoint !== null) {
        this.clearLock();
        this.typedBuffer = "";
        try { this.end(); } catch { /* */ }
      }
      return;
    }

    // Typed distance: digits, dot, backspace
    if (/^[0-9.]$/.test(k)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (k === "." && this.typedBuffer.includes(".")) return;
      this.typedBuffer += k;
      this.refreshCompass();
      return;
    }
    if (k === "backspace") {
      e.preventDefault(); e.stopImmediatePropagation();
      this.typedBuffer = this.typedBuffer.slice(0, -1);
      this.refreshCompass();
      return;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Shift") {
      this.shiftOrtho = false;
      if (this.basePoint) this.refreshCompass();
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    const rect = ctx.rightHost.getBoundingClientRect();
    this.lastScreenX = e.clientX - rect.left;
    this.lastScreenY = e.clientY - rect.top;
    if (this.basePoint && (this.lock !== "free" || this.shiftOrtho || this.angleLock > 0)) {
      const live = this.constrain(this.basePoint.clone());
      this.updateDeltas(this.basePoint, live);
    }
  };

  /* ── Compass DOM ─────────────────────────────────────────────────── */
  private ensureCompass(): void {
    if (this.host) return;

    const host = document.createElement("div");
    host.style.cssText =
      "position:absolute;left:44px;bottom:44px;z-index:56;width:" + COMPASS_SIZE + "px;" +
      "height:" + (COMPASS_SIZE + 32) + "px;pointer-events:auto;user-select:none;" +
      "display:none;font:11px system-ui,sans-serif;color:#e8eaf0";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(COMPASS_SIZE));
    svg.setAttribute("height", String(COMPASS_SIZE));
    svg.setAttribute("viewBox", "0 0 132 132");
    svg.style.cssText = "display:block;overflow:visible";

    const cx = 66;
    const cy = 72;
    const R = 44;

    // Backdrop
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    bg.setAttribute("cx", String(cx));
    bg.setAttribute("cy", String(cy));
    bg.setAttribute("r", String(R + 14));
    bg.setAttribute("fill", "rgba(20,22,30,0.9)");
    bg.setAttribute("stroke", "rgba(56,189,248,0.28)");
    bg.setAttribute("stroke-width", "1");
    svg.appendChild(bg);

    // Ring
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("cx", String(cx));
    ring.setAttribute("cy", String(cy));
    ring.setAttribute("r", "5");
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", "rgba(255,255,255,0.55)");
    ring.setAttribute("stroke-width", "1");
    svg.appendChild(ring);

    const buildArm = (dir: THREE.Vector2, color: string, label: string) => {
      const x2 = cx + dir.x * R;
      const y2 = cy + dir.y * R;

      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(cx));
      line.setAttribute("y1", String(cy));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", "1.6");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("opacity", "0.45");
      line.dataset.axis = label;

      const head = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      const ux = dir.x, uy = dir.y;
      const px = -uy, py = ux;
      const HL = 8, HW = 4;
      head.setAttribute(
        "points",
        `${x2},${y2} ${x2 - ux * HL + px * HW},${y2 - uy * HL + py * HW} ${x2 - ux * HL - px * HW},${y2 - uy * HL - py * HW}`,
      );
      head.setAttribute("fill", color);
      head.setAttribute("opacity", "0.45");
      head.dataset.axis = label;

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(cx + dir.x * (R + 11)));
      text.setAttribute("y", String(cy + dir.y * (R + 11) + 3));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("font-size", "11");
      text.setAttribute("font-weight", "700");
      text.setAttribute("font-family", "system-ui, sans-serif");
      text.setAttribute("fill", color);
      text.setAttribute("opacity", "0.6");
      text.textContent = label.toUpperCase();
      text.dataset.axis = label;

      return { line, head, text };
    };

    const armX = buildArm(new THREE.Vector2(1, 0), "#ef4444", "x");
    const armZ = buildArm(new THREE.Vector2(0.75, 0.66), "#3b82f6", "z");
    const armY = buildArm(new THREE.Vector2(0, -1), "#22c55e", "y");

    svg.append(
      armX.line, armX.head, armX.text,
      armY.line, armY.head, armY.text,
      armZ.line, armZ.head, armZ.text,
    );

    this.armX = armX.line; this.armXHead = armX.head;
    this.armY = armY.line; this.armYHead = armY.head;
    this.armZ = armZ.line; this.armZHead = armZ.head;

    // Status (bottom)
    const statusText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    statusText.setAttribute("x", String(cx));
    statusText.setAttribute("y", String(COMPASS_SIZE - 4));
    statusText.setAttribute("text-anchor", "middle");
    statusText.setAttribute("font-size", "10.5");
    statusText.setAttribute("font-weight", "700");
    statusText.setAttribute("font-family", "system-ui, sans-serif");
    statusText.setAttribute("fill", "#38bdf8");
    statusText.setAttribute("letter-spacing", "0.5");
    statusText.textContent = "FREE";
    svg.appendChild(statusText);
    this.statusText = statusText;

    // Angle lock (top-right)
    const angleText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    angleText.setAttribute("x", String(COMPASS_SIZE - 2));
    angleText.setAttribute("y", "12");
    angleText.setAttribute("text-anchor", "end");
    angleText.setAttribute("font-size", "9.5");
    angleText.setAttribute("font-family", "ui-monospace, monospace");
    angleText.setAttribute("fill", "#c084fc");
    angleText.setAttribute("letter-spacing", "0.3");
    angleText.textContent = "A: OFF";
    svg.appendChild(angleText);
    this.angleText = angleText;

    // Deltas (top-left)
    const dX = document.createElementNS("http://www.w3.org/2000/svg", "text");
    dX.setAttribute("x", "4"); dX.setAttribute("y", "12");
    dX.setAttribute("font-size", "10"); dX.setAttribute("font-family", "ui-monospace, monospace");
    dX.setAttribute("fill", "#ef4444"); dX.setAttribute("opacity", "0.9");
    dX.textContent = "x 0.00";

    const dZ = document.createElementNS("http://www.w3.org/2000/svg", "text");
    dZ.setAttribute("x", "4"); dZ.setAttribute("y", "24");
    dZ.setAttribute("font-size", "10"); dZ.setAttribute("font-family", "ui-monospace, monospace");
    dZ.setAttribute("fill", "#3b82f6"); dZ.setAttribute("opacity", "0.9");
    dZ.textContent = "z 0.00";

    const dY = document.createElementNS("http://www.w3.org/2000/svg", "text");
    dY.setAttribute("x", "4"); dY.setAttribute("y", "36");
    dY.setAttribute("font-size", "10"); dY.setAttribute("font-family", "ui-monospace, monospace");
    dY.setAttribute("fill", "#22c55e"); dY.setAttribute("opacity", "0.9");
    dY.textContent = "y 0.00";

    svg.append(dX, dZ, dY);
    this.deltaX = dX; this.deltaZ = dZ; this.deltaY = dY;

    // Typed buffer (center-top)
    const typedText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    typedText.setAttribute("x", String(cx));
    typedText.setAttribute("y", "16");
    typedText.setAttribute("text-anchor", "middle");
    typedText.setAttribute("font-size", "12");
    typedText.setAttribute("font-weight", "700");
    typedText.setAttribute("font-family", "ui-monospace, monospace");
    typedText.setAttribute("fill", "#fbbf24");
    typedText.textContent = "";
    svg.appendChild(typedText);
    this.typedText = typedText;

    host.appendChild(svg);

    // Clickable axes
    const axes: { el: Element | null; axis: AccuAxis }[] = [
      { el: armX.line, axis: "x" }, { el: armX.head, axis: "x" }, { el: armX.text, axis: "x" },
      { el: armY.line, axis: "y" }, { el: armY.head, axis: "y" }, { el: armY.text, axis: "y" },
      { el: armZ.line, axis: "z" }, { el: armZ.head, axis: "z" }, { el: armZ.text, axis: "z" },
    ];
    for (const a of axes) {
      if (!a.el) continue;
      (a.el as any).style.cursor = "pointer";
      (a.el as any).addEventListener("pointerdown", (e: PointerEvent) => {
        e.stopPropagation();
        this.setLock(this.lock === a.axis ? "free" : a.axis);
      });
    }
    (ring as any).style.cursor = "pointer";
    (ring as any).addEventListener("pointerdown", (e: PointerEvent) => {
      e.stopPropagation();
      this.clearLock();
    });

    // Bottom hint strip
    const hints = document.createElement("div");
    hints.style.cssText =
      "position:absolute;left:0;right:0;bottom:-24px;text-align:center;" +
      "font:9.5px ui-monospace, monospace;color:#94a3b8;letter-spacing:.3px;white-space:nowrap";
    hints.textContent = "X Z Y · Shift ortho · A angle · type distance · Tab";
    host.appendChild(hints);

    ctx.rightHost.appendChild(host);
    this.host = host;
    this.svg = svg;
  }

  private ensureTooltip(): void {
    if (this.tooltip) return;
    const t = document.createElement("div");
    t.style.cssText =
      "position:absolute;z-index:57;pointer-events:none;display:none;" +
      "background:rgba(20,22,30,0.92);border:1px solid rgba(56,189,248,0.45);" +
      "border-radius:5px;padding:3px 8px;font:11px ui-monospace, monospace;" +
      "color:#e8eaf0;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.45)";
    ctx.rightHost.appendChild(t);
    this.tooltip = t;
  }

  private showCompass(): void {
    if (this.host) this.host.style.display = "block";
    this.refreshCompass();
  }
  private hideCompass(): void {
    if (this.host) this.host.style.display = "none";
  }
  private hideTooltip(): void {
    if (this.tooltip) this.tooltip.style.display = "none";
  }

  private refreshCompass(): void {
    const isActive = (axis: AccuAxis) => this.lock === axis || (this.shiftOrtho && this.autoLock && this.lock === "free" && this.autoAxisCandidate === axis);

    const apply = (line: SVGLineElement | null, head: SVGPolygonElement | null, on: boolean) => {
      if (!line || !head) return;
      line.setAttribute("stroke-width", on ? "3" : "1.6");
      line.setAttribute("opacity", on ? "1" : "0.45");
      head.setAttribute("opacity", on ? "1" : "0.45");
    };

    apply(this.armX, this.armXHead, isActive("x"));
    apply(this.armY, this.armYHead, isActive("y"));
    apply(this.armZ, this.armZHead, isActive("z"));

    if (this.statusText) {
      const label =
        this.typedBuffer ? `DIST ${this.typedBuffer}` :
        this.shiftOrtho ? "ORTHO" :
        this.lock === "free" ? "FREE" :
        this.lock === "x" ? "X-LOCK" :
        this.lock === "y" ? "Y-LOCK" :
        "Z-LOCK";
      this.statusText.textContent = label;
      this.statusText.setAttribute(
        "fill",
        this.typedBuffer ? "#fbbf24" :
        this.shiftOrtho ? "#f59e0b" :
        this.lock === "free" ? "#38bdf8" :
        this.lock === "x" ? "#ef4444" :
        this.lock === "y" ? "#22c55e" :
        "#3b82f6",
      );
    }

    if (this.angleText) {
      this.angleText.textContent = this.angleLock > 0 ? `A: ${this.angleLock}°` : "A: OFF";
      this.angleText.setAttribute("fill", this.angleLock > 0 ? "#c084fc" : "#6b7280");
    }

    if (this.typedText) {
      this.typedText.textContent = this.typedBuffer ? `→ ${this.typedBuffer} m` : "";
    }
  }

  // Cache of the last auto-resolved axis, for visual feedback while free.
  private autoAxisCandidate: AccuAxis = "free";

  private updateDeltas(base: THREE.Vector3, candidate: THREE.Vector3): void {
    if (this.deltaX) this.deltaX.textContent = `x ${(candidate.x - base.x).toFixed(2)}`;
    if (this.deltaZ) this.deltaZ.textContent = `z ${(candidate.z - base.z).toFixed(2)}`;
    if (this.deltaY) this.deltaY.textContent = `y ${(candidate.y - base.y).toFixed(2)}`;
  }

  private updateTooltip(base: THREE.Vector3, snapped: THREE.Vector3, raw: THREE.Vector3): void {
    if (!this.tooltip) return;
    const dx = snapped.x - base.x;
    const dz = snapped.z - base.z;
    const dy = snapped.y - base.y;
    const dist = Math.hypot(dx, dy, dz);
    const angDeg = (Math.atan2(dz, dx) * 180) / Math.PI;
    const angleStr = `${angDeg.toFixed(0)}°`;

    // Position the tooltip near the cursor.
    this.tooltip.style.left = `${this.lastScreenX + 18}px`;
    this.tooltip.style.top = `${this.lastScreenY - 34}px`;
    this.tooltip.textContent = `${dist.toFixed(2)} m · ${angleStr}`;
    this.tooltip.style.display = "block";
  }
}

export const accuDraw = new AccuDrawManager();

export function setupAccuDraw(): void {
  accuDraw.init();
  (window as any).__obs_accuDraw = accuDraw;
  console.log("[accudraw] setup complete");
}