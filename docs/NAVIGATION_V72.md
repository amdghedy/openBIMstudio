# Professional ViewCube, Navigation, Camera & Home Controls — v0.72.0

Autodesk Viewer–inspired navigation for OpenBIMStudio, implemented as a
first-class part of the existing viewer (no demo, no second viewer, no second
orbit controller). This document covers the architecture, the commands, the
behavioral contracts, persistence, testing and known limitations.

---

## 1. Feature overview

| Area | What ships |
|---|---|
| ViewCube | Live SVG cube in the upper-right viewport corner. 6 faces, 12 edges and 8 corners are real, individually clickable targets. Current orientation is highlighted; face labels follow the live orientation mapping. |
| Compass | N/E/S/W ring letters anchored to Project/True North (`modules/north`), foreshortened with the view, dimmed when pointing away from the viewer, hidden when pointing at it. |
| Rotation arrows | 4 curved arrows (left/right = 90° spins, up/down = 90° pitches). Click = one step; press-and-hold = continuous repeat at `rotateHoldMs`. Pitches refuse to flip over the poles. |
| Home menu | All ten commands of the reference screenshot: Go Home, Orthographic, Perspective, Perspective with Ortho Faces, Set current view as Home, Focus and set as Home, Reset Home, Set current view as Front, Set current view as Top, Reset orientation. |
| Projection | Genuine orthographic/perspective switches through the existing ThatOpen `OrthoPerspectiveCamera` (framing-preserving), plus the distinct *Perspective with Ortho Faces* mode. |
| Transitions | Quaternion-slerp camera animation with cancellation, replacement and gesture yielding. No Euler flips, stable up vectors. |
| Accessibility | `role=button` + `aria-label` + Enter/Space on every cube target, menu roles (`menu`, `menuitem`, `menuitemradio` + `aria-checked`), arrow-key menu navigation, Escape closes the menu and cancels an active animation. |
| Command palette | All ten menu commands registered as `View` palette commands (`nav-go-home`, `nav-ortho`, `nav-persp`, `nav-pwof`, `nav-set-home`, `nav-focus-home`, `nav-reset-home`, `nav-set-front`, `nav-set-top`, `nav-reset-orientation`). |
| UI registry | "ViewCube" toggle in the User Interface menu; the Navigation Bar (now available) docks below the cube and returns to the corner when the cube is hidden. |

---

## 2. Architecture

```
src/modules/navigation/          ← pure, DOM-free, Node-testable
  types.ts          ProjectionMode, cube topology, ViewSpec, HomeViewState,
                    NavigationConfig, CameraAdapter, KeyValueStore
  orientation.ts    DEFAULT_ORIENTATION + 26-target derivation from two
                    anchors (front/top), spin/pitch Rodrigues primitives,
                    nearestOrientation indicator
  framing.ts        frameBox() closed form + safe default placement
  transitions.ts    CameraTransition (quaternion slerp, easing, cancel)
  home-state.ts     Home validation + per-project localStorage persistence
  controller.ts     NavigationController — all navigation decisions
src/features/
  viewcube-geometry.ts  cube interaction graph + ortho projection (pure)
  viewcube.ts           RealCameraAdapter + widget DOM + menu + boot
```

**Layering rules**

1. The controller never touches the DOM. All viewer access flows through the
   `CameraAdapter` interface; the production adapter wraps
   `ctx.world.camera` (ThatOpen `OrthoPerspectiveCamera` + camera-controls)
   and routes every camera write through `controls.setLookAt`, so
   camera-controls remains the single owner of orbit/pan/zoom.
2. Exactly one transition is active. A new command replaces it, a user
   pointer/wheel gesture on the canvas cancels it, Escape (with the menu
   open) cancels it.
3. The widget is event-driven: the SVG re-projects only on camera `update`
   events (rAF-coalesced), never on a timer.

### Orientation mapping (the core design)

The 26 cube targets are **derived**, never hardcoded per view. Two anchors —
`front` and `top` — fully determine the cube:

- `back = −front.dir`, ring up = `front.up`
- `right = front.up × front.dir`, `left = −right` (THREE lookAt convention)
- ring edges = `normalize(a + b)` with the ring up; pole edges and corners
  orthogonalize the nearest ring face's up
- `bottom = −top.dir` with `front.dir` orthogonalized as up

The default mapping is byte-identical to `camera-tools.gotoExactView`:
front = +Z / up +Y, right = +X, top = +Y / up (0,0,−1), bottom = −Y /
up (0,0,+1). Project North is world +Z (`modules/north`).

*Set current view as Front / Top* rewrites one anchor; the whole cube
(including face labels shown on the widget) follows. *Reset orientation*
restores the defaults. Anchors that would be parallel are rejected
(`degenerate-orientation`).

### Transition engine

Orientation interpolates with `Quaternion.slerpQuaternions` (shortest arc —
no Euler discontinuity, verified by test to never rotate more than 90° per
50 ms sample). Position is reconstructed each frame as
`target(t) + dir(t) · dist(t)`, so pivot and distance animate independently
while the up vector rides the interpolated orientation: switching between
opposite faces cannot flip the camera.

### Projection modes

- **Orthographic / Perspective** — genuine switches via
  `camera-tools.setProjection`, which preserves the apparent view size
  (ortho zoom ⇄ dolly distance mapping) and keeps the camera direction.
- **Perspective with Ortho Faces** — the navigation mode where free orbiting
  uses perspective while cube face/edge/corner snaps switch the core camera
  to orthographic for a flat, aligned view; the next free orbit command
  (arrow or drag) returns to perspective. The mode is distinct in state and
  in behavior, not a relabeled perspective.

### Framing (BIM-aware)

`frameBox()` fits a world-space box with the closed form
`distance = r / sin(min(fovY, fovX)/2)` and
`orthoHalfHeight = r / min(1, aspect)` (r = half box diagonal, configurable
padding, hard `minDistance` floor — never inside the model). Empty, NaN or
exploded bounds return `null` and the caller degrades to a safe default.
*Focus and set as Home* uses the selection AABB (async from the selection
service) when present, else the whole scene bounds, and preserves a useful
viewing direction.

---

## 3. Commands and gestures

| Input | Action |
|---|---|
| Click cube face / edge / corner | Navigate to that exact orientation (animated) |
| Right-click the cube or ⋮ button | Open the Home menu |
| 🏠 button / `Go Home` | Restore the saved Home view (animated) |
| Curved arrows | 90° orbit steps; hold to repeat |
| Wheel / MMB / RMB on canvas | Unchanged (existing navigation ownership preserved) |
| Escape (menu open) | Close menu + cancel active navigation animation |
| Double-click object | Unchanged (existing focus behavior) |

**Menu behavior**: opens at the pointer, repositions to stay in the
viewport, closes on successful command / outside pointerdown / Escape,
radio checks mirror the active projection mode, *Focus and set as Home*
disables with an explanatory hint when no model is loaded.

---

## 4. Persistence

Follows the saved-views strategy: `localStorage` under an `obs.` prefix,
keyed per project with a `__global__` fallback:

- `obs.navigation.home.<projectId>` — Home view (pos, target, up, projection,
  navigation mode, fov / ortho half-height, savedAt)
- `obs.navigation.orientation.<projectId>` — Front/Top anchors

Every read is validated (`validateHome` / `isValidMapping`): corrupted,
outdated or tampered payloads degrade to defaults instead of poisoning the
camera. Project switches re-key the state live (`controller.setProjectId`).

`Reset Home` clears the user-defined Home and persists the recomputed
default (model bounds framed from the standard iso direction, or the
documented origin/28 fallback for empty scenes) so `Go Home` stays
consistent across reloads. `Reset Orientation` never moves the camera — it
only restores the mapping.

---

## 5. Testing

`tests/v72-viewcube-navigation.test.cjs` — 69 closed-form-verified tests:

- face/edge/corner derivation matches `gotoExactView` exactly; all 26 up
  vectors provably non-parallel to their directions (no flip)
- Rodrigues spin/pitch land exactly on canonical specs at 90°; pole steps
  refused (`at-pole`) instead of flipping
