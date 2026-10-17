/**
 * ViewCube Pro — Revit-style orientation widget.
 *
 * Pick zones (26): 6 faces · 12 edges · 8 corners.
 * Right-click menu + bottom button row (Home · Fit · Roll ±90°).
 * Native projection only — no ortho/perspective toggle.
 * World north only — Project North / True North UI removed.
 *
 * All state-dependent initialization happens inside setupViewCube().
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import {
  gotoDir, gotoExactView, fitAll, goHome, setProjection, getProjection,
} from "./camera-tools";

/** Revit: Project North angle (degrees, CCW from True/world +Z as Front). */
let projectNorthDeg = 0;
/** Active orientation mode for the compass & face clicks. */
let northMode: "project" | "true" = "project";

export function getProjectNorthDeg() { return projectNorthDeg; }
export function getNorthMode() { return northMode; }

export function setProjectNorthDeg(deg: number) {
  projectNorthDeg = ((deg % 360) + 360) % 360;
  updateNorthReadout();
}

export function setNorthMode(mode: "project" | "true") {
  northMode = mode;
  updateNorthReadout();
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: {
        message: mode === "project" ? "Orientation: Project North" : "Orientation: True North",
        kind: "info",
      },
    }));
  } catch { /* */ }
}

/** World-space +Z is FRONT at 0° True North. Project North rotates that. */
function northOffsetRad(): number {
  // Project / True North toggles removed — always world (true) north.
  return 0;
}

function applyNorthToDir(dir: THREE.Vector3): THREE.Vector3 {
  const off = northOffsetRad();
  if (Math.abs(off) < 1e-8) return dir.clone().normalize();
  // Rotate around world Y (up)
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), off);
  return dir.clone().applyQuaternion(q).normalize();
}

function gotoDirOriented(dir: THREE.Vector3, _forceOrthoFace = true) {
  // Keep native projection; only orient the camera.
  gotoDir(applyNorthToDir(dir));
}

function updateNorthReadout() {
  try {
    const mode = northMode === "project" ? "PN" : "TN";
    const ang = Math.round(projectNorthDeg);
    readout.textContent = `${mode} ${ang}°`;
  } catch { /* */ }
}

const CUBE_PX = 148;
export const cubeHost = document.createElement("div");
cubeHost.style.display = "none";
cubeHost.style.cssText =
  `position:absolute;top:14px;right:14px;width:${CUBE_PX}px;z-index:30;` +
  `user-select:none;-webkit-user-select:none`;

const canvas = document.createElement("canvas");
canvas.style.cssText = "display:block;cursor:grab;border-radius:8px";
cubeHost.appendChild(canvas);

const readout = document.createElement("div");
readout.style.cssText =
  "position:absolute;left:0;right:0;top:-18px;text-align:center;" +
  "font:10px ui-monospace, monospace;color:#94a3b8;letter-spacing:.4px";
readout.textContent = "";
cubeHost.appendChild(readout);

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setSize(CUBE_PX, CUBE_PX);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(42, 1, 0.1, 20);
cam.position.set(0, 0, 4.4);

/* ── Compass ring under the cube ─────────────────────────────────────── */
function makeTextSprite(text: string, color: string, size = 0.5): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.font = "700 72px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  spr.scale.set(size, size, 1);
  spr.renderOrder = 50;
  return spr;
}

const compassGroup = new THREE.Group();
{
  const R = 2.35;
  const ringGeo = new THREE.RingGeometry(R - 0.02, R, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthTest: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.renderOrder = 40;
  compassGroup.add(ring);

  const dirs: [string, number, number, string][] = [
    ["N", 0, 1, "#22c55e"],
    ["S", 0, -1, "#ef4444"],
    ["E", 1, 0, "#38bdf8"],
    ["W", -1, 0, "#f59e0b"],
  ];
  for (const [label, x, y, color] of dirs) {
    const spr = makeTextSprite(label, color, 0.55);
    spr.position.set(x * R, y * R, 0.01);
    compassGroup.add(spr);
  }
}
scene.add(compassGroup);

/* ── Cube ────────────────────────────────────────────────────────────── */
function makeFaceTexture(text: string, bg: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "rgba(60,70,85,.55)";
  g.lineWidth = 5;
  g.strokeRect(3, 3, 122, 122);
  g.fillStyle = "#1c2430";
  g.font = "700 22px system-ui, Segoe UI, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

const faceDefs = [
  { dir: new THREE.Vector3(1, 0, 0), label: "RIGHT", bg: "#d7dbe0" },
  { dir: new THREE.Vector3(-1, 0, 0), label: "LEFT", bg: "#d7dbe0" },
  { dir: new THREE.Vector3(0, 1, 0), label: "TOP", bg: "#eef1f5" },
  { dir: new THREE.Vector3(0, -1, 0), label: "BOTTOM", bg: "#b7bec7" },
  { dir: new THREE.Vector3(0, 0, 1), label: "FRONT", bg: "#d7dbe0" },
  { dir: new THREE.Vector3(0, 0, -1), label: "BACK", bg: "#d7dbe0" },
];

const cubeFaceMeshes: THREE.Mesh[] = [];
const cubeGroup = new THREE.Group();
{
  const size = 1.7;
  const geo = new THREE.BoxGeometry(size, size, size);
  const mats = faceDefs.map((f) =>
    new THREE.MeshBasicMaterial({ map: makeFaceTexture(f.label, f.bg) }),
  );
  const cube = new THREE.Mesh(geo, mats);
  cubeGroup.add(cube);
  cubeFaceMeshes.push(cube);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0x6b7280 }),
  );
  cubeGroup.add(edges);
}
scene.add(cubeGroup);

