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
import { clampSpeedFactor, isBlockingHit, nextLevelElevation, slideVelocity, yawFromDirection } from "./walk-physics";
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
};

/** Keys walk mode owns exclusively — captured before the shortcut registry. */
const OWNED_KEYS = new Set([
  "w", "a", "s", "d",
  "arrowup", "arrowdown", "arrowleft", "arrowright",
  "shift", "control",
  " ", "c", "pageup", "pagedown",
]);

const groundRay = new THREE.Raycaster();

// ── HUD ──
let overlay: HTMLDivElement | null = null;
let crosshair: HTMLDivElement | null = null;
let hint: HTMLDivElement | null = null;
let exitBtn: HTMLButtonElement | null = null;
let statusEl: HTMLDivElement | null = null;

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
    "color:#e8eaf0;white-space:nowrap;backdrop-filter:blur(6px);" +
    "box-shadow:0 6px 20px rgba(0,0,0,.4)";
  const kbd = (t: string) =>
    `<kbd style="padding:1px 5px;border:1px solid #3d4250;border-radius:3px;font:10px monospace">${t}</kbd>`;
  hint.innerHTML =
    `<b style="color:#38bdf8">WALK</b> · ` +
    `${kbd("W")}${kbd("A")}${kbd("S")}${kbd("D")} move · ` +
    `${kbd("Shift")} run · ${kbd("Ctrl")} crouch · ` +
    `${kbd("Space")}/${kbd("C")} up/down · ` +
    `${kbd("PgUp")}/${kbd("PgDn")} level · wheel speed · ` +
    `${kbd("Esc")} exit · ` +
    `<span style="opacity:.65">Ctrl+S / Ctrl+Z still work</span>`;

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
  if (!targets.length) return null;
  try {
    const hits = groundRay.intersectObjects(targets, true);
    for (const h of hits) {
      if (h.point.y < fromY - 0.02) return h.point.y;
    }
  } catch { /* */ }
  return null;
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
    state.airborne = true;
    return;
  }

  const drop = feetY - found; // positive = floor is below feet

  if (drop < -MAX_STEP) {
    // Floor is higher than we can step — treat as a wall, keep current ground.
    return;
  }

  if (drop > FALL_TRIGGER) {
    // Opening / missing slab / deep stair run: fall to the lower floor.
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

/** Block / slide the horizontal motion against walls. Returns true when blocked this frame. */
function applyCollision(dt: number): void {
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
    try { hits = groundRay.intersectObjects(models, true); } catch { /* */ }
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
    (state.airborne ? "   FALLING" : "   GROUNDED") +
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
  const viewDir = savedTarget.clone().sub(savedPos);
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
  const eyeY = Math.abs(savedPos.y - standingEye) < 2.5 ? savedPos.y : standingEye;
  state.pos.set(startX, eyeY, startZ);
  state.vel.set(0, 0, 0);
  state.keys.clear();

  // ── Show HUD, lock pointer ──
  const ov = ensureOverlay();
  ov.style.display = "block";
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

  state.rafId = requestAnimationFrame(tick);

  try { window.dispatchEvent(new CustomEvent("obs:walk-mode-changed", { detail: true })); } catch { /* */ }
}

export function disableWalkMode(): void {
  if (!state.enabled) return;
  state.enabled = false;

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
        state.pos.y = next + EYE_HEIGHT;
        state.vel.y = 0;
      }
    } catch { /* */ }
    return;
  }

  if (OWNED_KEYS.has(k)) {
    e.preventDefault();
    e.stopImmediatePropagation();
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

  state.collideTick = (state.collideTick + 1) % COLLIDE_INTERVAL;
  if (state.collideTick === 0) applyCollision(dt);

  state.pos.x += state.vel.x * dt;
  state.pos.z += state.vel.z * dt;
  if (!Number.isFinite(state.pos.x) || !Number.isFinite(state.pos.y) || !Number.isFinite(state.pos.z)) {
    // never hand NaN to the camera: recover to the position walk mode started from
    const sv = state.saved?.position;
    state.pos.set(sv?.x ?? 0, (sv?.y ?? EYE_HEIGHT), sv?.z ?? 0);
    state.vel.set(0, 0, 0);
    if (!Number.isFinite(state.targetGroundY)) state.targetGroundY = 0;
  }

  // Manual vertical (Space / C) overrides gravity / ground-follow this frame.
  const manualVertical = state.keys.has("space") || state.keys.has("c");
  if (state.keys.has("space")) {
    state.pos.y += 2.4 * dt;
    state.vel.y = Math.max(state.vel.y, 0);
    state.airborne = true;
  }
  if (state.keys.has("c")) {
    state.pos.y -= 2.4 * dt;
    state.vel.y = Math.min(state.vel.y, 0);
  }

  state.raycastTick = (state.raycastTick + 1) % RAYCAST_INTERVAL;
  if (state.raycastTick === 0) updateGroundTarget();

  const eyeH = crouching ? CROUCH_HEIGHT : EYE_HEIGHT;
  const targetY = state.targetGroundY + eyeH;

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

  driveCamera(state.pos, target);

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
    /** Diagnostic: what a collision ray from (x,y,z) along (dx,dy,dz) hits, using exactly the walker's targets. */
    probe: (x: number, y: number, z: number, dx: number, dy: number, dz: number) => {
      const targets = getCollisionTargets();
      groundRay.set(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz).normalize());
      groundRay.far = 50;
      let n = 0, first: number | null = null, kinds: string[] = [];
      try { const hits = groundRay.intersectObjects(targets, true); n = hits.length; first = hits[0]?.distance ?? null; kinds = hits.slice(0, 3).map((h) => h.object.type + (h.face ? "+face" : "")); } catch (e) { kinds = [String(e)]; }
      const per: Array<{ type: string; name: string; ok: boolean; err?: string; geo?: string; inst?: number; raycastSrc?: string }> = [];
      for (const t of targets) t.traverse((o: any) => {
        if (!o.isMesh && !o.isLine && !o.isPoints) return;
        if (per.length >= 12) return;
        const rc = new THREE.Raycaster(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz).normalize(), 0, 50);
        try { rc.intersectObject(o, false); per.push({ type: o.type, name: o.name, ok: true, geo: o.geometry?.type + ":" + (o.geometry?.index ? "idx" : "noidx") + ":" + (o.geometry?.attributes?.position?.count ?? "?"), inst: o.count }); }
        catch (e) { per.push({ type: o.type, name: o.name, ok: false, err: String(e).slice(0, 80), geo: o.geometry?.type + ":" + (o.geometry?.index ? "idx" : "noidx") + ":" + (o.geometry?.attributes?.position?.count ?? "?"), inst: o.count, raycastSrc: String(o.raycast).slice(0, 160) }); }
      });
      return { targets: targets.length, hits: n, first, kinds, per };
    },
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