/**
 * Walk mode — first-person navigation with simple physics.
 *
 * Physics:
 *   Walls block (capsule-style horizontal ray slide)
 *   Stairs / kerbs within ~0.55 m step up or down while grounded
 *   Openings / voids engage gravity (freefall) until a lower floor is hit
 *   Collision meshes: IFC/FRAG fragments, authored elements, aux OBJ/GLB/…
 *
 * Start / end:
 *   Starts at the current camera position and orientation
 *   Esc exits and keeps the last walk view (does not restore the pre-walk camera)
 *
 * Controls:
 *   W A S D     — move
 *   Mouse       — look (pointer lock)
 *   Shift       — run
 *   Ctrl        — crouch
 *   Space       — raise
 *   C           — lower
 *   Esc         — exit (keep view)
 *
 * The camera in @thatopen/components is driven by `CameraControls`. Simply
 * assigning `camera.position` is not enough — the controls overwrite the
 * camera on their next update tick. We therefore drive the controls via
 * `controls.setLookAt()` on every frame; the controls then place the camera
 * for us and the renderer respects the new position.
 *
 * Ctrl/Alt/Meta combos are passed through to the shortcut registry so global
 * shortcuts (Ctrl+S, Ctrl+Z…) keep working while walking. Only the movement
 * keys are captured exclusively.
 */
import { readControlsTarget } from "../core/controls-target";
import * as THREE from "three";
import { ctx } from "../core/context";
import { getLevel, getLevels, getAuthoredGroup, getElements } from "./authoring";
import { raiseWithCeiling, chaseDistance, clampSpeedFactor, constrainToWall, isBlockingHit, nextLevelElevation, slideVelocity, yawFromDirection } from "./walk-physics";
import type { WallContact } from "./walk-physics";
import { getProjection, setProjection } from "./camera-tools";
import { notify } from "../core/notify";

// ── Tuning ──
const EYE_HEIGHT = 1.7;
const CROUCH_HEIGHT = 1.1;
const WALK_SPEED = 3.2;
const RUN_SPEED = 9.0;
const CROUCH_SPEED = 1.4;
const ACCEL = 12.0;
const LOOK_SENS = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.08;
const RAYCAST_INTERVAL = 3;      // frames between ground raycasts (tighter for stairs/gaps)
const GROUND_SMOOTH = 14.0;      // Y-follow smoothing when grounded
const TARGET_DISTANCE = 5.0;     // metres in front of the eye for the controls target
const GROUND_RAY_LENGTH = 500;   // how far down to look for the ground
const MAX_STEP = 0.55;           // highest kerb/stair riser the walker steps up without a ramp
const MAX_STEP_DOWN = 0.65;      // continuous step-down (stairs) before freefall engages
const FALL_TRIGGER = 0.9;        // gap below feet that starts freefall (openings / voids)
const BODY_RADIUS = 0.32;        // collision radius against walls
const COLLIDE_INTERVAL = 1;      // frames between wall checks
const GRAVITY = -16.0;           // m/s² downward acceleration while airborne
const TERMINAL_V = -28.0;        // terminal fall speed (m/s)
const LANDING_SNAP = 0.08;       // metres — snap to floor when this close while falling

interface SavedCamState {
  projection: "perspective" | "orthographic";
  controlsEnabled: boolean;
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
  near?: number;
  far?: number;
  up: THREE.Vector3;
}

interface WalkState {
  enabled: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  pitch: number;
  keys: Set<string>;
  targetGroundY: number;
  airborne: boolean;
  raycastTick: number;
  rafId: number | null;
  lastT: number;
  saved: SavedCamState | null;
  speedFactor: number;
  collideTick: number;
  dragging: boolean;
  hudTick: number;
  /** Extra height above the standing eye level, set with Space / C when `keepRaise` is on. */
  lift: number;
}

const state: WalkState = {
  enabled: false,
  pos: new THREE.Vector3(),
  vel: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  keys: new Set(),
  targetGroundY: 0,
  airborne: false,
  raycastTick: 0,
  rafId: null,
  lastT: 0,
  saved: null,
  speedFactor: 1,
  collideTick: 0,
  dragging: false,
  hudTick: 0,
  lift: 0,
};

/** Keys walk mode owns exclusively — captured before the shortcut registry. */
const OWNED_KEYS = new Set([
  "w", "a", "s", "d",
  "arrowup", "arrowdown", "arrowleft", "arrowright",
  "shift", "control",
  " ", "c", "pageup", "pagedown",
  "n", "p", "l", "r", "m",
]);

/** User options for walking. Saved in this browser. */
export interface WalkOptions {
  /** Start at the camera's current height and stay at that level when there is no floor under you (instead of falling to the lowest level). */
  holdLevel: boolean;
  /** Walk through walls and other obstacles (floors and stairs still carry you). */
  noClip: boolean;
  /** Show a 1.7 m human figure and view it from behind (third person). */
  human: boolean;
  /** Space raises you and the new height stays fixed when you let go; C lowers you straight down (never below standing height). */
  keepRaise: boolean;
}
const OPT_KEY = "obs-walk-options";
const opts: WalkOptions = (() => {
  const d: WalkOptions = { holdLevel: true, noClip: false, human: false, keepRaise: true };
  try { const r = JSON.parse(localStorage.getItem(OPT_KEY) || "{}"); for (const k of Object.keys(d) as (keyof WalkOptions)[]) if (typeof r[k] === "boolean") d[k] = r[k]; } catch { /* */ }
  return d;
})();
export function getWalkOptions(): WalkOptions { return { ...opts }; }
export function setWalkOption(k: keyof WalkOptions, v: boolean): void {
  opts[k] = !!v;
  try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch { /* */ }
  if (k === "noClip") { resetSensors(); }
  if (k === "human") syncHuman();
  if (state.enabled) { updateStatus(); refreshHint(); }
  try { window.dispatchEvent(new CustomEvent("obs:walk-options-changed", { detail: { ...opts } })); } catch { /* */ }
  try { notify("info", `Walk: ${k === "holdLevel" ? "hold my height" : k === "noClip" ? "walk through walls" : k === "keepRaise" ? "keep raised height" : "human figure"} ${v ? "on" : "off"}`); } catch { /* */ }
}