/* ── 26-zone picking ─────────────────────────────────────────────────── */
type Zone =
  | { kind: "face"; dir: THREE.Vector3 }
  | { kind: "edge"; a: THREE.Vector3; b: THREE.Vector3 }
  | { kind: "corner"; a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3 };

const EDGE_MARGIN = 0.25;

function classifyHit(mesh: THREE.Mesh, pointLocalToMesh: THREE.Vector3, faceNormal: THREE.Vector3): Zone {
  const n = faceNormal.clone().normalize();
  const up = new THREE.Vector3(0, 1, 0);
  let right = new THREE.Vector3().crossVectors(up, n);
  if (right.lengthSq() < 0.01) right = new THREE.Vector3(1, 0, 0);
  right.normalize();
  const upOnFace = new THREE.Vector3().crossVectors(n, right).normalize();

  const p = pointLocalToMesh.clone();
  const u = p.dot(right);
  const v = p.dot(upOnFace);

  const params: any = (mesh.geometry as any)?.parameters ?? {};
  const half = ((params.width as number) ?? 1.7) / 2;
  const limit = half * (1 - EDGE_MARGIN);

  const nearU = Math.abs(u) > limit;
  const nearV = Math.abs(v) > limit;

  if (nearU && nearV) {
    return {
      kind: "corner",
      a: n.clone(),
      b: right.clone().multiplyScalar(Math.sign(u)),
      c: upOnFace.clone().multiplyScalar(Math.sign(v)),
    };
  }
  if (nearU) return { kind: "edge", a: n.clone(), b: right.clone().multiplyScalar(Math.sign(u)) };
  if (nearV) return { kind: "edge", a: n.clone(), b: upOnFace.clone().multiplyScalar(Math.sign(v)) };
  return { kind: "face", dir: n.clone() };
}

function zoneToDir(zone: Zone): THREE.Vector3 {
  if (zone.kind === "face") return zone.dir.clone().normalize();
  if (zone.kind === "edge") return zone.a.clone().add(zone.b).normalize();
  return zone.a.clone().add(zone.b).add(zone.c).normalize();
}

function zoneLabel(zone: Zone): string {
  const d = zoneToDir(zone);
  const parts: string[] = [];
  if (d.y > 0.4) parts.push("Top");
  else if (d.y < -0.4) parts.push("Bottom");
  if (d.z > 0.4) parts.push("Front");
  else if (d.z < -0.4) parts.push("Back");
  if (d.x > 0.4) parts.push("Right");
  else if (d.x < -0.4) parts.push("Left");
  return parts.join("-") || "View";
}

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function ndcOf(e: MouseEvent): THREE.Vector2 {
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1,
  );
}

function pickZone(e: MouseEvent): { zone: Zone; label: string } | null {
  ndc.copy(ndcOf(e));
  raycaster.setFromCamera(ndc, cam);
  const hits = raycaster.intersectObjects(cubeFaceMeshes, false);
  if (!hits.length || !hits[0].face) return null;
  const hit = hits[0];
  const mesh = hit.object as THREE.Mesh;

  const local = hit.point.clone();
  mesh.worldToLocal(local);

  if (!hit.face) return null;
  const worldNormal = hit.face.normal.clone().transformDirection(mesh.matrixWorld);
  let bestDir = faceDefs[0].dir;
  let bestDot = -2;
  for (const f of faceDefs) {
    const d = f.dir.dot(worldNormal);
    if (d > bestDot) { bestDot = d; bestDir = f.dir; }
  }

  const zone = classifyHit(mesh, local, bestDir);
  return { zone, label: zoneLabel(zone) };
}

/* ── Hover + cursor ──────────────────────────────────────────────────── */
function setHover(on: boolean) {
  canvas.style.cursor = on ? "pointer" : cubeDragging ? "grabbing" : "grab";
}

/* ── Drag-orbit ──────────────────────────────────────────────────────── */
let cubeDragging = false;
let cubeDown: { x: number; y: number } | null = null;

