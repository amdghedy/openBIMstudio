/**
 * NavigationController — the single coordinator for ViewCube navigation,
 * Home commands, projection modes and orientation customization.
 *
 * Architecture rules honored here:
 *  - The controller NEVER touches the DOM or the viewer directly; all viewer
 *    access flows through the CameraAdapter (production adapter wraps
 *    ctx.world.camera + camera-tools, so camera-controls stays the one owner
 *    of orbit/pan/zoom — no second controller is introduced).
 *  - Exactly one transition may be active. A new command replaces it; a user
 *    gesture cancels it. Rapid repeated commands are safe.
 *  - All orientation decisions come from the derived orientation mapping.
 *
 * DOM-free and unit-testable: tests drive advance() through tick().
 */
import * as THREE from "three";
import type {
  CameraAdapter,
  CubeCorner,
  CubeEdge,
  CubeFace,
  HomeViewState,
  KeyValueStore,
  NavigationConfig,
  OrientationMapping,
  ProjectionMode,
  ViewSpec,
} from "./types";
import { DEFAULT_NAVIGATION_CONFIG } from "./types";
import {
  cloneMapping,
  deriveOrientation,
  isValidMapping,
  makeSpec,
  nearestOrientation,
  orientationLabel,
  pitchSpec,
  spinSpec,
  specForTarget,
} from "./orientation";
import { CameraTransition, endpointFrom, quaternionForSpec } from "./transitions";
import { defaultHomePlacement, frameBox } from "./framing";
import {
  clearHome,
  defaultOrientation,
  homeStorageKey,
  loadHome,
  loadOrientationMapping,
  orientationStorageKey,
  saveHome,
  saveOrientationMapping,
} from "./home-state";

export interface NavigationEvents {
  /** User-facing feedback (wired to core/notify in the feature layer). */
  onToast?(kind: "info" | "success" | "warn" | "error", message: string): void;
  /** Any state affecting the widget UI (mapping, mode, home, transition). */
  onStateChange?(): void;
}

export interface ControllerOptions {
  config?: Partial<NavigationConfig>;
  storage?: KeyValueStore | null;
  projectId?: string | null;
  events?: NavigationEvents;
}

export interface CommandOutcome {
  ok: boolean;
  /** Machine-readable reason for UI/testing. */
  reason?: "no-model" | "invalid-state" | "rejected-by-camera" | "degenerate-orientation" | "at-pole";
}

const EPS = 1e-9;

export class NavigationController {
  readonly config: NavigationConfig;
  private adapter: CameraAdapter;
  private storage: KeyValueStore | null;
  private projectId: string | null;
  private events: NavigationEvents;

  private mapping: OrientationMapping;
  private mode: ProjectionMode = "perspective";
  private transition: CameraTransition | null = null;
  private stopGesture: (() => void) | null = null;
  /** Snapshot of the last captured home (in-memory fast path for goHome). */
  private home: HomeViewState | null = null;

  constructor(adapter: CameraAdapter, opts: ControllerOptions = {}) {
    this.adapter = adapter;
    this.config = { ...DEFAULT_NAVIGATION_CONFIG, ...(opts.config ?? {}) };
    this.storage = opts.storage ?? null;
    this.projectId = opts.projectId ?? null;
    this.events = opts.events ?? {};

    this.mapping = this.loadMapping();
    this.mode = this.projectionModeFromAdapter();
    this.home = this.loadHomeState();

    this.stopGesture = this.adapter.onUserGesture(() => {
      if (this.transition) {
        this.transition.cancel();
        this.transition = null;
        this.events.onStateChange?.();
      }
    });
  }

  /** Detach from the adapter (widget disposal). */
  dispose(): void {
    this.cancelTransition();
    try { this.stopGesture?.(); } catch { /* */ }
    this.stopGesture = null;
  }

  /**
   * Re-key persistence when the active project changes: reloads the
   * per-project Home state and orientation mapping.
   */
  setProjectId(id: string | null): void {
    if (id === this.projectId) return;
    this.projectId = id;
    this.mapping = this.loadMapping();
    this.home = this.loadHomeState();
    this.events.onStateChange?.();
  }

  /* ── Inspection ─────────────────────────────────────────────────────── */

  projectionMode(): ProjectionMode {
    return this.mode;
  }