const HUMAN_HEIGHT = 1.7;
const CHASE_DISTANCE = 2.6;
let human: THREE.Group | null = null;
/** Simple standing figure, 1.7 m from sole to crown (built from primitives, no assets). */
function buildHuman(): THREE.Group {
  const g = new THREE.Group();
  g.name = "obs-walk-human";
  g.userData.walkIgnore = true;
  const skin = new THREE.MeshLambertMaterial({ color: 0xe0b896 });
  const cloth = new THREE.MeshLambertMaterial({ color: 0x3b6ea8 });
  const legs = new THREE.MeshLambertMaterial({ color: 0x2f3542 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.userData.walkIgnore = true; g.add(m); return m; };
  // Heights add up to 1.70: legs 0.80, torso 0.58 (to 1.38 + shoulders), neck/head to 1.70.
  add(new THREE.CylinderGeometry(0.075, 0.065, 0.80, 14), legs, -0.1, 0.40, 0);
  add(new THREE.CylinderGeometry(0.075, 0.065, 0.80, 14), legs, 0.1, 0.40, 0);
  add(new THREE.BoxGeometry(0.40, 0.58, 0.22), cloth, 0, 1.09, 0);
  add(new THREE.CylinderGeometry(0.045, 0.04, 0.60, 12), cloth, -0.26, 1.08, 0);
  add(new THREE.CylinderGeometry(0.045, 0.04, 0.60, 12), cloth, 0.26, 1.08, 0);
  add(new THREE.CylinderGeometry(0.05, 0.055, 0.07, 12), skin, 0, 1.425, 0);
  add(new THREE.SphereGeometry(0.115, 18, 14), skin, 0, 1.585, 0); // crown at 1.70
  return g;
}
/* ── Reference person (key M): a 1.7 m figure left standing in the model to check scale and clearances ── */
let refPerson: THREE.Group | null = null;
function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement("canvas"); c.width = 256; c.height = 96;
  const g = c.getContext("2d");
  if (g) { g.fillStyle = "rgba(15,23,42,.85)"; g.fillRect(0, 0, 256, 96); g.strokeStyle = "#38bdf8"; g.lineWidth = 4; g.strokeRect(2, 2, 252, 92); g.fillStyle = "#e8eaf0"; g.font = "bold 44px system-ui,sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 128, 50); }
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(0.5, 0.1875, 1); sp.position.set(0, HUMAN_HEIGHT + 0.22, 0); sp.renderOrder = 10; sp.userData.walkIgnore = true;
  return sp;
}
export function isReferencePersonShown(): boolean { return !!refPerson?.parent; }
export function removeReferencePerson(): void { if (refPerson?.parent) refPerson.parent.remove(refPerson); refPerson = null; }
/** Show / hide a 1.7 m person. In Walk mode it stands 2 m in front of you, facing you; otherwise it stands on the floor at the middle of the view, facing the camera. */
export async function toggleReferencePerson(): Promise<boolean> {
  if (refPerson?.parent) { removeReferencePerson(); try { notify("info", "Reference person hidden (M)"); } catch { /* */ } return false; }
  const scene = ctx.world.scene.three as THREE.Scene;
  const cam = ctx.world.camera.three as THREE.Camera;
  let x: number, z: number, y: number, face: number;
  if (state.enabled) {
    const fx = -Math.sin(state.yaw), fz = -Math.cos(state.yaw);
    x = state.pos.x + fx * 2; z = state.pos.z + fz * 2;
    const feet = state.pos.y - eyeHeight() - (opts.keepRaise ? state.lift : 0);
    y = raycastGround(x, z, feet + MAX_STEP + 0.3) ?? feet;
    face = state.yaw; // front (+Z) turned back towards the walker
  } else {
    const t = new THREE.Vector3();
    const controls: any = ctx.world.camera.controls;
    if (!readControlsTarget(controls, t)) { cam.getWorldDirection(t); t.multiplyScalar(8).add(cam.position); }
    x = t.x; z = t.z;
    const from = Math.max(t.y, 0) + 3;
    let gy = raycastGround(x, z, from);
    try {
      const m = await modelRay(x, from, z, 0, -1, 0, 400);
      if (m && (gy == null || m.point.y > gy)) gy = m.point.y;
    } catch { /* */ }
    y = gy ?? 0;
    face = Math.atan2(cam.position.x - x, cam.position.z - z);
  }
  removeReferencePerson();
  refPerson = buildHuman();
  refPerson.name = "obs-reference-person";
  refPerson.add(makeLabel("1.70 m"));
  refPerson.position.set(x, y, z);
  refPerson.rotation.y = face;
  scene.add(refPerson);
  try { notify("info", "Reference person 1.70 m shown (press M to hide)"); } catch { /* */ }
  return true;
}

function syncHuman(): void {
  const scene = ctx.world.scene.three as THREE.Scene;
  if (opts.human && state.enabled) {
    if (!human) human = buildHuman();
    if (!human.parent) scene.add(human);
  } else if (human?.parent) human.parent.remove(human);
}

const groundRay = new THREE.Raycaster();

/** Intersect each target on its own: one mesh that cannot be ray-tested (IFC tiles keep no CPU geometry) must not hide the rest. */
function safeIntersect(ray: THREE.Raycaster, targets: THREE.Object3D[]): THREE.Intersection[] {
  const out: THREE.Intersection[] = [];
  for (const t of targets) {
    try { out.push(...ray.intersectObject(t, true)); } catch { /* this target cannot be ray-tested */ }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/* ── Fragments (IFC) sensors ──
   IFC models are drawn by the fragments engine and keep no triangles on the main thread, so plain three.js rays never hit them.
   The model's own (worker-side) raycast is asynchronous, so it feeds the physics through world-fixed results: wall planes the
   walker touched, and the floor height under it. They are applied every frame, whatever the answer latency. */
let wallContacts: WallContact[] = [];
let fragGround: { x: number; z: number; y: number; t: number } | null = null;
const sensorBusy = { chest: false, knee: false, ground: false };

/* Head clearance: nearest obstacle straight above the eye (the model-side answer arrives later, stored as a world height). */
let ceilModelY: number | null = null;
let ceilBusy = false;
function ceilingDistance(): number | null {
  if (opts.noClip) return null;
  let best: number | null = null;
  const models = getCollisionTargets();
  if (models.length) {
    groundRay.set(state.pos.clone(), new THREE.Vector3(0, 1, 0));
    groundRay.far = 14;
    const passable = passableIds();
    for (const h of safeIntersect(groundRay, models)) {
      if (!h.object.visible) continue;
      const hid = hitElementId(h.object);
      if (hid && passable.has(hid)) continue;
      best = h.distance;
      break;
    }
  }
  if (!ceilBusy) {
    ceilBusy = true;
    const y0 = state.pos.y;
    void modelRay(state.pos.x, y0, state.pos.z, 0, 1, 0, 14)
      .then((r) => { ceilModelY = r ? y0 + r.distance : null; })
      .catch(() => { ceilModelY = null; })
      .finally(() => { ceilBusy = false; });
  }
  if (ceilModelY !== null) { const d = ceilModelY - state.pos.y; if (d >= 0 && (best === null || d < best)) best = d; }
  return best;
}

/* Third-person camera: nearest obstacle between the walker and the camera (model-side answer arrives later). */
let chaseModelHit: number | null = null;
let chaseDist = CHASE_DISTANCE;
let chaseBusy = false;

function resetSensors(): void {
  chaseModelHit = null; chaseDist = CHASE_DISTANCE; chaseBusy = false; ceilModelY = null; ceilBusy = false;
  wallContacts = []; fragGround = null;
  sensorBusy.chest = sensorBusy.knee = sensorBusy.ground = false;
}

async function modelRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, range: number): Promise<{ distance: number; point: THREE.Vector3; normal: THREE.Vector3 } | null> {
  const dom = ctx.world.renderer?.three?.domElement as HTMLElement | undefined;
  if (!dom) return null;
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, range);
  if (Math.abs(dy) > 0.99) cam.up.set(0, 0, -1);
  cam.position.set(ox, oy, oz);
  cam.lookAt(ox + dx, oy + dy, oz + dz);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const rect = dom.getBoundingClientRect();
  const mouse = new THREE.Vector2(rect.left + rect.width / 2, rect.top + rect.height / 2); // the camera axis = our ray
  let best: { distance: number; point: THREE.Vector3; normal: THREE.Vector3 } | null = null;
  for (const [, m] of ctx.fragments.list as Iterable<[unknown, any]>) {
    if (typeof m?.raycast !== "function") continue;
    try {
      const r = await m.raycast({ camera: cam, mouse, dom });
      if (r && r.point && r.normal && Number.isFinite(r.distance) && r.distance <= range && (!best || r.distance < best.distance)) {
        best = { distance: r.distance, point: r.point.clone(), normal: r.normal.clone() };
      }
    } catch { /* model not ready */ }
  }
  return best;
}

function fireSensors(wishX: number, wishZ: number, wishSpeed: number): void {
  // Probe where the walker WANTS to go (keys held), not where it currently moves: while pressed against a wall the
  // actual speed is ~0, and probing by speed let the wall contact expire and the body creep into the wall and bounce.
  const speed = Math.hypot(wishX, wishZ) > 0.01 ? wishSpeed : Math.hypot(state.vel.x, state.vel.z);
  const feetY = state.pos.y - eyeHeight();
  const x = state.pos.x, z = state.pos.z;
  if (speed > 0.2) {
    const useWish = Math.hypot(wishX, wishZ) > 0.01;
    const dx = useWish ? wishX : state.vel.x / speed, dz = useWish ? wishZ : state.vel.z / speed;
    const reach = BODY_RADIUS + 0.45 * speed + 0.4;
    const heights: Array<["chest" | "knee", number]> = [["knee", feetY + MAX_STEP + 0.1], ["chest", feetY + 1.2]];
    for (const [name, y] of heights) {
      if (sensorBusy[name]) continue;
      sensorBusy[name] = true;
      void modelRay(x, y, z, dx, 0, dz, reach).then((h) => {
        if (!state.enabled || !h) return;
        const hl = Math.hypot(h.normal.x, h.normal.z);
        if (Math.abs(h.normal.y) >= 0.7 || hl < 1e-6) return; // floor / ramp, not a wall
        let nx = h.normal.x / hl, nz = h.normal.z / hl;
        if (nx * dx + nz * dz > 0) { nx = -nx; nz = -nz; } // face the walker
        const c: WallContact = { px: h.point.x, pz: h.point.z, nx, nz, t: performance.now(), feet0: feetY };
        const same = wallContacts.findIndex((o) => o.nx * nx + o.nz * nz > 0.95 && Math.abs((o.px - c.px) * nx + (o.pz - c.pz) * nz) < 0.2);
        if (same >= 0) wallContacts[same] = c; else { wallContacts.push(c); if (wallContacts.length > 6) wallContacts.shift(); }
      }).finally(() => { sensorBusy[name] = false; });
    }
  }
  if (!sensorBusy.ground) {
    sensorBusy.ground = true;
    const from = Math.max(feetY + MAX_STEP + 0.08, state.targetGroundY + MAX_STEP + 0.08);
    void modelRay(x, from, z, 0, -1, 0, GROUND_RAY_LENGTH).then((h) => {
      if (state.enabled && h) fragGround = { x, z, y: h.point.y, t: performance.now() };
    }).finally(() => { sensorBusy.ground = false; });
  }
}

// ── HUD ──
let overlay: HTMLDivElement | null = null;
let crosshair: HTMLDivElement | null = null;
let hint: HTMLDivElement | null = null;
let exitBtn: HTMLButtonElement | null = null;
let statusEl: HTMLDivElement | null = null;

function hintHtml(): string {
  const kbd = (t: string) =>
    `<kbd style="padding:1px 5px;border:1px solid #3d4250;border-radius:3px;font:10px monospace">${t}</kbd>`;
  const on = (v: boolean) => (v ? `<b style="color:#4ade80">on</b>` : `<span style="opacity:.6">off</span>`);
  return `<b style="color:#38bdf8">WALK</b> · ` +
    `${kbd("W")}${kbd("A")}${kbd("S")}${kbd("D")} move · ` +
    `${kbd("Shift")} run · ${kbd("Ctrl")} crouch · ` +
    `${kbd("Space")}/${kbd("C")} up/down ${on(opts.keepRaise)} ${kbd("R")} keep height · ` +
    `${kbd("PgUp")}/${kbd("PgDn")} level · wheel speed · ` +
    `${kbd("Esc")} exit<br>` +
    `${kbd("L")} hold my height ${on(opts.holdLevel)} · ${kbd("N")} through walls ${on(opts.noClip)} · ${kbd("P")} human 1.7 m ${on(opts.human)} · ${kbd("M")} place / remove a 1.7 m person`;
}
function refreshHint(): void { if (hint) hint.innerHTML = hintHtml(); }

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "obs-walk-overlay";
  overlay.style.cssText =
    "position:absolute;inset:0;z-index:60;cursor:none;background:transparent;" +
    "user-select:none;-webkit-user-select:none";

  crosshair = document.createElement("div");
  crosshair.style.cssText =
    "position:absolute;left:50%;top:50%;width:14px;height:14px;" +
    "transform:translate(-50%,-50%);pointer-events:none;opacity:.9";
  crosshair.innerHTML =
    `<svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">` +
    `<line x1="7" y1="1" x2="7" y2="5" stroke="rgba(255,255,255,.85)" stroke-width="1.4"/>` +
    `<line x1="7" y1="9" x2="7" y2="13" stroke="rgba(255,255,255,.85)" stroke-width="1.4"/>` +
    `<line x1="1" y1="7" x2="5" y2="7" stroke="rgba(255,255,255,.85)" stroke-width="1.4"/>` +
    `<line x1="9" y1="7" x2="13" y2="7" stroke="rgba(255,255,255,.85)" stroke-width="1.4"/>` +
    `<circle cx="7" cy="7" r="1" fill="rgba(255,255,255,.9)"/>` +
    `</svg>`;

  hint = document.createElement("div");
  hint.style.cssText =
    "position:absolute;left:50%;top:14px;transform:translateX(-50%);" +
    "background:rgba(20,22,30,.85);border:1px solid rgba(56,189,248,.35);" +
    "border-radius:6px;padding:7px 14px;font:11.5px/1.4 system-ui,sans-serif;" +
    "color:#e8eaf0;text-align:center;white-space:nowrap;backdrop-filter:blur(6px);" +
    "box-shadow:0 6px 20px rgba(0,0,0,.4)";
  hint.innerHTML = hintHtml();

  exitBtn = document.createElement("button");
  exitBtn.textContent = "Exit walk mode  (Esc)";
  exitBtn.style.cssText =
    "position:absolute;right:14px;bottom:14px;padding:8px 14px;cursor:pointer;" +
    "background:rgba(20,22,30,.9);color:#e8eaf0;" +
    "border:1px solid rgba(239,68,68,.6);border-radius:6px;" +
    "font:12px system-ui,sans-serif;backdrop-filter:blur(6px)";
  exitBtn.onclick = () => disableWalkMode();

  statusEl = document.createElement("div");
  statusEl.style.cssText =
    "position:absolute;left:14px;bottom:14px;padding:6px 10px;border-radius:6px;" +
    "background:rgba(20,22,30,.85);color:#c9d1d9;font:11px/1.5 ui-monospace,monospace;" +
    "border:1px solid rgba(255,255,255,.12);pointer-events:none;white-space:pre";

  overlay.addEventListener("mousedown", (e) => { if (e.button === 0) state.dragging = true; });
  // If the browser refused the first pointer-lock request, a click on the view captures the mouse.
  overlay.addEventListener("click", () => {
    if (state.enabled && document.pointerLockElement !== overlay) { try { overlay!.requestPointerLock(); } catch { /* */ } }
  });
  window.addEventListener("mouseup", () => { state.dragging = false; });

  overlay.append(crosshair, hint, statusEl, exitBtn);
  ctx.rightHost.appendChild(overlay);
  return overlay;
}

