/**
 * Measure tool — distance, XYZ components, angle, chain.
 *
 * Controls (while enabled):
 *   Click          — pick next point (snaps to model when available)
 *   Double-click   — same as click (legacy)
 *   Enter          — finish current creation (OBC length measurer)
 *   U              — cycle units (mm → cm → m)
 *   1 / 2 / 3 / 4  — mode: Distance / XYZ / Angle / Chain
 *   Esc            — cancel pending points; escape-all also exits the tool
 */
import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import { ctx } from "../core/context";
import { isDrawingActive } from "./drawing";
import { setSectionOn } from "./section";

export type MeasureMode = "distance" | "xyz" | "angle" | "chain";
export type MeasureUnit = "mm" | "cm" | "m";

let measureCheckboxEl: any = null;
export function setMeasureCheckboxRef(el: any) {
  measureCheckboxEl = el;
}
export function isMeasureEnabled() {
  return !!ctx.lengthMeasurer?.enabled;
}

const measureLabelLayer = document.createElement("div");
measureLabelLayer.style.cssText =
  "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:20";

type MLabel = { el: HTMLDivElement; pos: THREE.Vector3 };
const measureLabels: MLabel[] = [];
const xyzGroup = new THREE.Group();
xyzGroup.name = "obs-measure-xyz";

let pendingPts: THREE.Vector3[] = [];
let mode: MeasureMode = "xyz";
let units: MeasureUnit = "mm";
let chainTotal = 0;
let hud: HTMLDivElement | null = null;
let pickArmed = false; // ignore the click that enabled the tool

function clearMeasureLabels() {
  for (const l of measureLabels) l.el.remove();
  measureLabels.length = 0;
}

function addMeasureLabel(text: string, pos: THREE.Vector3, color = "#0284c7") {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText =
    `position:absolute;transform:translate(-50%,-50%);background:${color};color:#fff;` +
    "padding:4px 10px;border-radius:6px;font:600 12px system-ui,sans-serif;white-space:nowrap;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.25)";
  measureLabelLayer.appendChild(el);
  measureLabels.push({ el, pos: pos.clone() });
  updateMeasureLabels();
}

function updateMeasureLabels() {
  try {
    const cam = ctx.world.camera.three;
    const w = ctx.rightHost.clientWidth;
    const h = ctx.rightHost.clientHeight;
    for (const { el, pos } of measureLabels) {
      const v = pos.clone().project(cam);
      if (v.z > 1 || v.z < -1) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "block";
      el.style.left = `${(v.x * 0.5 + 0.5) * w}px`;
      el.style.top = `${(-v.y * 0.5 + 0.5) * h}px`;
    }
  } catch {
    /* */
  }
}

function formatLength(metres: number): string {
  const v = Math.abs(metres);
  if (units === "mm") return `${(v * 1000).toFixed(1)} mm`;
  if (units === "cm") return `${(v * 100).toFixed(2)} cm`;
  return `${v.toFixed(3)} m`;
}

function formatAngle(deg: number): string {
  return `${deg.toFixed(2)}°`;
}

export function setMeasureMode(m: MeasureMode) {
  mode = m;
  cancelPending(false);
  updateHud();
}

export function getMeasureMode(): MeasureMode {
  return mode;
}

export function setMeasureUnits(u: MeasureUnit) {
  units = u;
  try {
    (ctx.lengthMeasurer as any).units = u === "mm" ? "mm" : "m";
  } catch {
    /* */
  }
  updateHud();
}

export function cycleMeasureUnits() {
  setMeasureUnits(units === "mm" ? "cm" : units === "cm" ? "m" : "mm");
}

export function setMeasureEnabled(on: boolean) {
  const lm = ctx.lengthMeasurer;
  if (!lm) return;
  lm.enabled = on;
  lm.visible = true;
  try {
    ctx.highlighter.enabled = !on;
  } catch {
    /* */
  }
  if (on) {
    try {
      setSectionOn(false);
    } catch {
      /* */
    }
    pickArmed = false;
    window.setTimeout(() => {
      pickArmed = true;
    }, 120);
  } else {
    cancelPending(false);
  }
  try {
    measureLabelLayer.style.display = on ? "block" : "none";
  } catch {
    /* */
  }
  const el = measureCheckboxEl ?? document.querySelector("bim-checkbox[data-measure]");
  if (el) (el as any).checked = on;
  ensureHud();
  updateHud();
  try {
    window.dispatchEvent(new CustomEvent("obs:measure-changed", { detail: { enabled: on, mode, units } }));
  } catch {
    /* */
  }
}