  private projectionModeFromAdapter(): ProjectionMode {
    const p = this.adapter.projection();
    if (this.mode === "perspective-ortho-faces" && p === "orthographic") {
      // A face snap has switched the core camera to ortho; the navigation
      // mode is still PwOF until the user orbits freely.
      return "perspective-ortho-faces";
    }
    return p;
  }

  orientationMapping(): OrientationMapping {
    return cloneMapping(this.mapping);
  }

  /** Nearest cube target to the live view — the orientation indicator. */
  currentOrientation(): { kind: string; id: string; label: string; angleDeg: number } {
    const dir = this.adapter.position().sub(this.adapter.target());
    const d = deriveOrientation(this.mapping);
    const hit = nearestOrientation(dir, d);
    if (!hit) return { kind: "face", id: "front", label: "Front", angleDeg: 0 };
    return { kind: hit.kind, id: hit.id, label: hit.label, angleDeg: THREE.MathUtils.radToDeg(hit.angle) };
  }

  hasHome(): boolean {
    return this.home != null;
  }

  isTransitioning(): boolean {
    return this.transition != null && !this.transition.isFinished();
  }

  /* ── Transition engine ──────────────────────────────────────────────── */

  /**
   * Advance the active transition by dtMs and apply the sample through the
   * adapter. Returns true while a transition remains active.
   */
  tick(dtMs: number): boolean {
    const tr = this.transition;
    if (!tr) return false;
    if (tr.isCancelled()) {
      this.transition = null;
      this.events.onStateChange?.();
      return false;
    }
    const sample = tr.advance(dtMs);
    if (sample.done) {
      this.transition = null;
      this.events.onStateChange?.();
    }
    this.adapter.lookAt(sample.pos, sample.target, sample.up, false);
    return this.transition != null;
  }

  cancelTransition(): void {
    if (this.transition) {
      this.transition.cancel();
      this.transition = null;
      this.events.onStateChange?.();
    }
  }

  private endpointNow() {
    return endpointFrom(this.adapter.position(), this.adapter.target(), this.adapter.up());
  }

  /** Start (or replace) a transition toward a view spec. */
  private startSpecTransition(
    spec: ViewSpec,
    target: THREE.Vector3,
    dist: number,
    durationMs = this.config.transitionMs,
  ): void {
    this.transition = CameraTransition.fromSpec(
      this.endpointNow(), spec, target.clone(), Math.max(dist, this.config.minDistance), durationMs,
    );
    this.events.onStateChange?.();
    // Apply the first frame immediately so repeated commands never show a
    // stale camera between ticks.
    this.tick(0);
  }

  private startEndpointTransition(
    pos: THREE.Vector3,
    target: THREE.Vector3,
    up: THREE.Vector3,
    durationMs = this.config.transitionMs,
  ): void {
    const to = endpointFrom(pos, target, up);
    this.transition = new CameraTransition(this.endpointNow(), to, durationMs);
    this.events.onStateChange?.();
    this.tick(0);
  }

  /* ── Projection modes ───────────────────────────────────────────────── */

  /**
   * Switch the navigation projection mode.
   * - perspective / orthographic: genuine core projection switches.
   * - perspective-ortho-faces: perspective free orbit + orthographic face
   *   snaps (implemented in the navigate and rotate commands via ensureCoreFor).
   */
  setProjectionMode(m: ProjectionMode): boolean {
    this.cancelTransition();
    const core: "perspective" | "orthographic" =
      m === "orthographic" ? "orthographic" : "perspective";
    const ok = this.adapter.setProjection(core);
    if (!ok) {
      this.events.onToast?.("warn", "Projection switch is not supported by the current camera API");
      return false;
    }
    this.mode = m;
    this.events.onStateChange?.();
    return true;
  }

  /** Core projection required for the upcoming command in the current mode. */
  private ensureCoreFor(kind: "snap" | "free"): boolean {
    if (this.mode !== "perspective-ortho-faces") return true;
    const want: "orthographic" | "perspective" = kind === "snap" ? "orthographic" : "perspective";
    if (this.adapter.projection() === want) return true;
    const ok = this.adapter.setProjection(want);
    if (ok) this.events.onStateChange?.();
    return ok;
  }

  /* ── Cube navigation ────────────────────────────────────────────────── */