/* ═════════════════════════════════════════════════════════════════════════
   Ground raycast — find the surface below a given (x, z)
   ═════════════════════════════════════════════════════════════════════════ */
function collectSceneMeshes(): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  // ThatOpen Fragments (IFC / FRAG linked models)
  try {
    for (const [, model] of ctx.fragments.list) {
      if (model?.object) out.push(model.object);
    }
  } catch { /* */ }
  // Native authored elements
  try { const ag = getAuthoredGroup(); if (ag) out.push(ag); } catch { /* */ }
  // Aux imports (OBJ / GLB / FBX / …)
  try {
    const aux = (ctx.features as any)?.fileInterop?.getAuxObjects?.() as THREE.Object3D[] | undefined;
    if (aux?.length) out.push(...aux);
  } catch { /* */ }
  return out;
}

function getWalkTargets(): THREE.Object3D[] {
  const out = collectSceneMeshes();
  if (ctx.groundPlane) out.push(ctx.groundPlane);
  return out;
}

/** Wall-collision targets: all linked model types + authored (no infinite ground plane). */
function getCollisionTargets(): THREE.Object3D[] {
  return collectSceneMeshes();
}

/** Ids of elements the walker may pass through (doors / openings / windows). */
function passableIds(): Set<string> {
  const ids = new Set<string>();
  const pass = new Set(["door", "opening", "window", "void", "space"]);
  try {
    for (const e of getElements() as any[]) {
      const ty = String(e?.type ?? "").toLowerCase();
      if (pass.has(ty)) ids.add(String(e.id));
    }
  } catch { /* */ }
  return ids;
}
function hitElementId(o: THREE.Object3D | null): string | null {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) {
    const id = (n.userData as any)?.elementId;
    if (id != null) return String(id);
  }
  return null;
}

