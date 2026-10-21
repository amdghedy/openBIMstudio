/**
 * Walk mode — first-person navigation.
 *
 * Controls:
 *   W A S D     — move
 *   Mouse       — look (pointer lock)
 *   Shift       — run
 *   Ctrl        — crouch
 *   Space       — raise
 *   C           — lower
 *   Esc         — exit
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
import * as THREE from "three";
import { ctx } from "../core/context";
import { getLevel } from "./authoring";
import { getProjection, setProjection } from "./camera-tools";

// ── Tuning ──
const EYE_HEIGHT = 1.7;
const CROUCH_HEIGHT = 1.1;
const WALK_SPEED = 3.2;
const RUN_SPEED = 9.0;
const CROUCH_SPEED = 1.4;
const ACCEL = 12.0;
const LOOK_SENS = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.08;
const RAYCAST_INTERVAL = 6;      // frames between ground raycasts
const GROUND_SMOOTH = 12.0;      // Y-follow smoothing
const TARGET_DISTANCE = 5.0;     // metres in front of the eye for the controls target
const GROUND_RAY_LENGTH = 500;   // how far down to look for the ground

interface SavedCamState {
  projection: "perspective" | "orthographic";
  controlsEnabled: boolean;
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
  near?: number;
  far?: number;
}

interface WalkState {
  enabled: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  pitch: number;
  keys: Set<string>;
  targetGroundY: number;
  raycastTick: number;
  rafId: number | null;
  lastT: number;
  saved: SavedCamState | null;
}

const state: WalkState = {
  enabled: false,
  pos: new THREE.Vector3(),
  vel: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  keys: new Set(),
  targetGroundY: 0,
  raycastTick: 0,
  rafId: null,
  lastT: 0,
  saved: null,
};

/** Keys walk mode owns exclusively — captured before the shortcut registry. */
const OWNED_KEYS = new Set([
  "w", "a", "s", "d",
  "arrowup", "arrowdown", "arrowleft", "arrowright",
  "shift", "control",
  " ", "c",
]);

const groundRay = new THREE.Raycaster();

// ── HUD ──
let overlay: HTMLDivElement | null = null;
let crosshair: HTMLDivElement | null = null;
let hint: HTMLDivElement | null = null;
let exitBtn: HTMLButtonElement | null = null;

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

  overlay.append(crosshair, hint, exitBtn);
  ctx.rightHost.appendChild(overlay);
  return overlay;
}

/* ═════════════════════════════════════════════════════════════════════════
   Ground raycast — find the surface below a given (x, z)
   ═════════════════════════════════════════════════════════════════════════ */
function getWalkTargets(): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  try {
    for (const [, model] of ctx.fragments.list) {
      if (model?.object) out.push(model.object);
    }
  } catch { /* */ }
  if (ctx.groundPlane) out.push(ctx.groundPlane);
  return out;
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