export function toggleMeasure() {
  setMeasureEnabled(!isMeasureEnabled());
}

export function clearMeasurements() {
  try {
    const list = (ctx.lengthMeasurer as any)?.list;
    if (list?.clear) list.clear();
    else if (typeof (ctx.lengthMeasurer as any)?.deleteAll === "function") {
      (ctx.lengthMeasurer as any).deleteAll();
    }
  } catch (e) {
    console.warn("[measure] clear failed", e);
  }
  clearXyzGraphics();
  chainTotal = 0;
  updateHud();
}

function clearXyzGraphics() {
  while (xyzGroup.children.length) {
    const ch = xyzGroup.children[0] as any;
    xyzGroup.remove(ch);
    ch.geometry?.dispose?.();
    if (Array.isArray(ch.material)) ch.material.forEach((m: any) => m.dispose?.());
    else ch.material?.dispose?.();
  }
  clearMeasureLabels();
}

/** Cancel in-progress point picking. Returns true if something was canceled. */
export function cancelPending(update = true): boolean {
  let any = false;
  if (pendingPts.length) {
    pendingPts = [];
    any = true;
  }
  try {
    (ctx.lengthMeasurer as any)?.cancelCreation?.();
  } catch {
    /* */
  }
  // Remove temporary endpoint balls only when canceling mid-pick — keep finished dims
  if (any) {
    // strip only cyan pending balls by clearing graphics that belong to pending
    // Keep last completed labels unless full clear requested
  }
  if (update) updateHud();
  return any;
}

/** Full measure cancel for escape-all: pending first, then exit tool. */
export function cancelMeasure(): boolean {
  const pending = cancelPending(false);
  const wasOn = isMeasureEnabled();
  if (wasOn) setMeasureEnabled(false);
  updateHud();
  return pending || wasOn;
}

function line3(a: THREE.Vector3, b: THREE.Vector3, color: number) {
  const g = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
  const l = new THREE.Line(
    g,
    new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  l.renderOrder = 1000;
  return l;
}

function ball(p: THREE.Vector3, color: number, r = 0.045) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(r, 12, 12),
    new THREE.MeshBasicMaterial({ color, depthTest: false }),
  );
  m.position.copy(p);
  m.renderOrder = 1001;
  return m;
}

function drawXyzDimension(a: THREE.Vector3, b: THREE.Vector3) {
  clearXyzGraphics();
  const dx = b.x - a.x,
    dy = b.y - a.y,
    dz = b.z - a.z;
  const pX = new THREE.Vector3(b.x, a.y, a.z);
  const pXY = new THREE.Vector3(b.x, b.y, a.z);
  if (Math.abs(dx) > 1e-6) {
    xyzGroup.add(line3(a, pX, 0xef4444));
    addMeasureLabel(`X ${formatLength(dx)}`, a.clone().lerp(pX, 0.5), "#b91c1c");
  }
  if (Math.abs(dy) > 1e-6) {
    xyzGroup.add(line3(pX, pXY, 0x22c55e));
    addMeasureLabel(`Y ${formatLength(dy)}`, pX.clone().lerp(pXY, 0.5), "#15803d");
  }
  if (Math.abs(dz) > 1e-6) {
    xyzGroup.add(line3(pXY, b, 0x3b82f6));
    addMeasureLabel(`Z ${formatLength(dz)}`, pXY.clone().lerp(b, 0.5), "#1d4ed8");
  }
  xyzGroup.add(line3(a, b, 0x38bdf8));
  addMeasureLabel(formatLength(a.distanceTo(b)), a.clone().lerp(b, 0.5), "#0284c7");
  xyzGroup.add(ball(a, 0xffffff));
  xyzGroup.add(ball(b, 0xffffff));
}

function drawDistance(a: THREE.Vector3, b: THREE.Vector3) {
  clearXyzGraphics();
  xyzGroup.add(line3(a, b, 0x38bdf8));
  addMeasureLabel(formatLength(a.distanceTo(b)), a.clone().lerp(b, 0.5));
  xyzGroup.add(ball(a, 0xffffff));
  xyzGroup.add(ball(b, 0xffffff));
}

function drawAngle(a: THREE.Vector3, vertex: THREE.Vector3, c: THREE.Vector3) {
  clearXyzGraphics();
  xyzGroup.add(line3(vertex, a, 0xfbbf24));
  xyzGroup.add(line3(vertex, c, 0xfbbf24));
  const va = a.clone().sub(vertex).normalize();
  const vc = c.clone().sub(vertex).normalize();
  const deg = (Math.acos(THREE.MathUtils.clamp(va.dot(vc), -1, 1)) * 180) / Math.PI;
  addMeasureLabel(formatAngle(deg), vertex.clone().add(va.clone().add(vc).normalize().multiplyScalar(0.35)), "#b45309");
  xyzGroup.add(ball(a, 0xffffff));
  xyzGroup.add(ball(vertex, 0xfbbf24, 0.055));
  xyzGroup.add(ball(c, 0xffffff));
}