- slerp endpoints exact, shortest-arc verified, monotonic distance,
  cancellation and replacement semantics
- framing closed form (`r/sin(f/2)`, portrait/landscape binding), invalid
  bounds rejection, safe defaults
- Home validation field-by-field (NaN, pos==target, zero up, absurd fov,
  corrupted JSON, oversized payloads), per-project persistence, corrupted
  store recovery, projection restoration
- controller integration against a recording adapter: every navigation and
  menu command, PwOF snap↔orbit projection policy, ortho zoom preservation,
  gesture cancellation, rapid command replacement, project re-keying
- widget geometry: graph counts, projection visibility, edge-strip quads,
  compass ring placement, label winding
- performance budgets: 1000 cube projections < 500 ms, full transition
  simulation < 200 ms

Run: `npm run test:v72` · Shape checks: `npm run verify:v72` (40 checks).
Both are wired into the Unit tests CI workflow.

---

## 6. Acceptance criteria mapping

| Acceptance criterion (master prompt §13) | Status | Where |
|---|---|---|
| Functional ViewCube visible in the real viewer | ✅ | `viewcube.ts` booted from `main.ts` into `ctx.rightHost` |
| All six faces navigate correctly | ✅ | derived mapping + tests (exact closed forms) |
| Twelve edges + eight corners selectable and functional | ✅ | `CUBE_GRAPH` + `navigateToEdge/Corner` + tests |
| Directional indicators reflect the real mapping | ✅ | `nearestOrientation` highlight + compass from true north |
| Rotation arrows operate on the real camera | ✅ | `rotateBy` through the adapter + hold-to-repeat |
| Orthographic mode is a genuine projection | ✅ | `camera-tools.setProjection` (framing-preserving) |
| Perspective mode is a genuine projection | ✅ | same path |
| Perspective with Ortho Faces has distinct documented behavior | ✅ | `ensureCoreFor` policy + doc §2 + tests |
| Go Home restores the saved Home view | ✅ | persisted, validated, animated; tests |
| Set Current View as Home saves the actual view | ✅ | full camera state capture; tests |
| Focus and Set as Home frames selection/model and saves | ✅ | selection AABB → `frameBox` → save; tests |
| Reset Home restores the default configuration | ✅ | recomputed + re-persisted; tests |
| Set Current View as Front / Top update the mapping | ✅ | anchor rewrite, whole cube follows; tests |
| Reset Orientation restores the default mapping | ✅ | camera untouched; persistence; tests |
| Controls provide feedback and accessibility | ✅ | toasts, aria roles, keyboard activation, hints |
| Transitions are smooth and stable | ✅ | quaternion slerp, no-flip tests, cancellation |
| Works with real BIM models and existing interactions | ✅ | adapter over the live viewer; orbit/pan/zoom untouched |
| Existing functionality remains intact | ✅ | no second controller; camera-tools reuse; full suite green |
| Tests, build and validation executed | ✅ | 69 tests + 40 shape checks + tsc + production build |
| No placeholder handlers remain | ✅ | every control routes to `NavigationController` |
| Documentation explains commands, architecture, limitations | ✅ | this document |

## 7. Known limitations

- **Transition timing vs. camera-controls damping**: the controller drives
  `setLookAt(..., false)` per frame; the app-level `smoothTime` (0.04)
  remains active, making the tail of a transition marginally softer than a
  pure quaternion path.
- **PwOF manual drag**: pointer-drag orbit in *Perspective with Ortho Faces*
  returns to perspective on the next drag gesture but does not
  retroactively re-render the previous ortho snap.
- **Custom Front/Top with tilted roll**: the derivation is fully general,
  but compass letters remain anchored to world horizontal directions (by
  design — they show north, not the custom ring).
- **Hold-to-repeat** is pointer-based only; keyboard repeat on the arrow
  targets fires per keypress.
- The dormant `features/ortho-hook.ts` (not booted anywhere) still contains
  a fitAll-on-projection-change behavior; it was left untouched because it
  never runs. If it is ever booted it should respect the ViewCube's
  framing-preserving switches.