function raycastGround(x: number, z: number, fromY: number): number | null {
  const origin = new THREE.Vector3(x, fromY, z);
  groundRay.set(origin, new THREE.Vector3(0, -1, 0));
  groundRay.far = GROUND_RAY_LENGTH;
  const targets = getWalkTargets();
  let found: number | null = null;
  try {
    const hits = safeIntersect(groundRay, targets);
    for (const h of hits) {
      if (h.point.y < fromY - 0.02) { found = h.point.y; break; }
    }
  } catch { /* */ }
  const fg = fragGround;
  if (fg && performance.now() - fg.t < 1000 && Math.hypot(fg.x - x, fg.z - z) < 0.9 && fg.y < fromY - 0.02 && (found == null || fg.y > found)) found = fg.y;
  return found;
}

function eyeHeight(): number {
  return state.keys.has("control") ? CROUCH_HEIGHT : EYE_HEIGHT;
}

/**
 * Probe the floor under the walker.
 * - Stairs / kerbs within MAX_STEP → step up/down (grounded).
 * - Larger drop (opening, atrium, missing slab) → freefall toward lower floor.
 * - No hit → freefall (void).
 */
function updateGroundTarget() {
  const feetY = state.pos.y - eyeHeight();
  // Probe from just above the feet + max step so we can step up stairs
  // without locking onto ceilings/roofs above the head.
  const from = Math.max(feetY + MAX_STEP + 0.08, state.targetGroundY + MAX_STEP + 0.08);
  const found = raycastGround(state.pos.x, state.pos.z, from);

  if (found == null) {
    // Nothing below — open void / outside the model.
    if (opts.holdLevel) return; // stay on the level you are on
    state.airborne = true;
    return;
  }

  const drop = feetY - found; // positive = floor is below feet

  if (drop < -MAX_STEP) {
    // Floor is higher than we can step — treat as a wall, keep current ground.
    return;
  }

  if (drop > FALL_TRIGGER) {
    // Opening / missing slab / deep stair run: fall to the lower floor (unless the walker holds its level).
    if (opts.holdLevel) return;
    state.targetGroundY = found;
    state.airborne = true;
    return;
  }

  // Continuous surface or short stair riser/tread.
  state.targetGroundY = found;
  if (state.airborne && drop <= LANDING_SNAP) {
    state.airborne = false;
    state.vel.y = 0;
  } else if (!state.airborne) {
    state.airborne = false;
  }
}

/** Wall planes measured by the fragments sensors (IFC models): applied every frame, independent of answer latency. */
function applyWallContacts(): void {
  const nowMs = performance.now();
  // A wall measured at knee height from lower ground may be a stair riser the walker has since stepped up past:
  // once the feet have risen above where it was measured the sensors re-probe from the new height, so drop it.
  const feetNow = state.pos.y - eyeHeight();
  wallContacts = wallContacts.filter((c) => nowMs - c.t < 1200 && !(c.feet0 != null && feetNow - c.feet0 > 0.04));
  for (const c of wallContacts) {
    const r = constrainToWall(state.pos.x, state.pos.z, state.vel.x, state.vel.z, c, BODY_RADIUS);
    if (r.hit) { state.pos.x = r.x; state.pos.z = r.z; state.vel.x = r.vx; state.vel.z = r.vz; }
  }
}