  navigateToFace(face: CubeFace): CommandOutcome {
    return this.navigateToTarget("face", face);
  }

  navigateToEdge(edge: CubeEdge): CommandOutcome {
    return this.navigateToTarget("edge", edge);
  }

  navigateToCorner(corner: CubeCorner): CommandOutcome {
    return this.navigateToTarget("corner", corner);
  }

  private navigateToTarget(kind: string, id: string): CommandOutcome {
    const derived = deriveOrientation(this.mapping);
    const spec = specForTarget(derived, kind, id);
    if (!spec) return { ok: false, reason: "invalid-state" };

    if (!this.ensureCoreFor("snap")) return { ok: false, reason: "rejected-by-camera" };

    const target = this.adapter.target().clone();
    const dist = Math.max(
      this.adapter.position().distanceTo(target),
      this.config.minDistance,
    );
    this.cancelTransition();
    this.startSpecTransition(spec, target, dist);
    return { ok: true };
  }

  /* ── Rotation arrows ────────────────────────────────────────────────── */

  /** Counterclockwise spin around the world vertical (↺ arrow, right-hand rule). */
  rotateCounterClockwise(): CommandOutcome { return this.rotateBy(this.config.rotateStepDeg); }
  /** Clockwise spin (↻ arrow). */
  rotateClockwise(): CommandOutcome { return this.rotateBy(-this.config.rotateStepDeg); }
  /** Alias of rotateCounterClockwise (left curved arrow). */
  rotateLeft(): CommandOutcome { return this.rotateBy(this.config.rotateStepDeg); }
  /** Alias of rotateClockwise (right curved arrow). */
  rotateRight(): CommandOutcome { return this.rotateBy(-this.config.rotateStepDeg); }
  /** Camera arcs up over the model (pitch toward the top pole). */
  rotateUp(): CommandOutcome { return this.rotateBy(0, this.config.rotateStepDeg); }
  /** Camera arcs down under the model. */
  rotateDown(): CommandOutcome { return this.rotateBy(0, -this.config.rotateStepDeg); }

  /**
   * Rotate the camera around the orbit target.
   *  - azimuthDeg: spin around the world vertical, positive = right-hand rule
   *    (counterclockwise seen from above). Roll rides along — no re-leveling.
   *  - pitchDeg: tilt around the screen-right axis, positive = camera arcs up
   *    toward the top pole; clamped away from the poles so the up vector
   *    can never flip.
   */
  rotateBy(azimuthDeg = 0, pitchDeg = 0): CommandOutcome {
    if (!this.ensureCoreFor("free")) return { ok: false, reason: "rejected-by-camera" };

    const pos = this.adapter.position();
    const target = this.adapter.target();
    const up = this.adapter.up();
    const cur = makeSpec(pos.clone().sub(target), up);
    if (!cur) return { ok: false, reason: "degenerate-orientation" };

    let next: ViewSpec | null = cur;
    if (pitchDeg !== 0) {
      next = pitchSpec(cur, pitchDeg);
      if (!next) return { ok: false, reason: "at-pole" };
    }
    if (azimuthDeg !== 0) {
      next = spinSpec(next, azimuthDeg);
      if (!next) return { ok: false, reason: "at-pole" };
    }
    if (!next) return { ok: false, reason: "degenerate-orientation" };

    const dist = Math.max(pos.distanceTo(target), this.config.minDistance);
    this.cancelTransition();
    this.startSpecTransition(next, target, dist);
    return { ok: true };
  }

  /* ── Home ───────────────────────────────────────────────────────────── */

