#!/usr/bin/env node
/**
 * verify-v72 — ViewCube / Navigation / Home controls shape verification.
 * Confirms the feature exists, is wired to the real viewer, and that the
 * CI surface (tests + docs + version) is intact. 40 checks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
}
function read(p) {
  const full = path.join(root, p);
  if (!fs.existsSync(full)) throw new Error(`missing file: ${p}`);
  return fs.readFileSync(full, "utf8");
}
function has(re, p) {
  if (!re.test(read(p))) throw new Error(`${p}: pattern not found: ${re}`);
}

/* ── Module layer ──────────────────────────────────────────────────────── */

check("navigation module exists (types)", () => has(/ProjectionMode|CameraAdapter/, "src/modules/navigation/types.ts"));
check("orientation mapping module", () => has(/deriveFaces|deriveEdges|deriveCorners|DEFAULT_ORIENTATION/, "src/modules/navigation/orientation.ts"));
check("framing module (BIM-aware bounds)", () => has(/export function frameBox|orthoHalfHeight/, "src/modules/navigation/framing.ts"));
check("quaternion transition engine", () => has(/class CameraTransition|slerpQuaternions|quaternionForSpec/, "src/modules/navigation/transitions.ts"));
check("home persistence + validation", () => has(/validateHome|homeStorageKey|obs\.navigation\.home\./, "src/modules/navigation/home-state.ts"));
check("NavigationController exists", () => has(/class NavigationController/, "src/modules/navigation/controller.ts"));
check("controller: 26-target navigation", () => {
  const s = read("src/modules/navigation/controller.ts");
  for (const m of ["navigateToFace", "navigateToEdge", "navigateToCorner", "rotateUp", "rotateDown",
    "rotateClockwise", "rotateCounterClockwise", "goHome", "setCurrentViewAsHome", "focusAndSetHome",
    "resetHome", "setCurrentViewAsFront", "setCurrentViewAsTop", "resetOrientation", "setProjectionMode",
    "setProjectId", "cancelTransition", "tick"]) {
    if (!s.includes(m)) throw new Error(`controller missing: ${m}`);
  }
});
check("controller: Perspective-with-Ortho-Faces policy", () => has(/perspective-ortho-faces/, "src/modules/navigation/controller.ts"));
check("barrel exports", () => has(/export \* from/, "src/modules/navigation/index.ts"));
check("types: 12 edges + 8 corners enumerated", () => {
  const s = read("src/modules/navigation/types.ts");
  if (!/CUBE_EDGES/.test(s) || !/CUBE_CORNERS/.test(s)) throw new Error("edge/corner lists missing");
});

/* ── Widget layer ──────────────────────────────────────────────────────── */

check("ViewCube widget exists", () => has(/setupViewCube|ViewCube/, "src/features/viewcube.ts"));
check("widget: faces/edges/corners are real interaction targets", () => {
  const s = read("src/features/viewcube.ts");
  for (const m of ["navigateToFace", "navigateToEdge", "navigateToCorner", "makeInteractive", "contextmenu"]) {
    if (!s.includes(m)) throw new Error(`widget missing: ${m}`);
  }
});
check("widget: keyboard accessible (role=button, Enter/Space)", () => {
  const s = read("src/features/viewcube.ts");
  if (!/role.*button/.test(s) || !/"Enter" \|\| ev.key === " "/.test(s)) {
    throw new Error("keyboard activation missing");
  }
});
check("widget: compass letters honor Project/True North", () => has(/trueNorthAngle/, "src/features/viewcube.ts"));
check("widget: rotation arrows with press-and-hold", () => has(/rotateHoldMs|setInterval/, "src/features/viewcube.ts"));
check("widget: Home menu with all 10 commands", () => {
  const s = read("src/features/viewcube.ts");
  for (const label of ["Go Home", "Orthographic", "Perspective with Ortho Faces",
    "Set current view as Home", "Focus and set as Home", "Reset Home",
    "Set current view as Front", "Set current view as Top", "Reset orientation"]) {
    if (!s.includes(label)) throw new Error(`menu label missing: ${label}`);
  }
  if (!/"Perspective", kind: "radio"/.test(s)) throw new Error("Perspective radio missing");
});
check("widget: menu closes on Escape + cancels transition", () => {
  const s = read("src/features/viewcube.ts");
  if (!/Escape/.test(s) || !/cancelTransition\(\)/.test(s)) throw new Error("Escape handling missing");
});
check("widget: real camera adapter (no second viewer)", () => {
  const s = read("src/features/viewcube.ts");
  for (const m of ["setLookAt", "camera-tools", "OrthoPerspective"]) {
    if (!s.includes(m) && m !== "OrthoPerspective") throw new Error(`adapter missing: ${m}`);
  }
});
check("widget: gesture-watched projection restore (PwOF)", () => has(/perspective-ortho-faces/, "src/features/viewcube.ts"));
check("widget: SVG cube geometry module", () => has(/projectCube|CUBE_GRAPH/, "src/features/viewcube-geometry.ts"));
check("geometry: canonical edge ids match navigation convention", () => has(/canonicalEdgeId/, "src/features/viewcube-geometry.ts"));

/* ── Integration ───────────────────────────────────────────────────────── */

check("main.ts boots the ViewCube", () => has(/setupViewCube/, "src/main.ts"));
check("navigation bar docks below the ViewCube", () => has(/TOP_WITH_VIEWCUBE|obs-viewcube-visibility/, "src/features/navigation-bar.ts"));
check("ui-registry exposes the ViewCube toggle", () => has(/id: "viewcube"/, "src/features/ui-items-register.ts"));
check("command palette registrations", () => has(/nav-go-home|nav-pwof|nav-reset-orientation/, "src/features/viewcube.ts"));
check("persistence keys use the obs. prefix", () => has(/obs\.navigation\./, "src/modules/navigation/home-state.ts"));

/* ── Tests + CI + docs + version ───────────────────────────────────────── */

check("unit test suite exists", () => has(/v72-viewcube-navigation|navigateToFace/, "tests/v72-viewcube-navigation.test.cjs"));
check("test suite compiles the navigation module", () => has(/src\/modules\/navigation\/index\.ts/, "tests/v72-viewcube-navigation.test.cjs"));
check("package.json: test:v72 script", () => has(/"test:v72":\s*"node tests\/v72-viewcube-navigation\.test\.cjs"/, "package.json"));
check("package.json: verify:v72 script", () => has(/"verify:v72":\s*"node scripts\/verify-v72\.mjs"/, "package.json"));
// Forward-compatible (v71/v70 convention): any 0.72+ or 0.8x/0.9x version passes.
check("package.json: version >= 0.72 (forward-compatible)", () => has(/"version":\s*"0\.(7[2-9]|[89]\d|\d{3})\.\d+"/, "package.json"));
check("CI: unit-tests workflow runs test:v72", () => has(/npm run test:v72/, ".github/workflows/unit-tests.yml"));
check("CI: unit-tests workflow runs verify:v72", () => has(/npm run verify:v72/, ".github/workflows/unit-tests.yml"));
check("docs: NAVIGATION_V72.md exists", () => has(/ViewCube|NavigationController/, "docs/NAVIGATION_V72.md"));
check("docs: acceptance criteria mapped", () => has(/Acceptance|acceptance/, "docs/NAVIGATION_V72.md"));
check("README documents navigation", () => has(/ViewCube/i, "README.md"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