/** Block / slide the horizontal motion against walls. Returns true when blocked this frame. */
function applyCollision(dt: number): void {
  applyWallContacts();
  const speed = Math.hypot(state.vel.x, state.vel.z);
  if (speed < 0.05) return;
  const models = getCollisionTargets();
  if (!models.length) return;
  const passable = passableIds();
  const dir = new THREE.Vector3(state.vel.x / speed, 0, state.vel.z / speed);
  const travel = speed * dt * COLLIDE_INTERVAL;
  // Knee-above-step and chest height: low obstacles that can be stepped over are ignored.
  const heights = [state.targetGroundY + MAX_STEP + 0.1, state.targetGroundY + 1.2];
  for (const y of heights) {
    groundRay.set(new THREE.Vector3(state.pos.x, y, state.pos.z), dir);
    groundRay.far = BODY_RADIUS + travel + 0.05;
    let hits: THREE.Intersection[] = [];
    hits = safeIntersect(groundRay, models);
    for (const h of hits) {
      if (!h.face) continue;
      if (!h.object.visible) continue;
      const hid = hitElementId(h.object);
      if (hid && passable.has(hid)) continue;
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if (!isBlockingHit(h.distance, n.y, BODY_RADIUS, travel)) continue;
      const [vx, vz] = slideVelocity(state.vel.x, state.vel.z, n.x, n.z);
      state.vel.x = vx; state.vel.z = vz;
      // Do not let the body penetrate: back off to the radius.
      const pen = BODY_RADIUS - h.distance;
      if (pen > 0) {
        const hn = Math.hypot(n.x, n.z) || 1;
        const sgn = (n.x * dir.x + n.z * dir.z) > 0 ? -1 : 1;
        state.pos.x += (sgn * n.x / hn) * pen;
        state.pos.z += (sgn * n.z / hn) * pen;
      }
      return;
    }
  }
}

function updateStatus(): void {
  if (!statusEl) return;
  let levelName = "";
  try {
    const lv: any[] = getLevels() ?? [];
    let best: any = null;
    for (const l of lv) if (l.elevation <= state.targetGroundY + 0.3 && (!best || l.elevation > best.elevation)) best = l;
    if (best) levelName = best.name;
  } catch { /* */ }
  const f = (n: number) => n.toFixed(2).padStart(8);
  const heading = ((((-state.yaw * 180) / Math.PI) % 360) + 360) % 360;
  statusEl.textContent =
    `X ${f(state.pos.x)} m   Z ${f(state.pos.z)} m   Eye ${f(state.pos.y)} m\n` +
    `Heading ${heading.toFixed(0).padStart(3)}\u00b0   Speed \u00d7${state.speedFactor.toFixed(2)}` +
    (state.airborne ? "   FALLING" : "   GROUNDED") + (opts.noClip ? "   NO-CLIP" : "") + (opts.keepRaise && state.lift > 0.01 ? `   RAISED +${state.lift.toFixed(2)} m` : "") +
    (levelName ? `   Level ${levelName}` : "");
}

/* ═════════════════════════════════════════════════════════════════════════
   Public API
   ═════════════════════════════════════════════════════════════════════════ */
/** Walker pose for the minimap: eye position and heading (yaw 0 faces -Z, positive turns left). */
export function getWalkPose(): { x: number; y: number; z: number; yaw: number; pitch: number } | null {
  if (!state.enabled) return null;
  return { x: state.pos.x, y: state.pos.y, z: state.pos.z, yaw: state.yaw, pitch: state.pitch };
}

export function isWalkModeEnabled(): boolean {
  return state.enabled;
}

export function enableWalkMode(): void {
  if (state.enabled) return;
  try {
    ensureOverlay();           // fail before touching the camera if the HUD cannot be created
    enableWalkModeInner();
  } catch (e) {
    console.error("[walk] could not start", e);
    // Leave the app exactly as it was: controls back on, no half-started mode.
    try { const c: any = ctx.world.camera.controls; if (c) c.enabled = state.saved?.controlsEnabled ?? true; } catch { /* */ }
    state.enabled = false;
    state.saved = null;
    if (state.rafId != null) { cancelAnimationFrame(state.rafId); state.rafId = null; }
    if (overlay) overlay.style.display = "none";
    try { notify("error", "Walk mode could not start: " + (e instanceof Error ? e.message : String(e))); } catch { /* */ }
  }
}

function enableWalkModeInner(): void {

  const cam = ctx.world.camera.three as THREE.PerspectiveCamera;
  const controls: any = ctx.world.camera.controls;

  // ── Save camera + controls state ──
  const savedPos = cam.position.clone();
  // Heading comes from what the camera actually looks at: the controls' target can lag right after a programmatic camera move.
  const seenDir = new THREE.Vector3();
  cam.getWorldDirection(seenDir);
  let savedTarget = new THREE.Vector3();
  if (readControlsTarget(controls, savedTarget)) {
    /* real controls target */
  } else {
    // Fallback: 5 m in front of camera.
    const d = new THREE.Vector3();
    cam.getWorldDirection(d);
    savedTarget.copy(savedPos).add(d.multiplyScalar(TARGET_DISTANCE));
  }

  state.saved = {
    projection: getProjection(),
    controlsEnabled: !!controls?.enabled,
    position: savedPos,
    target: savedTarget,
    fov: cam.fov ?? 60,
    near: cam.near,
    far: cam.far,
    up: cam.up.clone(),
  };

  // ── Force perspective for a natural walking FOV ──
  if (getProjection() !== "perspective") {
    try { setProjection("perspective"); } catch { /* */ }
  }
  // The projection switch may replace the camera object: always use the live one.
  const wcam = ctx.world.camera.three as THREE.PerspectiveCamera;
  wcam.fov = 65;
  wcam.near = 0.1;
  wcam.far = 1000;
  // Views like "Top" leave a non-vertical up vector; walking needs world-up.
  wcam.up.set(0, 1, 0);
  try { controls?.updateCameraUp?.(); } catch { /* */ }
  wcam.updateProjectionMatrix();
  if (controls) controls.enabled = false;

  // ── Orientation from the CURRENT camera view ──
  const viewDir = seenDir.clone();
  if (viewDir.lengthSq() < 1e-8) viewDir.set(0, 0, -1);
  else viewDir.normalize();
  state.pitch = THREE.MathUtils.clamp(
    Math.asin(THREE.MathUtils.clamp(viewDir.y, -1, 1)),
    -PITCH_LIMIT,
    PITCH_LIMIT,
  );
  state.yaw = yawFromDirection(viewDir.x, viewDir.z) ?? 0;
  state.speedFactor = 1;
  state.dragging = false;

  // ── Position: CURRENT camera point (do not teleport to a look-ray hit / active level) ──
  const startX = savedPos.x;
  const startZ = savedPos.z;
  const probeFrom = Math.max(savedPos.y + 0.5, savedPos.y);
  let floorY = raycastGround(startX, startZ, probeFrom);
  if (floorY == null) floorY = savedPos.y - EYE_HEIGHT;

  state.targetGroundY = floorY;
  state.airborne = false;
  const standingEye = floorY + EYE_HEIGHT;
  // Keep the camera's actual eye height when it is already near a valid standing pose.
  // With "hold my height" the walker always starts exactly where the camera is: on a floor if one is within a step of the feet,
  // otherwise on an imaginary level at that height (no drop to the lowest level).
  let eyeY = Math.abs(savedPos.y - standingEye) < 2.5 ? savedPos.y : standingEye;
  if (opts.holdLevel) {
    eyeY = savedPos.y;
    const feet0 = savedPos.y - EYE_HEIGHT;
    state.targetGroundY = floorY != null && Math.abs(floorY - feet0) <= MAX_STEP + 0.1 ? floorY : feet0;
    if (state.targetGroundY !== floorY) eyeY = state.targetGroundY + EYE_HEIGHT;
  }
  state.pos.set(startX, eyeY, startZ);
  state.vel.set(0, 0, 0);
  state.lift = 0;
  state.keys.clear();

  // ── Show HUD, lock pointer ──
  const ov = ensureOverlay();
  ov.style.display = "block";
  resetSensors();
  state.enabled = true;
  state.lastT = performance.now();
  state.raycastTick = 0;

  try { ov.requestPointerLock(); } catch (e) { console.warn("[walk] pointer lock failed", e); }
  try {
    notify(
      "info",
      "Walk mode (physics): walls block, stairs climb, openings drop. Esc exits and keeps this view.",
    );
  } catch { /* */ }

  syncHuman();
  refreshHint();
  state.rafId = requestAnimationFrame(tick);

  try { window.dispatchEvent(new CustomEvent("obs:walk-mode-changed", { detail: true })); } catch { /* */ }
}