/* ── Click ───────────────────────────────────────────────────────────── */
function onClick(e: MouseEvent) {
  const pick = pickZone(e);
  if (!pick) return;
  if (pick.zone.kind === "face") {
    const d = pick.zone.dir;
    if (d.y > 0.9) return gotoExactView("top");
    if (d.y < -0.9) return gotoExactView("bottom");
    if (d.z > 0.9) return gotoExactView("front");
    if (d.z < -0.9) return gotoExactView("back");
    if (d.x > 0.9) return gotoExactView("right");
    if (d.x < -0.9) return gotoExactView("left");
  }
  gotoDirOriented(zoneToDir(pick.zone), false);
}

/* ── Roll camera around view axis ────────────────────────────────────── */
function rollCamera(angle: number) {
  try {
    const cam3 = ctx.world.camera.three;
    const controls: any = ctx.world.camera.controls;
    const target = new THREE.Vector3();
    if (controls?.target?.isVector3) target.copy(controls.target);
    else target.set(0, 0, 0);

    const dir = new THREE.Vector3().subVectors(target, cam3.position).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(dir, angle);
    const up = cam3.up.clone().applyQuaternion(q);
    cam3.up.copy(up);

    const pos = cam3.position.clone();
    if (controls && typeof controls.setLookAt === "function") {
      controls.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, true);
    }
  } catch (err) {
    console.warn("[viewcube] roll failed", err);
  }
}

/* ── Right-click menu ────────────────────────────────────────────────── */
const cubeMenu = document.createElement("div");
cubeMenu.style.cssText =
  "position:fixed;z-index:9000;display:none;min-width:190px;" +
  "background:var(--bg-floating,#1c1e28);border:1px solid var(--border-default,#2a2e3a);" +
  "border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,.55);padding:4px 0;" +
  "font:12px system-ui,sans-serif;color:var(--text-primary,#e8eaf0)";
document.body.appendChild(cubeMenu);

function menuItem(label: string, onclick: () => void, kbd = "") {
  const row = document.createElement("div");
  row.style.cssText =
    "padding:6px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;white-space:nowrap";
  row.onmouseenter = () => (row.style.background = "rgba(56,189,248,0.14)");
  row.onmouseleave = () => (row.style.background = "transparent");
  row.innerHTML =
    `<span style="flex:1">${label}</span>` +
    (kbd ? `<span style="font:10px ui-monospace, monospace;opacity:.55">${kbd}</span>` : "");
  row.onclick = () => { cubeMenu.style.display = "none"; onclick(); };
  return row;
}

function menuSep() {
  const d = document.createElement("div");
  d.style.cssText = "height:1px;background:var(--border-subtle,#1e2029);margin:4px 8px";
  return d;
}

function openCubeMenu(e: MouseEvent) {
  cubeMenu.innerHTML = "";
  cubeMenu.appendChild(menuItem("🏠  Home", () => goHome(), "H"));
  cubeMenu.appendChild(menuItem("⛶  Fit to View", () => fitAll(), "F"));
  cubeMenu.appendChild(menuSep());
  cubeMenu.appendChild(menuItem("⟲  Roll Left 90°", () => rollCamera(-Math.PI / 2)));
  cubeMenu.appendChild(menuItem("⟳  Roll Right 90°", () => rollCamera(Math.PI / 2)));
  cubeMenu.appendChild(menuSep());
  cubeMenu.appendChild(menuItem("Top", () => gotoExactView("top")));
  cubeMenu.appendChild(menuItem("Bottom", () => gotoExactView("bottom")));
  cubeMenu.appendChild(menuItem("Front", () => gotoExactView("front")));
  cubeMenu.appendChild(menuItem("Back", () => gotoExactView("back")));
  cubeMenu.appendChild(menuItem("Right", () => gotoExactView("right")));
  cubeMenu.appendChild(menuItem("Left", () => gotoExactView("left")));
  cubeMenu.style.left = `${e.clientX}px`;
  cubeMenu.style.top = `${e.clientY}px`;
  cubeMenu.style.display = "block";

  const close = (ev: MouseEvent) => {
    if (!cubeMenu.contains(ev.target as Node)) {
      cubeMenu.style.display = "none";
      document.removeEventListener("mousedown", close, true);
    }
  };
  document.addEventListener("mousedown", close, true);
}

/* ── Bottom button row ───────────────────────────────────────────────── */
const btnRow = document.createElement("div");
btnRow.style.cssText = "display:flex;gap:3px;margin-top:4px;justify-content:center";
cubeHost.appendChild(btnRow);

const btnCss =
  "flex:1;font:600 10px system-ui;padding:5px 0;background:#22232c;color:#cbd5e1;" +
  "border:1px solid #3a3a4a;border-radius:5px;cursor:pointer;transition:all .12s";