  /** Return to the saved Home view (or the documented default when none). */
  goHome(): CommandOutcome {
    this.cancelTransition();
    const home = this.home ?? this.loadHomeState();
    if (home) {
      const core: "perspective" | "orthographic" =
        home.projection === "orthographic" ? "orthographic" : "perspective";
      if (this.adapter.projection() !== core && !this.adapter.setProjection(core)) {
        return { ok: false, reason: "rejected-by-camera" };
      }
      this.mode = home.navigationMode ?? home.projection;

      if (home.orthoHalfHeight != null && core === "orthographic") {
        this.adapter.setOrthoHalfHeight(home.orthoHalfHeight);
      }
      const pos = new THREE.Vector3(home.pos[0], home.pos[1], home.pos[2]);
      const target = new THREE.Vector3(home.target[0], home.target[1], home.target[2]);
      const up = home.up
        ? new THREE.Vector3(home.up[0], home.up[1], home.up[2])
        : new THREE.Vector3(0, 1, 0);
      this.startEndpointTransition(pos, target, up);
      return { ok: true };
    }

    // No saved home: sensible default from the loaded model bounds.
    const bounds = this.adapter.sceneBounds();
    const placement = defaultHomePlacement(bounds, this.config.minDistance);
    const pos = placement.target.clone()
      .addScaledVector(placement.dir, placement.distance);
    this.startEndpointTransition(pos, placement.target, new THREE.Vector3(0, 1, 0));
    return { ok: true };
  }

  /** Capture the complete current view as the new Home. */
  setCurrentViewAsHome(): CommandOutcome {
    this.cancelTransition();
    const pos = this.adapter.position();
    const target = this.adapter.target();
    if (pos.distanceTo(target) < EPS) {
      return { ok: false, reason: "invalid-state" };
    }
    const state = this.captureHomeState();
    if (!state) return { ok: false, reason: "invalid-state" };
    this.home = state;
    this.persistHome(state);
    this.events.onToast?.("success", "Home view saved");
    this.events.onStateChange?.();
    return { ok: true };
  }

  private captureHomeState(): HomeViewState | null {
    try {
      const pos = this.adapter.position();
      const target = this.adapter.target();
      const up = this.adapter.up();
      if (pos.distanceTo(target) < EPS) return null;
      const projection = this.adapter.projection();
      const state: HomeViewState = {
        pos: [pos.x, pos.y, pos.z],
        target: [target.x, target.y, target.z],
        projection,
        navigationMode: this.mode,
        savedAt: Date.now(),
      };
      const upN = up.clone().normalize();
      if (Number.isFinite(upN.x) && upN.lengthSq() > 0.5) {
        state.up = [upN.x, upN.y, upN.z];
      }
      if (projection === "perspective") {
        state.fov = THREE.MathUtils.radToDeg(this.adapter.fovY());
      } else {
        state.orthoHalfHeight = this.adapter.orthoHalfHeight();
      }
      return state;
    } catch {
      return null;
    }
  }

  /**
   * Focus the selection (or the whole model) and save the resulting view as
   * Home. Bounds may be injected by the caller (async selection AABB);
   * without them the adapter's scene bounds are used.
   */
  focusAndSetHome(bounds?: THREE.Box3 | null): CommandOutcome {
    this.cancelTransition();
    const box = bounds ?? this.adapter.focusBounds();
    if (!box || box.isEmpty()) {
      this.events.onToast?.("warn", "Focus: no model or selection to frame");
      return { ok: false, reason: "no-model" };
    }
    const framed = frameBox(box, {
      fovY: this.adapter.fovY(),
      aspect: this.adapter.aspect(),
      padding: this.config.framingPadding,
      minDistance: this.config.minDistance,
    });
    if (!framed) {
      this.events.onToast?.("warn", "Focus: model bounds are invalid");
      return { ok: false, reason: "invalid-state" };
    }

    // Preserve a useful viewing direction (drop near-vertical glare).
    let dir = this.adapter.position().clone().sub(this.adapter.target());
    if (dir.lengthSq() < EPS) dir.set(1.2, 0.7, 1.2);
    dir.normalize();
    if (Math.abs(dir.y) > 0.995) dir.set(1.2, 0.7, 1.2).normalize();
    const up = new THREE.Vector3(0, 1, 0);

    const pos = framed.target.clone().addScaledVector(dir, framed.distance);
    this.startEndpointTransition(pos, framed.target, up);

    // Home = the state we are converging to (exact, not sampled mid-flight).
    const state: HomeViewState = {
      pos: [pos.x, pos.y, pos.z],
      target: [framed.target.x, framed.target.y, framed.target.z],
      projection: this.adapter.projection(),
      navigationMode: this.mode,
      savedAt: Date.now(),
    };
    if (state.projection === "perspective") {
      state.fov = THREE.MathUtils.radToDeg(this.adapter.fovY());
    } else {
      // The ortho frustum must reproduce the framed half-height.
      this.adapter.setOrthoHalfHeight(framed.orthoHalfHeight);
      state.orthoHalfHeight = framed.orthoHalfHeight;
    }
    this.home = state;
    this.persistHome(state);
    this.events.onToast?.("success", "Focused view saved as Home");
    this.events.onStateChange?.();
    return { ok: true };
  }