export function disableWalkMode(): void {
  if (!state.enabled) return;
  state.enabled = false;
  resetSensors();
  syncHuman();

  if (state.rafId != null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  try {
    if (document.pointerLockElement) document.exitPointerLock();
  } catch { /* */ }

  // ── Keep the LAST walk camera (do not jump back to the pre-walk view) ──
  const saved = state.saved;
  const controls: any = ctx.world.camera.controls;
  const cam = ctx.world.camera.three as THREE.PerspectiveCamera;

  const look = new THREE.Vector3(
    -Math.sin(state.yaw) * Math.cos(state.pitch),
    Math.sin(state.pitch),
    -Math.cos(state.yaw) * Math.cos(state.pitch),
  );
  const endPos = state.pos.clone();
  const endTarget = endPos.clone().add(look.multiplyScalar(TARGET_DISTANCE));

  if (controls && typeof controls.setLookAt === "function") {
    try {
      controls.setLookAt(
        endPos.x, endPos.y, endPos.z,
        endTarget.x, endTarget.y, endTarget.z,
        false,
      );
    } catch { /* */ }
  } else {
    cam.position.copy(endPos);
    cam.lookAt(endTarget);
  }

  if (saved) {
    cam.fov = saved.fov;
    if (Number.isFinite(saved.near)) cam.near = saved.near as number;
    if (Number.isFinite(saved.far)) cam.far = saved.far as number;
    cam.updateProjectionMatrix();
    if (controls) controls.enabled = saved.controlsEnabled;
    try {
      const live = ctx.world.camera.three as THREE.Camera;
      live.up.copy(saved.up);
      (controls as any)?.updateCameraUp?.();
    } catch { /* */ }
    // Stay in perspective after walk for a natural hand-off; only restore ortho if requested.
    if (saved.projection !== "perspective") {
      try { setProjection(saved.projection); } catch { /* */ }
    }
  } else if (controls) {
    controls.enabled = true;
  }
  state.saved = null;
  state.keys.clear();
  state.dragging = false;

  if (overlay) overlay.style.display = "none";

  try { ctx.fragments.core.update(true); } catch { /* */ }

  try { window.dispatchEvent(new CustomEvent("obs:walk-mode-changed", { detail: false })); } catch { /* */ }
}

export function toggleWalkMode(): void {
  state.enabled ? disableWalkMode() : enableWalkMode();
}

/* ═════════════════════════════════════════════════════════════════════════
   Keyboard — exclusive over movement keys, transparent to modifier combos
   ═════════════════════════════════════════════════════════════════════════ */
function onKeyDown(e: KeyboardEvent) {
  if (!state.enabled) return;

  const t = e.target as HTMLElement | null;
  if (t) {
    const tag = t.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || t.isContentEditable) return;
  }

  // Synthetic key events (password managers, IMEs, extensions) can arrive with
  // key === undefined — never crash the global capture handler on them.
  const k = (e.key ?? "").toLowerCase();
  if (!k) return;

  // Modifier combos (Ctrl/Alt/Meta + another key) belong to the app.
  // Ctrl alone is captured below (crouch).
  if ((e.ctrlKey || e.metaKey || e.altKey) && k !== "control" && k !== "meta" && k !== "alt") {
    return;
  }

  if (k === "escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    disableWalkMode();
    return;
  }

  if (k === "pageup" || k === "pagedown") {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    try {
      const elevs = (getLevels() ?? []).map((l: any) => Number(l.elevation)).filter(Number.isFinite);
      const next = nextLevelElevation(elevs, state.targetGroundY, k === "pageup" ? 1 : -1);
      if (next != null) {
        state.targetGroundY = next;
        state.lift = 0;
        state.pos.y = next + EYE_HEIGHT;
        state.vel.y = 0;
      }
    } catch { /* */ }
    return;
  }

  if (OWNED_KEYS.has(k)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (k === "m") { if (!e.repeat) void toggleReferencePerson(); return; }
    if (k === "n" || k === "p" || k === "l" || k === "r") {
      const key = k === "n" ? "noClip" : k === "p" ? "human" : k === "r" ? "keepRaise" : "holdLevel";
      if (!e.repeat) setWalkOption(key, !opts[key]);
      return;
    }
    state.keys.add(k === " " ? "space" : k);
  }
}