function drawChainSegment(a: THREE.Vector3, b: THREE.Vector3) {
  const d = a.distanceTo(b);
  chainTotal += d;
  xyzGroup.add(line3(a, b, 0xa78bfa));
  addMeasureLabel(formatLength(d), a.clone().lerp(b, 0.5), "#6d28d9");
  xyzGroup.add(ball(b, 0xffffff));
  addMeasureLabel(`Σ ${formatLength(chainTotal)}`, b.clone().add(new THREE.Vector3(0, 0.15, 0)), "#4c1d95");
}

async function pickPoint(clientX?: number, clientY?: number): Promise<THREE.Vector3 | null> {
  try {
    const caster: any = ctx.components.get(OBC.Raycasters).get(ctx.world);
    const opts: any = {
      snappingClasses: [FRAGS.SnappingClass.POINT, FRAGS.SnappingClass.LINE, FRAGS.SnappingClass.FACE],
    };
    // Some OBC versions accept mouse; others use last pointer from the world.
    if (clientX != null && clientY != null) {
      try {
        opts.mouse = { x: clientX, y: clientY };
      } catch {
        /* */
      }
    }
    const result: any = await caster.castRay(opts);
    if (result?.point) return (result.point as THREE.Vector3).clone();
  } catch (err) {
    console.warn("[measure] castRay", err);
  }
  // Fallback: ray against ground plane y=0
  try {
    const cam = ctx.world.camera.three as THREE.Camera;
    const host = ctx.rightHost;
    if (!cam || !host || clientX == null || clientY == null) return null;
    const rect = host.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, cam);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (rc.ray.intersectPlane(plane, hit)) return hit;
  } catch {
    /* */
  }
  return null;
}

function commitPoint(pt: THREE.Vector3) {
  pendingPts.push(pt.clone());
  xyzGroup.add(ball(pt, 0x22d3ee));

  if (mode === "distance" || mode === "xyz") {
    if (pendingPts.length >= 2) {
      const a = pendingPts[0],
        b = pendingPts[1];
      if (mode === "xyz") drawXyzDimension(a, b);
      else drawDistance(a, b);
      pendingPts = [];
    }
  } else if (mode === "angle") {
    if (pendingPts.length >= 3) {
      drawAngle(pendingPts[0], pendingPts[1], pendingPts[2]);
      pendingPts = [];
    }
  } else if (mode === "chain") {
    if (pendingPts.length >= 2) {
      const a = pendingPts[pendingPts.length - 2];
      const b = pendingPts[pendingPts.length - 1];
      if (pendingPts.length === 2) {
        // first segment — clear old graphics
        clearXyzGraphics();
        xyzGroup.add(ball(a, 0xffffff));
      }
      drawChainSegment(a, b);
      // keep last point as start of next segment
      pendingPts = [b.clone()];
    }
  }
  updateHud();
}

function ensureHud() {
  if (hud) return;
  hud = document.createElement("div");
  hud.id = "obs-measure-hud";
  hud.style.cssText =
    "position:absolute;left:50%;bottom:56px;transform:translateX(-50%);z-index:55;" +
    "padding:8px 14px;border-radius:8px;background:rgba(20,22,30,.92);border:1px solid #38bdf8;" +
    "color:#e2e8f0;font:12px system-ui,sans-serif;pointer-events:none;display:none;" +
    "box-shadow:0 8px 24px rgba(0,0,0,.45);white-space:nowrap";
  try {
    ctx.rightHost.appendChild(hud);
  } catch {
    document.body.appendChild(hud);
  }
}

function updateHud() {
  ensureHud();
  if (!hud) return;
  if (!isMeasureEnabled()) {
    hud.style.display = "none";
    return;
  }
  hud.style.display = "block";
  const modeLabel =
    mode === "distance" ? "Distance" : mode === "xyz" ? "XYZ" : mode === "angle" ? "Angle" : "Chain";
  const need =
    mode === "angle" ? 3 : mode === "chain" ? "2+ (click to continue)" : 2;
  const pending = pendingPts.length
    ? ` · points ${pendingPts.length}${typeof need === "number" ? `/${need}` : ""}`
    : "";
  const total = mode === "chain" && chainTotal > 0 ? ` · Σ ${formatLength(chainTotal)}` : "";
  hud.innerHTML =
    `<b style="color:#38bdf8">MEASURE</b> · ${modeLabel} · ${units}` +
    pending +
    total +
    ` · <span style="opacity:.7">click pick · 1–4 mode · U units · Esc cancel</span>`;
}

