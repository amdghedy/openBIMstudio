import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import { ctx } from "../core/context";
import { isDrawingActive } from "./drawing";
import { setSectionOn } from "./section";

let measureCheckboxEl: any = null;
export function setMeasureCheckboxRef(el: any) { measureCheckboxEl = el; }
export function isMeasureEnabled() { return ctx.lengthMeasurer.enabled; }

const measureLabelLayer = document.createElement("div");
measureLabelLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:20";

type MLabel = { el: HTMLDivElement; pos: THREE.Vector3 };
const measureLabels: MLabel[] = [];
const xyzGroup = new THREE.Group();
let pendingMeasurePts: THREE.Vector3[] = [];

function clearMeasureLabels() { for (const l of measureLabels) l.el.remove(); measureLabels.length = 0; }

function addMeasureLabel(text: string, pos: THREE.Vector3) {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = `position:absolute;transform:translate(-50%,-50%);background:#0284c7;color:#fff;padding:4px 10px;border-radius:6px;font:600 12px system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.45);border:1px solid #38bdf8;`;
  measureLabelLayer.appendChild(el);
  measureLabels.push({ el, pos: pos.clone() });
  updateMeasureLabels();
}

function updateMeasureLabels() {
  const cam = ctx.world.camera.three;
  const w = ctx.rightHost.clientWidth, h = ctx.rightHost.clientHeight;
  for (const { el, pos } of measureLabels) {
    const v = pos.clone().project(cam);
    if (v.z > 1 || v.z < -1) { el.style.display = "none"; continue; }
    el.style.display = "block";
    el.style.left = `${(v.x * 0.5 + 0.5) * w}px`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * h}px`;
  }
}

export function setMeasureEnabled(on: boolean) {
  ctx.lengthMeasurer.enabled = on;
  ctx.lengthMeasurer.visible = true;
  ctx.highlighter.enabled = !on;
  if (on) setSectionOn(false);
  // Hide the floating label layer when the tool is off. The underlying
  // dimensions remain in the OBC measurer -- re-enabling restores them.
  try { measureLabelLayer.style.display = on ? "block" : "none"; } catch { /* */ }
  const el = measureCheckboxEl ?? ctx.leftHost.querySelector("bim-checkbox[data-measure]");
  if (el) el.checked = on;
}

export function toggleMeasure() { setMeasureEnabled(!ctx.lengthMeasurer.enabled); }

export function clearMeasurements() {
  try {
    const list = (ctx.lengthMeasurer as any).list;
    if (list?.clear) list.clear();
    else if (typeof (ctx.lengthMeasurer as any).deleteAll === "function") (ctx.lengthMeasurer as any).deleteAll();
  } catch (e) { console.warn("clear measurements", e); }
  clearXyzGraphics();
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
  pendingMeasurePts = [];
}

function line3(a: THREE.Vector3, b: THREE.Vector3, color: number) {
  const g = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  l.renderOrder = 1000;
  return l;
}

function ball(p: THREE.Vector3, color: number) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.position.copy(p); m.renderOrder = 1001;
  return m;
}

function drawXyzDimension(a: THREE.Vector3, b: THREE.Vector3) {
  clearXyzGraphics(); clearMeasureLabels();
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const pX = new THREE.Vector3(b.x, a.y, a.z), pXY = new THREE.Vector3(b.x, b.y, a.z);
  if (Math.abs(dx) > 1e-6) { xyzGroup.add(line3(a, pX, 0xef4444)); addMeasureLabel(`X ${(Math.abs(dx) * 1000).toFixed(1)} mm`, a.clone().lerp(pX, 0.5)); }
  if (Math.abs(dy) > 1e-6) { xyzGroup.add(line3(pX, pXY, 0x22c55e)); addMeasureLabel(`Y ${(Math.abs(dy) * 1000).toFixed(1)} mm`, pX.clone().lerp(pXY, 0.5)); }
  if (Math.abs(dz) > 1e-6) { xyzGroup.add(line3(pXY, b, 0x3b82f6)); addMeasureLabel(`Z ${(Math.abs(dz) * 1000).toFixed(1)} mm`, pXY.clone().lerp(b, 0.5)); }
  xyzGroup.add(line3(a, b, 0x38bdf8));
  addMeasureLabel(`${(a.distanceTo(b) * 1000).toFixed(1)} mm`, a.clone().lerp(b, 0.5));
  xyzGroup.add(ball(a, 0xffffff)); xyzGroup.add(ball(b, 0xffffff));
}

// ── Setup ──
export function setupMeasure() {
  const lm = ctx.lengthMeasurer;
  lm.world = ctx.world;
  lm.color = new THREE.Color("#38bdf8");
  lm.enabled = false;
  lm.visible = true;
  try { lm.units = "mm"; } catch { /* */ }
  try { (lm as any).snappings = [FRAGS.SnappingClass.POINT, FRAGS.SnappingClass.LINE]; } catch { /* */ }

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
          const units = (lm as any).units || "m";
          let display = val, suffix = units;
          if (units === "mm" && Math.abs(val) < 50) { display = val * 1000; suffix = "mm"; }
          addMeasureLabel(`${display.toFixed(1)} ${suffix}`, mid);
        }
      } catch (err) { console.warn("[measure] label failed", err); }
    });
  } catch { /* */ }

  ctx.rightHost.addEventListener("dblclick", async () => {
    if (isDrawingActive() || !ctx.lengthMeasurer.enabled) return;
    try { ctx.lengthMeasurer.create(); } catch { /* */ }
    try {
      const caster = ctx.components.get(OBC.Raycasters).get(ctx.world);
      const result: any = await caster.castRay({
        snappingClasses: [FRAGS.SnappingClass.POINT, FRAGS.SnappingClass.LINE],
      });
      if (result?.point) {
        const pt = (result.point as THREE.Vector3).clone();
        pendingMeasurePts.push(pt);
        xyzGroup.add(ball(pt, 0x22d3ee));
        if (pendingMeasurePts.length >= 2) { drawXyzDimension(pendingMeasurePts[0], pendingMeasurePts[1]); pendingMeasurePts = []; }
      }
    } catch (err) { console.warn("[measure] castRay error", err); }
  });

  window.addEventListener("keydown", (e) => {
    if (!ctx.lengthMeasurer.enabled) return;
    if (e.code === "Enter" || e.code === "NumpadEnter") { try { (ctx.lengthMeasurer as any).endCreation?.(); } catch { /* */ } }
    if (e.code === "Escape") { try { (ctx.lengthMeasurer as any).cancelCreation?.(); } catch { /* */ } }
  });

  ctx.features.measure = { isEnabled: isMeasureEnabled, toggle: toggleMeasure, clear: clearMeasurements };
}