function onWheel(e: WheelEvent) {
  if (!state.enabled) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  state.speedFactor = clampSpeedFactor(state.speedFactor * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}

function onKeyUp(e: KeyboardEvent) {
  // This handler is registered site-wide for the whole session (setupWalkMode),
  // so it must mirror onKeyDown's enabled check — and tolerate synthetic events
  // whose `key` is undefined (they crashed sign-in dialogs with a raw TypeError).
  if (!state.enabled) return;
  const k = (e.key ?? "").toLowerCase();
  if (!k) return;
  state.keys.delete(k === " " ? "space" : k);
}

function onPointerMove(e: MouseEvent) {
  if (!state.enabled) return;
  if (!document.pointerLockElement && !state.dragging) return;
  state.yaw -= e.movementX * LOOK_SENS;
  state.pitch -= e.movementY * LOOK_SENS;
  state.pitch = THREE.MathUtils.clamp(state.pitch, -PITCH_LIMIT, PITCH_LIMIT);
}

function onPointerLockChange() {
  if (!state.enabled) return;
  if (document.pointerLockElement !== overlay) disableWalkMode();
}

function onPointerLockError() {
  console.warn("[walk] pointer lock rejected — WASD still works, mouse-look disabled");
}


let driveWarned = false;
/** Place the camera for this frame. setLookAt + update(0) like the other navigation code, then verify
 *  the camera really moved and fall back to setting it directly if something overrode it. */
function driveCamera(pos: THREE.Vector3, target: THREE.Vector3): void {
  const controls: any = ctx.world.camera.controls;
  const three = ctx.world.camera.three as THREE.Camera;
  const live: THREE.Camera = controls?.camera?.isCamera ? controls.camera : three;
  let ok = false;
  if (controls && typeof controls.setLookAt === "function") {
    try {
      controls.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, false);
      controls.update?.(0);
      ok = true;
    } catch { /* fall through to the direct path */ }
  }
  if (!ok || live.position.distanceToSquared(pos) > 1e-3) {
    if (!driveWarned) { driveWarned = true; console.warn("[walk] camera controls did not take the position; driving the camera directly"); }
    live.position.copy(pos);
    live.lookAt(target);
    live.updateMatrixWorld(true);
    if (live !== three) {
      three.position.copy(pos);
      three.lookAt(target);
      three.updateMatrixWorld(true);
    }
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Main loop — drives the controls via setLookAt
   ═════════════════════════════════════════════════════════════════════════ */
function tick(now: number) {
  if (!state.enabled) return;
  try {
    tickBody(now);
  } catch (e) {
    // A single bad frame must never freeze walk mode.
    console.warn("[walk] frame error", e);
  }
  if (state.enabled) state.rafId = requestAnimationFrame(tick);
}

function tickBody(now: number) {
  const dt = Math.min((now - state.lastT) / 1000, 0.05);
  state.lastT = now;

  // ── Movement basis (yaw only) ──
  const forward = new THREE.Vector3(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
  const right = new THREE.Vector3(Math.cos(state.yaw), 0, -Math.sin(state.yaw));

  const input = new THREE.Vector3();
  if (state.keys.has("w") || state.keys.has("arrowup")) input.add(forward);
  if (state.keys.has("s") || state.keys.has("arrowdown")) input.sub(forward);
  if (state.keys.has("d") || state.keys.has("arrowright")) input.add(right);
  if (state.keys.has("a") || state.keys.has("arrowleft")) input.sub(right);
  if (input.lengthSq() > 0) input.normalize();

  const running = state.keys.has("shift");
  const crouching = state.keys.has("control");
  const speed = (crouching ? CROUCH_SPEED : running ? RUN_SPEED : WALK_SPEED) * state.speedFactor;
  const targetVel = input.multiplyScalar(speed);

  const alpha = 1 - Math.exp(-ACCEL * dt);
  state.vel.lerp(targetVel, alpha);

  if (!opts.noClip) fireSensors(targetVel.x / (speed || 1), targetVel.z / (speed || 1), speed);
  state.collideTick = (state.collideTick + 1) % COLLIDE_INTERVAL;
  if (state.collideTick === 0 && !opts.noClip) applyCollision(dt);

  state.pos.x += state.vel.x * dt;
  state.pos.z += state.vel.z * dt;
  if (!opts.noClip) applyWallContacts(); // resolve this frame's step too, so the drawn pose never dips into the wall
  if (!Number.isFinite(state.pos.x) || !Number.isFinite(state.pos.y) || !Number.isFinite(state.pos.z)) {
    // never hand NaN to the camera: recover to the position walk mode started from
    const sv = state.saved?.position;
    state.pos.set(sv?.x ?? 0, (sv?.y ?? EYE_HEIGHT), sv?.z ?? 0);
    state.vel.set(0, 0, 0);
    if (!Number.isFinite(state.targetGroundY)) state.targetGroundY = 0;
  }

  // Space / C. With "keep raised height" the change is stored as a lift above the floor, so the new height stays fixed
  // when the key is released (and follows stairs); without it the old behaviour applies (free nudge, then gravity).
  let manualVertical = false;
  if (opts.keepRaise) {
    if (state.keys.has("space")) state.lift = raiseWithCeiling(state.lift, 2.4 * dt, ceilingDistance());
    if (state.keys.has("c")) state.lift = Math.max(0, state.lift - 2.4 * dt);
  } else {
    manualVertical = state.keys.has("space") || state.keys.has("c");
    if (state.keys.has("space")) {
      state.pos.y += raiseWithCeiling(0, 2.4 * dt, ceilingDistance());
      state.vel.y = Math.max(state.vel.y, 0);
      state.airborne = true;
    }
    if (state.keys.has("c")) {
      state.pos.y -= 2.4 * dt;
      state.vel.y = Math.min(state.vel.y, 0);
    }
    state.lift = 0;
  }

  state.raycastTick = (state.raycastTick + 1) % RAYCAST_INTERVAL;
  if (state.raycastTick === 0) updateGroundTarget();

  const eyeH = crouching ? CROUCH_HEIGHT : EYE_HEIGHT;
  const targetY = state.targetGroundY + eyeH + (opts.keepRaise ? state.lift : 0);

  if (manualVertical) {
    // free vertical nudge
  } else if (state.airborne) {
    state.vel.y += GRAVITY * dt;
    if (state.vel.y < TERMINAL_V) state.vel.y = TERMINAL_V;
    state.pos.y += state.vel.y * dt;
    if (state.pos.y <= targetY + LANDING_SNAP) {
      state.pos.y = targetY;
      state.vel.y = 0;
      state.airborne = false;
    }
  } else {
    state.vel.y = 0;
    state.pos.y += (targetY - state.pos.y) * Math.min(1, GROUND_SMOOTH * dt);
    if (opts.keepRaise && state.lift > 0) state.airborne = false; // a raised walker hovers: it does not fall back
    if (state.pos.y - targetY > FALL_TRIGGER) state.airborne = true;
  }

  state.hudTick = (state.hudTick + 1) % 8;
  if (state.hudTick === 0) updateStatus();

  // ── Camera look direction from yaw/pitch ──
  const look = new THREE.Vector3(
    -Math.sin(state.yaw) * Math.cos(state.pitch),
    Math.sin(state.pitch),
    -Math.cos(state.yaw) * Math.cos(state.pitch),
  );
  const target = state.pos.clone().add(look.clone().multiplyScalar(TARGET_DISTANCE));

  if (opts.human) {
    // Third person: the figure stands at the walker's feet and the camera follows 2.6 m behind and a little above.
    if (!human) syncHuman();
    const feet = state.pos.y - eyeH;
    if (human) {
      human.position.set(state.pos.x, feet, state.pos.z);
      human.rotation.y = state.yaw + Math.PI; // the figure's front (+Z) faces the walking direction (-Z at yaw 0)
      human.scale.y = eyeH / EYE_HEIGHT;
      human.updateMatrixWorld(true);
    }
    const back = new THREE.Vector3(
      Math.sin(state.yaw) * Math.cos(state.pitch) * CHASE_DISTANCE,
      0.35 - Math.sin(state.pitch) * CHASE_DISTANCE,
      Math.cos(state.yaw) * Math.cos(state.pitch) * CHASE_DISTANCE,
    );
    const want = back.length();
    const dirBack = back.clone().divideScalar(want || 1);
    // Keep the camera out of walls: nearest obstacle on the line from the head back to the camera.
    let hit: number | null = opts.noClip ? null : chaseModelHit;
    if (!opts.noClip) {
      const models = getCollisionTargets();
      if (models.length) {
        groundRay.set(state.pos.clone(), dirBack);
        groundRay.far = want;
        const passable = passableIds();
        for (const h of safeIntersect(groundRay, models)) {
          if (!h.object.visible) continue;
          const hid = hitElementId(h.object);
          if (hid && passable.has(hid)) continue;
          if (hit === null || h.distance < hit) hit = h.distance;
          break;
        }
      }
      if (!chaseBusy) {
        chaseBusy = true;
        void modelRay(state.pos.x, state.pos.y, state.pos.z, dirBack.x, dirBack.y, dirBack.z, want)
          .then((r) => { chaseModelHit = r ? r.distance : null; })
          .catch(() => { chaseModelHit = null; })
          .finally(() => { chaseBusy = false; });
      }
    }
    chaseDist = chaseDistance(want, hit, chaseDist > want ? want : chaseDist, dt);
    const chase = state.pos.clone().addScaledVector(dirBack, chaseDist);
    driveCamera(chase, state.pos.clone().add(new THREE.Vector3(0, -0.1, 0)));
  } else {
    driveCamera(state.pos, target);
  }

  // Keep Fragments in sync with the new camera.
  try { ctx.fragments.core.update(false); } catch { /* */ }
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup
   ═════════════════════════════════════════════════════════════════════════ */
export function setupWalkMode(): void {
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  // Never leave a movement key "stuck" if the window loses focus mid-walk.
  window.addEventListener("blur", () => state.keys.clear());
  window.addEventListener("mousemove", onPointerMove);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  document.addEventListener("pointerlockchange", onPointerLockChange);
  document.addEventListener("pointerlockerror", onPointerLockError);

  ctx.features.walkMode = {
    isEnabled: isWalkModeEnabled,
    getPose: getWalkPose,
    enable: enableWalkMode,
    disable: disableWalkMode,
    toggle: toggleWalkMode,
    toggleReference: toggleReferencePerson,
    isReferenceShown: isReferencePersonShown,
    getOptions: getWalkOptions,
    setOption: setWalkOption,
  };
}
/** Slide the camera (and its target) horizontally before walk mode starts. */
function nudgeStartPosition(keyCode: string, dt: number): void {
  try {
    const cam = ctx.world.camera.three as THREE.Camera;
    const controls: any = ctx.world.camera.controls;
    if (!controls?.setLookAt) return;
    const forward = new THREE.Vector3();
    cam.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const step = 3 * dt;
    const off = new THREE.Vector3();
    if (keyCode === "KeyW") off.addScaledVector(forward, step);
    else if (keyCode === "KeyS") off.addScaledVector(forward, -step);
    else if (keyCode === "KeyD") off.addScaledVector(right, step);
    else if (keyCode === "KeyA") off.addScaledVector(right, -step);
    else return;
    const t = new THREE.Vector3();
    if (readControlsTarget(controls, t)) { /* real controls target */ }
    else t.copy(cam.position).add(forward.clone().multiplyScalar(TARGET_DISTANCE));
    const p = cam.position.clone().add(off);
    t.add(off);
    controls.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
  } catch { /* adjustment is best-effort */ }
}

// ── ADDED: Pre-Walk Adjustment Mode UI ──
export function showWalkAdjustmentUI(onStartWalk: () => void) {
  if (document.getElementById("walk-adjust-ui")) return;

  const ui = document.createElement("div");
  ui.id = "walk-adjust-ui";
  // Sit directly under the ViewCube (top-right of the 3D viewport).
  // ViewCube: absolute top:14px;right:14px — card ≈ header + 140px SVG + padding.
  ui.style.position = "absolute";
  ui.style.top = "210px";
  ui.style.right = "14px";
  ui.style.left = "auto";
  ui.style.bottom = "auto";
  ui.style.transform = "none";
  ui.style.background = "rgba(20, 25, 30, 0.95)";
  ui.style.border = "1px solid #00A3E0";
  ui.style.borderRadius = "8px";
  ui.style.padding = "12px 14px";
  ui.style.display = "flex";
  ui.style.flexDirection = "column";
  ui.style.alignItems = "center";
  ui.style.gap = "10px";
  ui.style.zIndex = "45"; // above viewcube (40), below modals
  ui.style.boxShadow = "0 10px 30px rgba(0,0,0,0.5)";
  ui.style.pointerEvents = "auto";
  ui.style.maxWidth = "min(220px, calc(100% - 28px))";

  const title = document.createElement("div");
  title.textContent = "WALK START";
  title.style.color = "#00A3E0";
  title.style.fontWeight = "bold";
  title.style.fontFamily = "sans-serif";
  title.style.letterSpacing = "1px";
  ui.appendChild(title);

  const dpad = document.createElement("div");
  dpad.style.display = "grid";
  dpad.style.gridTemplateColumns = "repeat(3, 40px)";
  dpad.style.gridTemplateRows = "repeat(3, 40px)";
  dpad.style.gap = "4px";

  const createBtn = (label: string, gridArea: string, keyCode: string) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.gridArea = gridArea;
    btn.style.background = "rgba(255,255,255,0.1)";
    btn.style.color = "white";
    btn.style.border = "1px solid #555";
    btn.style.borderRadius = "4px";
    btn.style.cursor = "pointer";
    btn.style.fontSize = "18px";
    
    // Walk mode is not running yet, so synthetic key events were ignored and
    // the pad did nothing. Move the camera directly while the button is held.
    let raf: number | null = null;
    let last = 0;
    const stop = () => { if (raf != null) cancelAnimationFrame(raf); raf = null; };
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      nudgeStartPosition(keyCode, dt);
      raf = requestAnimationFrame(loop);
    };

    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      stop();
      last = performance.now();
      raf = requestAnimationFrame(loop);
    });
    btn.addEventListener("pointerup", (e) => { e.preventDefault(); stop(); });
    btn.addEventListener("pointerleave", stop);
    btn.addEventListener("pointercancel", stop);
    return btn;
  };

  dpad.appendChild(createBtn("▲", "1 / 2", "KeyW"));
  dpad.appendChild(createBtn("◀", "2 / 1", "KeyA"));
  dpad.appendChild(createBtn("▼", "2 / 2", "KeyS"));
  dpad.appendChild(createBtn("▶", "2 / 3", "KeyD"));
  ui.appendChild(dpad);

  const startBtn = document.createElement("button");
  startBtn.textContent = "START WALK";
  startBtn.style.padding = "10px 24px";
  startBtn.style.background = "#00A3E0";
  startBtn.style.color = "white";
  startBtn.style.border = "none";
  startBtn.style.borderRadius = "4px";
  startBtn.style.fontWeight = "bold";
  startBtn.style.cursor = "pointer";
  startBtn.style.fontFamily = "sans-serif";
  
  startBtn.onclick = () => {
    ui.remove();
    onStartWalk();
  };
  
  ui.appendChild(startBtn);
  try {
    const host = (ctx as any).rightHost as HTMLElement | undefined;
    if (host) {
      // Keep the panel in the 3D viewport stack (same parent as ViewCube).
      if (getComputedStyle(host).position === "static") {
        host.style.position = "relative";
      }
      host.appendChild(ui);
    } else {
      document.body.appendChild(ui);
    }
  } catch {
    document.body.appendChild(ui);
  }
}


// ── WRAPPER: Force the Adjustment UI before starting the walk ──
export function startWalkMode() {
  showWalkAdjustmentUI(enableWalkMode);
}