export function setupMeasure() {
  const lm = ctx.lengthMeasurer;
  lm.world = ctx.world;
  lm.color = new THREE.Color("#38bdf8");
  lm.enabled = false;
  lm.visible = true;
  try {
    lm.units = "mm";
  } catch {
    /* */
  }
  try {
    (lm as any).snappings = [FRAGS.SnappingClass.POINT, FRAGS.SnappingClass.LINE, FRAGS.SnappingClass.FACE];
  } catch {
    /* */
  }

  ctx.rightHost.appendChild(measureLabelLayer);
  ctx.world.scene.three.add(xyzGroup);
  ctx.world.camera.controls.addEventListener("update", () => updateMeasureLabels());

  try {
    (lm.list as any).onItemSet.add(async ({ value: dim }: any) => {
      try {
        let val: number | null = null;
        if (typeof dim?.getValue === "function") val = await dim.getValue();
        else if (typeof dim?.value === "number") val = dim.value;
        else if (typeof dim?.rawValue === "number") val = dim.rawValue;

        let mid = new THREE.Vector3();
        const line = dim?.line ?? dim?.three ?? dim?.mesh;
        if (dim?.start && dim?.end) mid.copy(dim.start).add(dim.end).multiplyScalar(0.5);
        else if (line?.geometry?.attributes?.position) {
          const p = line.geometry.attributes.position;
          const a = new THREE.Vector3().fromBufferAttribute(p, 0);
          const b = new THREE.Vector3().fromBufferAttribute(p, p.count - 1);
          mid.copy(a).add(b).multiplyScalar(0.5);
        }

        if (val != null && Number.isFinite(val)) {
          // OBC values are typically metres
          addMeasureLabel(formatLength(val), mid);
        }
      } catch (err) {
        console.warn("[measure] label failed", err);
      }
    });
  } catch {
    /* */
  }

  const onPick = async (clientX: number, clientY: number) => {
    if (!isMeasureEnabled() || isDrawingActive() || !pickArmed) return;
    const pt = await pickPoint(clientX, clientY);
    if (!pt) return;
    try {
      ctx.lengthMeasurer.create();
    } catch {
      /* */
    }
    commitPoint(pt);
  };

  ctx.rightHost.addEventListener("click", (e) => {
    if (e.button !== 0) return;
    void onPick(e.clientX, e.clientY);
  });

  ctx.rightHost.addEventListener("dblclick", (e) => {
    if (!isMeasureEnabled() || isDrawingActive()) return;
    void onPick(e.clientX, e.clientY);
  });

  window.addEventListener("keydown", (e) => {
    if (!isMeasureEnabled()) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

    if (e.code === "Enter" || e.code === "NumpadEnter") {
      try {
        (ctx.lengthMeasurer as any).endCreation?.();
      } catch {
        /* */
      }
    }
    // Mode shortcuts
    if (e.key === "1") {
      e.preventDefault();
      setMeasureMode("distance");
    }
    if (e.key === "2") {
      e.preventDefault();
      setMeasureMode("xyz");
    }
    if (e.key === "3") {
      e.preventDefault();
      setMeasureMode("angle");
    }
    if (e.key === "4") {
      e.preventDefault();
      setMeasureMode("chain");
      chainTotal = 0;
    }
    if (e.key === "u" || e.key === "U") {
      e.preventDefault();
      cycleMeasureUnits();
    }
    // Esc handled by escape-all; local fallback if escape-all not installed
    if (e.code === "Escape") {
      if (cancelPending()) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });

  const api = {
    isEnabled: isMeasureEnabled,
    toggle: toggleMeasure,
    enable: () => setMeasureEnabled(true),
    disable: () => setMeasureEnabled(false),
    setMeasureEnabled,
    clear: clearMeasurements,
    cancel: cancelMeasure,
    cancelPending,
    setMode: setMeasureMode,
    getMode: getMeasureMode,
    setUnits: setMeasureUnits,
    cycleUnits: cycleMeasureUnits,
  };
  ctx.features.measure = api;
  try {
    (window as any).__obsMeasure = api;
  } catch {
    /* */
  }
  console.log("[measure] enhanced — distance / XYZ / angle / chain · Esc cancels");
}