  /** Restore the documented default Home (clears the user-defined one). */
  resetHome(): CommandOutcome {
    this.cancelTransition();
    this.home = null;
    const key = homeStorageKey(this.projectId);
    if (this.storage) clearHome(this.storage, key);

    const bounds = this.adapter.sceneBounds();
    const placement = defaultHomePlacement(bounds, this.config.minDistance);
    const pos = placement.target.clone().addScaledVector(placement.dir, placement.distance);
    this.startEndpointTransition(pos, placement.target, new THREE.Vector3(0, 1, 0));

    // Persist the default so hasHome()/goHome() stay consistent across reloads.
    const state: HomeViewState = {
      pos: [pos.x, pos.y, pos.z],
      target: [placement.target.x, placement.target.y, placement.target.z],
      projection: this.adapter.projection(),
      navigationMode: this.mode,
      savedAt: Date.now(),
    };
    this.home = state;
    this.persistHome(state);
    this.events.onToast?.("info", "Home reset to the default view");
    this.events.onStateChange?.();
    return { ok: true };
  }

  private persistHome(state: HomeViewState): void {
    if (!this.storage) return;
    saveHome(this.storage, homeStorageKey(this.projectId), state);
  }

  private loadHomeState(): HomeViewState | null {
    if (!this.storage) return null;
    return loadHome(this.storage, homeStorageKey(this.projectId));
  }

  /* ── Orientation customization ──────────────────────────────────────── */

  /** Define the current viewing direction as the Front orientation. */
  setCurrentViewAsFront(): CommandOutcome {
    return this.captureOrientationAnchor("front");
  }

  /** Define the current viewing direction as the Top orientation. */
  setCurrentViewAsTop(): CommandOutcome {
    return this.captureOrientationAnchor("top");
  }

  private captureOrientationAnchor(which: "front" | "top"): CommandOutcome {
    const pos = this.adapter.position();
    const target = this.adapter.target();
    const dir = pos.clone().sub(target);
    if (dir.lengthSq() < EPS) return { ok: false, reason: "invalid-state" };
    dir.normalize();
    const upHint = this.adapter.up();

    const spec = makeSpec(dir, upHint);
    if (!spec) {
      this.events.onToast?.("warn", "Cannot set orientation: view direction is degenerate");
      return { ok: false, reason: "degenerate-orientation" };
    }

    const next = cloneMapping(this.mapping);
    next[which] = spec;
    if (!isValidMapping(next)) {
      this.events.onToast?.(
        "warn",
        which === "top"
          ? "Top cannot be parallel to the Front direction"
          : "Front cannot be parallel to the Top direction",
      );
      return { ok: false, reason: "degenerate-orientation" };
    }

    this.mapping = next;
    if (this.storage) {
      saveOrientationMapping(this.storage, orientationStorageKey(this.projectId), this.mapping);
    }
    this.events.onToast?.(
      "success",
      `${which === "front" ? "Front" : "Top"} orientation set from the current view`,
    );
    this.events.onStateChange?.();
    return { ok: true };
  }

  /** Restore the default project orientation mapping (camera untouched). */
  resetOrientation(): CommandOutcome {
    this.mapping = defaultOrientation();
    if (this.storage) {
      saveOrientationMapping(this.storage, orientationStorageKey(this.projectId), this.mapping);
    }
    this.events.onToast?.("info", "Orientation reset to the project default");
    this.events.onStateChange?.();
    return { ok: true };
  }

  private loadMapping(): OrientationMapping {
    if (this.storage) {
      const stored = loadOrientationMapping(this.storage, orientationStorageKey(this.projectId));
      if (stored) return stored;
    }
    return defaultOrientation();
  }

  /* ── Label helper for the widget ────────────────────────────────────── */

  labelFor(kind: string, id: string): string {
    return orientationLabel(kind, id);
  }

  /** Quaternion of a spec — exposed for the SVG cube projection. */
  specQuaternion(spec: ViewSpec): THREE.Quaternion {
    return quaternionForSpec(spec);
  }
}