function updateGroundTarget() {
  const found = raycastGround(state.pos.x, state.pos.z, state.pos.y + 0.6);
  if (found != null) {
    state.targetGroundY = found;
    return;
  }
  // No surface — keep the last known ground; if we never had one, use level.
  if (!Number.isFinite(state.targetGroundY)) {
    state.targetGroundY = (() => { try { return getLevel(); } catch { return 0; } })();
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Public API
   ═════════════════════════════════════════════════════════════════════════ */
export function isWalkModeEnabled(): boolean {
  return state.enabled;
}

export function enableWalkMode(): void {
  if (state.enabled) return;

  const cam = ctx.world.camera.three as THREE.PerspectiveCamera;
  const controls: any = ctx.world.camera.controls;

  // ── Save camera + controls state ──
  const savedPos = cam.position.clone();
  let savedTarget = new THREE.Vector3();
  if (controls?.target?.isVector3) {
    savedTarget.copy(controls.target);
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
  };

  // ── Force perspective for a natural walking FOV ──
  if (getProjection() !== "perspective") {
    try { setProjection("perspective"); } catch { /* */ }
  }
  cam.fov = 65;
  cam.near = 0.1;
  cam.far = 1000;
  cam.updateProjectionMatrix();

  // ── Derive initial yaw / pitch from the current view direction ──
  const viewDir = savedTarget.clone().sub(savedPos).normalize();
  state.pitch = Math.asin(THREE.MathUtils.clamp(viewDir.y, -1, 1));
  // Same basis as the look vector in tick(): (-sin yaw, ., -cos yaw).
  // (A stray "- PI/2" here used to turn the view 90 degrees on entry.)
  state.yaw = Math.atan2(-viewDir.x, -viewDir.z);

  // ── Position: keep the current XZ, snap Y to the ground under us ──
  state.pos.set(savedPos.x, savedPos.y, savedPos.z);
  const levelFallback = savedPos.y - EYE_HEIGHT;
  const groundHit = raycastGround(savedPos.x, savedPos.z, savedPos.y + 2);
  state.targetGroundY = groundHit ?? levelFallback;
  state.pos.y = state.targetGroundY + EYE_HEIGHT;
  state.vel.set(0, 0, 0);
  state.keys.clear();

  // ── Show HUD, lock pointer ──
  const ov = ensureOverlay();
  ov.style.display = "block";
  state.enabled = true;
  state.lastT = performance.now();
  state.raycastTick = 0;

  try { ov.requestPointerLock(); } catch (e) { console.warn("[walk] pointer lock failed", e); }

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

  // ── Restore camera + controls via setLookAt so the controls accept the value ──
  const saved = state.saved;
  const controls: any = ctx.world.camera.controls;
  const cam = ctx.world.camera.three as THREE.PerspectiveCamera;
  if (saved) {
    if (controls && typeof controls.setLookAt === "function") {
      try {
        controls.setLookAt(
          saved.position.x, saved.position.y, saved.position.z,
          saved.target.x, saved.target.y, saved.target.z,
          false,
        );
      } catch { /* */ }
    } else {
      // Fallback: set camera directly and hope the controls tolerate it.
      cam.position.copy(saved.position);
      cam.lookAt(saved.target);
    }
    cam.fov = saved.fov;
    // Walk mode tightened the clip planes; put them back.
    if (Number.isFinite(saved.near)) cam.near = saved.near as number;
    if (Number.isFinite(saved.far)) cam.far = saved.far as number;
    cam.updateProjectionMatrix();
    if (controls) controls.enabled = saved.controlsEnabled;
    if (saved.projection !== "perspective") {
      try { setProjection(saved.projection); } catch { /* */ }
    }
  }
  state.saved = null;
  state.keys.clear();

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

  const k = e.key.toLowerCase();

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

  if (OWNED_KEYS.has(k)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    state.keys.add(k === " " ? "space" : k);
  }
}

function onKeyUp(e: KeyboardEvent) {
  const k = e.key.toLowerCase();
  state.keys.delete(k === " " ? "space" : k);
}

function onPointerMove(e: MouseEvent) {
  if (!state.enabled) return;
  if (!document.pointerLockElement) return;
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

/* ═════════════════════════════════════════════════════════════════════════
   Main loop — drives the controls via setLookAt
   ═════════════════════════════════════════════════════════════════════════ */
function tick(now: number) {
  if (!state.enabled) return;
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
  const speed = crouching ? CROUCH_SPEED : running ? RUN_SPEED : WALK_SPEED;
  const targetVel = input.multiplyScalar(speed);

  const alpha = 1 - Math.exp(-ACCEL * dt);
  state.vel.lerp(targetVel, alpha);

  state.pos.x += state.vel.x * dt;
  state.pos.z += state.vel.z * dt;

  // Manual vertical (Space / C) overrides ground-follow this frame.
  const manualVertical = state.keys.has("space") || state.keys.has("c");
  if (state.keys.has("space")) state.pos.y += 2.4 * dt;
  if (state.keys.has("c")) state.pos.y -= 2.4 * dt;

  // Ground-follow raycast every N frames.
  state.raycastTick = (state.raycastTick + 1) % RAYCAST_INTERVAL;
  if (state.raycastTick === 0) updateGroundTarget();

  const eyeH = crouching ? CROUCH_HEIGHT : EYE_HEIGHT;
  if (!manualVertical) {
    const targetY = state.targetGroundY + eyeH;
    state.pos.y += (targetY - state.pos.y) * Math.min(1, GROUND_SMOOTH * dt);
  }

  // ── Camera look direction from yaw/pitch ──
  const look = new THREE.Vector3(
    -Math.sin(state.yaw) * Math.cos(state.pitch),
    Math.sin(state.pitch),
    -Math.cos(state.yaw) * Math.cos(state.pitch),
  );
  const target = state.pos.clone().add(look.clone().multiplyScalar(TARGET_DISTANCE));

  // ── Drive the controls — this is what makes the camera actually move ──
  const controls: any = ctx.world.camera.controls;
  const cam = ctx.world.camera.three as THREE.PerspectiveCamera;

  if (controls && typeof controls.setLookAt === "function") {
    try {
      controls.setLookAt(
        state.pos.x, state.pos.y, state.pos.z,
        target.x, target.y, target.z,
        false,   // no transition — apply immediately
      );
    } catch (e) {
      // If the controls reject, fall through and set the camera manually.
      cam.position.copy(state.pos);
      cam.lookAt(target);
    }
  } else {
    cam.position.copy(state.pos);
    cam.lookAt(target);
  }

  // Keep Fragments in sync with the new camera.
  try { ctx.fragments.core.update(false); } catch { /* */ }

  state.rafId = requestAnimationFrame(tick);
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
  document.addEventListener("pointerlockchange", onPointerLockChange);
  document.addEventListener("pointerlockerror", onPointerLockError);

  ctx.features.walkMode = {
    isEnabled: isWalkModeEnabled,
    enable: enableWalkMode,
    disable: disableWalkMode,
    toggle: toggleWalkMode,
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
    if (controls.target?.isVector3) t.copy(controls.target);
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
  ui.style.position = "fixed";
  ui.style.bottom = "30px";
  ui.style.left = "50%";
  ui.style.transform = "translateX(-50%)";
  ui.style.background = "rgba(20, 25, 30, 0.95)";
  ui.style.border = "1px solid #00A3E0";
  ui.style.borderRadius = "8px";
  ui.style.padding = "20px";
  ui.style.display = "flex";
  ui.style.flexDirection = "column";
  ui.style.alignItems = "center";
  ui.style.gap = "15px";
  ui.style.zIndex = "999999";
  ui.style.boxShadow = "0 10px 30px rgba(0,0,0,0.5)";

  const title = document.createElement("div");
  title.textContent = "ADJUST STARTING POSITION";
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
  document.body.appendChild(ui);
}


// ── WRAPPER: Force the Adjustment UI before starting the walk ──
export function startWalkMode() {
  showWalkAdjustmentUI(enableWalkMode);
}