const homeBtn = document.createElement("button");
homeBtn.textContent = "⌂";
homeBtn.title = "Home view (H)";
homeBtn.style.cssText = btnCss;
homeBtn.onclick = () => goHome();

const fitBtn = document.createElement("button");
fitBtn.textContent = "⛶";
fitBtn.title = "Fit to view (F)";
fitBtn.style.cssText = btnCss;
fitBtn.onclick = () => fitAll();

const rollL = document.createElement("button");
rollL.textContent = "⟲";
rollL.title = "Roll left 90°";
rollL.style.cssText = btnCss;
rollL.onclick = () => rollCamera(-Math.PI / 2);

const rollR = document.createElement("button");
rollR.textContent = "⟳";
rollR.title = "Roll right 90°";
rollR.style.cssText = btnCss;
rollR.onclick = () => rollCamera(Math.PI / 2);

const projBtn = document.createElement("button");
projBtn.title = "Toggle Perspective / Orthographic";
projBtn.style.cssText = btnCss + ";flex:2";

function updateProjectionButton() {
  // Guard: this may be called before the viewer is up.
  let p: "perspective" | "orthographic" = "perspective";
  try { p = getProjection(); } catch { /* */ }
  projBtn.textContent = p === "perspective" ? "PERSP" : "ORTHO";
  projBtn.style.borderColor = p === "perspective" ? "#3a3a4a" : "#38bdf8";
  projBtn.style.color = p === "perspective" ? "#cbd5e1" : "#38bdf8";
}

projBtn.onclick = () => { /* projection toggle removed — native only */ };

const northBtn = document.createElement("button");
northBtn.title = "Toggle Project North / True North (Revit)";
northBtn.style.cssText = btnCss + ";flex:2";
northBtn.onclick = () => { /* north toggle removed */ };
function updateNorthButton() {
  northBtn.textContent = northMode === "project" ? "PN" : "TN";
  northBtn.style.borderColor = northMode === "project" ? "#22c55e" : "#38bdf8";
  northBtn.style.color = northMode === "project" ? "#86efac" : "#7dd3fc";
}
updateNorthButton();

btnRow.append(homeBtn, fitBtn, rollL, rollR);

/* ── Event listeners on the cube ─────────────────────────────────────── */
canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 2) return;
  if (e.button !== 0) return;
  e.stopPropagation();
  cubeDragging = true;
  cubeDown = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = "grabbing";
});

canvas.addEventListener("pointermove", (e) => {
  e.stopPropagation();
  if (cubeDragging && cubeDown) {
    const dx = e.clientX - cubeDown.x;
    const dy = e.clientY - cubeDown.y;
    cubeDown = { x: e.clientX, y: e.clientY };
    const c: any = ctx.world.camera?.controls;
    try {
      if (typeof c?.rotate === "function") c.rotate(dx * 0.008, -dy * 0.008);
      else if (typeof c?.rotateLeft === "function") {
        c.rotateLeft(dx * 0.008);
        c.rotateUp(-dy * 0.008);
      }
    } catch { /* */ }
    return;
  }
  const pick = pickZone(e);
  setHover(!!pick);
  readout.textContent = pick ? pick.label : "";
});

canvas.addEventListener("pointerup", (e) => {
  if (e.button !== 0 || !cubeDragging) return;
  e.stopPropagation();
  cubeDragging = false;
  canvas.style.cursor = "grab";
  const moved = cubeDown ? Math.hypot(e.clientX - cubeDown.x, e.clientY - cubeDown.y) : 0;
  cubeDown = null;
  if (moved < 5) onClick(e);
});

canvas.addEventListener("pointerleave", () => {
  if (!cubeDragging) setHover(false);
  readout.textContent = "";
});

canvas.addEventListener("dblclick", (e) => { e.stopPropagation(); fitAll(); });

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  e.stopPropagation();
  openCubeMenu(e);
});

/* ── Setup (ViewCube removed from platform) ───────────────────────────── */
export function setupViewCube() {
  // Do not mount or animate the cube.
  try {
    cubeHost.style.display = "none";
    cubeHost.remove();
  } catch { /* */ }

  // openbim-fix: viewcube.ts -- release the WebGL renderer + context
  try {
    renderer.dispose();
    const gl: any = (renderer as any).getContext?.();
    if (gl) {
      const ext = gl.getExtension("WEBGL_lose_context");
      ext?.loseContext?.();
    }
  } catch (err) {
    console.warn("[viewcube] renderer dispose failed", err);
  }

    ctx.features.viewcube = {
    host: cubeHost,
    rollLeft: () => { /* removed */ },
    rollRight: () => { /* removed */ },
    setProjectNorth: setProjectNorthDeg,
    getProjectNorth: getProjectNorthDeg,
    setNorthMode,
    getNorthMode,
  };
  console.log("[viewcube] disabled — 3D cube not shown");
}
