import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || process.cwd();

const OWNED = [
  "src/core/performance-optimizer.ts",
  "src/core/bim-mouse-policy.ts",
  "src/core/wheel-arbiter.ts",
  "src/features/constraint-solver.ts",
  "src/features/hosted-openings.ts",
  "src/features/drafting-2d.ts",
  "src/features/drafting-bridge.ts",
  "src/features/lod-manager.ts",
  "src/features/focus-service.ts",
  "src/features/critical-gaps-ui.ts",
  "src/features/selection-orbit.ts",
  "src/critical-gaps-boot.ts",
  "src/modules/collaboration/workshare-client.ts",
  "src/modules/collaboration/realtime-client.ts",
  "server/index.mjs",
];

const PATCHED = [
  "src/features/navigation.ts",
  "src/features/context-menu.ts",
  "vite.config.ts",
  "package.json",
];

const NON_ASCII = /[^\x00-\x7F]/;

function full(rel) { return path.join(root, rel); }
function exists(rel) { try { fs.accessSync(full(rel)); return true; } catch { return false; } }
function read(rel) { try { return fs.readFileSync(full(rel), "utf8"); } catch { return null; } }

const results = [];
function check(group, name, ok, detail) {
  results.push({ group, name, ok: !!ok, detail: detail || "" });
}

// ---------------------------------------------------------------------------
// A. Owned files must exist and be pure ASCII (kills emoji/mojibake regressions
//    in OUR code only; original files keep the author's box-drawing comments).
// ---------------------------------------------------------------------------
for (const rel of OWNED) {
  const t = read(rel);
  check("files", "exists: " + rel, t !== null, t === null ? "missing" : "");
  if (t !== null) {
    const m = t.match(NON_ASCII);
    check("ascii", "pure-ASCII: " + rel, !m, m ? "found non-ASCII at index " + m.index : "");
  }
}

// ---------------------------------------------------------------------------
// B. Single wheel / MMB owner
// ---------------------------------------------------------------------------
const nav = read("src/features/navigation.ts") || "";
check("wheel", "navigation owns MMB drag (g.button === 1)", /g\.button\s*===\s*1/.test(nav));
check(
  "wheel",
  "navigation has a wheel guard (__OBS_MMB_HELD or __OBS_WHEEL_AUTHORITY)",
  /__OBS_MMB_HELD/.test(nav) || /__OBS_WHEEL_AUTHORITY/.test(nav),
);
check(
  "wheel",
  "navigation has NO invalid drag-end MMB_MOVED guard (the 8-error bug)",
  !/g\.kind\s*===\s*["']drag-end["']\s*&&\s*g\.button\s*===\s*1\s*&&\s*!\(window as any\)\.__OBS_MMB_MOVED/.test(nav),
);

const selOrbit = read("src/features/selection-orbit.ts") || "";
check("wheel", "selection-orbit is thin (left-click guard button !== 0)", /button\s*!==\s*0/.test(selOrbit));
check("wheel", "selection-orbit registers NO gesture handler (no g.kind)", !/g\.kind/.test(selOrbit));
check("wheel", "selection-orbit does NOT subscribe to input-router", !/\.subscribe\s*\(/.test(selOrbit));
check("wheel", "selection-orbit attaches NO wheel listener", !/addEventListener\(\s*["']wheel["']/.test(selOrbit));
check("wheel", "selection-orbit handles NO rmb-click", !/rmb-click/.test(selOrbit));

const policy = read("src/core/bim-mouse-policy.ts") || "";
check("wheel", "policy sets MMB held flag", /__OBS_MMB_HELD\s*=\s*true/.test(policy));
check("wheel", "policy exposes cancelActiveOperation", /cancelActiveOperation/.test(policy));
check(
  "wheel",
  "policy does NOT mutate CameraControls mouseButtons (the race we removed)",
  !/mouseButtons\s*\.\s*left\s*=/.test(policy) && !/mouseButtons\.middle\s*=/.test(policy),
);

const arb = read("src/core/wheel-arbiter.ts") || "";
check("wheel", "wheel-arbiter sets authority flag", /__OBS_WHEEL_AUTHORITY\s*=\s*true/.test(arb));
check("wheel", "wheel-arbiter normalizes deltaMode", /deltaMode/.test(arb));
check("wheel", "wheel-arbiter ignores wheel while MMB held", /__OBS_MMB_HELD/.test(arb));
check("wheel", "wheel-arbiter exposes __obsWheelFix", /__obsWheelFix/.test(arb));

// ---------------------------------------------------------------------------
// C. Right-click preserves selection
// ---------------------------------------------------------------------------
const cm = read("src/features/context-menu.ts") || "";
check("rightclick", "context-menu has right-click preservation marker", /right-click preserve selection/.test(cm));
check("rightclick", "context-menu guards authored-domain (authIds.length === 0)", /authIds\.length\s*===\s*0/.test(cm));
check("rightclick", "context-menu guards fragment-domain (fragCount === 0)", /fragCount\s*===\s*0/.test(cm));
check("rightclick", "context-menu still opens the menu (openCtxMenu)", /openCtxMenu/.test(cm));

// ---------------------------------------------------------------------------
// D. Focus frames the SELECTION (not picked.point, not another view)
// ---------------------------------------------------------------------------
check("focus", "context-menu Focus uses focus-service", /focus-service/.test(cm));
check("focus", "context-menu Focus calls focusSelected", /focusSelected/.test(cm));
check("focus", "context-menu has NO picked.point focus fallback", !/focusOnPoint\(\s*picked\.point\s*\)/.test(cm));

const fsvc = read("src/features/focus-service.ts") || "";
check("focus", "focus-service exports focusSelected", /export\s+(async\s+)?function\s+focusSelected/.test(fsvc));
check("focus", "focus-service reads authored selection", /getAuthoredSelection/.test(fsvc));
check("focus", "focus-service reads fragment selection", /getFragmentSelection/.test(fsvc));
check("focus", "focus-service exposes __obsFocusSelected", /__obsFocusSelected/.test(fsvc));
check("focus", "focus-service does NOT use picked.point", !/picked\.point/.test(fsvc));

// ---------------------------------------------------------------------------
// E. Drafting never steals navigation mouse
// ---------------------------------------------------------------------------
const d2 = read("src/features/drafting-2d.ts") || "";
check("drafting", "drafting acts only on left button (button !== 0 guard)", /button\s*!==\s*0/.test(d2));
check("drafting", "drafting has NO middle-button draw trigger", !/button\s*===\s*1/.test(d2));
check("drafting", "drafting overlay is pointer-events:none by default", /pointer-events:\s*none/.test(d2));

// ---------------------------------------------------------------------------
// F. No emoji / corrupted icons in OUR toolbar + context-menu icon literals
// ---------------------------------------------------------------------------
const ui = read("src/features/critical-gaps-ui.ts") || "";
for (const label of ["[D]", "[H]", "[S]", "[A]", "[L]", "[C]", "[R]", "[P]"]) {
  check("toolbar", "toolbar button present: " + label, ui.includes(label));
}

function scanIconLiterals(src, rel) {
  let bad = 0;
  const re = /icon:\s*"([^"]*)"|icon:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(src))) {
    const v = m[1] !== undefined ? m[1] : m[2];
    if (NON_ASCII.test(v) || /^\?+$/.test(v.trim())) bad++;
  }
  check("icons", "no corrupted/emoji icon literals in " + rel, bad === 0, bad ? bad + " bad icon literal(s)" : "");
}
scanIconLiterals(cm, "context-menu.ts");

// ---------------------------------------------------------------------------
// G. Boot wires ALL modules (catches the missing wheel-arbiter/realtime-client)
// ---------------------------------------------------------------------------
const boot = read("src/critical-gaps-boot.ts") || "";
const REQUIRED_BOOT = [
  "setupPerformanceOptimizer",
  "setupHostedOpenings",
  "setupConstraintSolver",
  "setupDrafting2D",
  "setupDraftingBridge",
  "setupLodManager",
  "focus-service",
  "setupCriticalGapsUI",
  "setupBIMMousePolicy",
  "setupWheelArbiter",
  "setupRealtimeClient",
];
for (const tok of REQUIRED_BOOT) {
  check("boot", "boot wires: " + tok, boot.includes(tok));
}

// ---------------------------------------------------------------------------
// H. Signature tokens per owned feature (cheap existence-of-purpose check)
// ---------------------------------------------------------------------------
check("sig", "constraint-solver is button-driven (no auto recompute)", !/recomputeHostedOpenings/.test(read("src/features/constraint-solver.ts") || "") && /export function solveHostedConstraints/.test(read("src/features/constraint-solver.ts") || ""));
check("sig", "hosted-openings writes params.openings", /\.openings\s*=/.test(read("src/features/hosted-openings.ts") || ""));
check("sig", "lod-manager toggles visibility safely", /__obsLodHidden/.test(read("src/features/lod-manager.ts") || ""));
check("sig", "drafting-bridge converts screen->world", /screenToWorldXZ|Raycaster/.test(read("src/features/drafting-bridge.ts") || ""));
check("sig", "realtime-client uses EventSource (SSE)", /EventSource/.test(read("src/modules/collaboration/realtime-client.ts") || ""));
check("sig", "server exposes rooms + SSE", /\/events|text\/event-stream/.test(read("server/index.mjs") || ""));

// ---------------------------------------------------------------------------
// I. Build stays green: esnext target + Lit dedupe + npm scripts
// ---------------------------------------------------------------------------
const vite = read("vite.config.ts") || "";
check("build", "vite build.target supports top-level await (esnext/es2022+)", /esnext/.test(vite) || /es202[2-9]/.test(vite));
check("build", "vite dedupes Lit (single custom-element registry)", /dedupe\s*:/.test(vite) && /["']lit["']/.test(vite));

let pkg = null;
try { pkg = JSON.parse(read("package.json") || "{}"); } catch { pkg = null; }
check("build", "package.json parses", pkg !== null);
if (pkg) {
  check("build", "package.json has build script", !!(pkg.scripts && pkg.scripts.build));
  check("build", "package.json has server script", !!(pkg.scripts && pkg.scripts.server));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
// ---- hosted-recut contract (added by Apply-Hosted-Recut) ----
const authSrc = read("src/features/authoring.ts") || "";
check("hosted-recut", "openingsForWall clamps offset to host length", /hosted-recut: clamp each opening/.test(authSrc));
check("hosted-recut", "openingsForWall writes clamp back to p.offsetAlongHost", /p\.offsetAlongHost\s*=\s*offset/.test(authSrc));
check("hosted-recut", "wall build still dispatches openings to builder", /openingsForWall\(el\.id\)/.test(authSrc) && /buildWallWithOpenings\(el, openings\)/.test(authSrc));
check("hosted-recut", "legacy builder still cuts holes from openings", /for \(const op of openings\)/.test(authSrc) && /new THREE\.Path\(\)/.test(authSrc));
const owCount = (authSrc.match(/function openingsForWall/g) || []).length;
check("hosted-recut", "exactly one openingsForWall definition (no duplicate owner)", owCount === 1, "found " + owCount);
check("hosted-recut", "constraint-solver still exports solveHostedConstraints", /export function solveHostedConstraints/.test(read("src/features/constraint-solver.ts") || ""));

// ---- solver de-race contract (added by Fix-Hosted-Placement-Race) ----
const csSrc = read("src/features/constraint-solver.ts") || "";
check("derace", "solver has NO pointerup auto-solve", !/addEventListener\(\s*["']pointerup["']/.test(csSrc));
check("derace", "solver has NO obs:authoring-changed auto-listener", !/window\.addEventListener\(\s*["']obs:authoring-changed["']/.test(csSrc));
check("derace", "solver has NO patchMethod auto-wrap", !/patchMethod\(/.test(csSrc));
check("derace", "solver solve does NOT call recomputeHostedOpenings", !/recomputeHostedOpenings\(/.test(csSrc));
check("derace", "solver still exports solveHostedConstraints", /export function solveHostedConstraints/.test(csSrc));
const hoSrc = read("src/features/hosted-openings.ts") || "";
check("derace", "hosted-openings refresh does NOT rebuild geometry", !/rebuildAuthored\(/.test(hoSrc) && !/\.rebuild\(/.test(hoSrc) && !/markAuthoringDirty\(/.test(hoSrc));
check("derace", "hosted-openings still writes params.openings data", /\.openings\s*=/.test(hoSrc));
check("derace", "hosted-openings still refreshes schedules/cost/ifc", /obs:schedule-refresh/.test(hoSrc) && /obs:cost-refresh/.test(hoSrc));
const uiSrc = read("src/features/critical-gaps-ui.ts") || "";
check("layout", "toolbar horizontal bottom-centered (no palette overlap)", /flex-direction:\s*row/.test(uiSrc) && /translateX\(-50%\)/.test(uiSrc) && /max-width:\s*calc\(100vw/.test(uiSrc));
check("layout", "toolbar no longer vertical right-anchored", !/flex-direction:\s*column/.test(uiSrc) && !/right:\s*18px/.test(uiSrc));
// ---- recut hardening contract (added by Harden-Hosted-Recut) ----
const authH = read("src/features/authoring.ts") || "";
check("recut-hardening", "openingsForWall keeps clamp marker", /hosted-recut: clamp each opening/.test(authH));
check("recut-hardening", "openingsForWall has full-face skip", /hosted-recut: skip full-face opening/.test(authH));
check("recut-hardening", "skip drops degenerate OR full-face holes", /degenerate\s*\|\|\s*fullFace/.test(authH) && /holeW >= L \* 0\.9 && holeH >= H \* 0\.9/.test(authH));
check("recut-hardening", "hostAngle TS narrowing fix still present", /const hostAngle = Math\.round\(angle \* 10000\) \/ 10000;/.test(authH) && /\(p as any\)\.rotation = hostAngle/.test(authH));
const owN = (authH.match(/function openingsForWall/g) || []).length;
check("recut-hardening", "exactly one openingsForWall definition", owN === 1, "found " + owN);
// ---- place-sync contract (added by Fix-Hosted-Place-Sync) ----
const psSrc = read("src/features/hosted-place-sync.ts") || "";
check("place-sync", "hosted-place-sync module exists", psSrc.length > 0);
check("place-sync", "sets __obsSyncHostedPlacement", /__obsSyncHostedPlacement\s*=/.test(psSrc));
check("place-sync", "reconciles from offsetAlongHost (same source as hole)", /offsetAlongHost/.test(psSrc));
check("place-sync", "uses author basis makeBasis(dir, up, normal)", /makeBasis\(\s*dir,\s*up,\s*normal\s*\)/.test(psSrc));
check("place-sync", "authoring rebuild calls the sync", /__obsSyncHostedPlacement\?\.\(\)/.test(read("src/features/authoring.ts") || ""));
check("place-sync", "boot wires hosted-place-sync", /hosted-place-sync/.test(read("src/critical-gaps-boot.ts") || ""));
// ---- openbim-fix: verify-input-focus.mjs -- code review fix contract ----
const ntIfc = read("src/modules/export/native-twin-ifc.ts") || "";
check("code-review-fix", "native-twin-ifc declares IFCUNITASSIGNMENT", /IFCUNITASSIGNMENT/.test(ntIfc));
check("code-review-fix", "native-twin-ifc uses IFCTRIANGULATEDFACESET (no typo)", /IFCTRIANGULATEDFACESET/.test(ntIfc) && !/IFCTRIANGULATEDFACESSET/.test(ntIfc));
const unitsSrc = read("src/core/units.ts") || "";
check("code-review-fix", "units.ts has area suffix matcher", /function matchAreaSuffix/.test(unitsSrc));
check("code-review-fix", "units.ts has volume suffix matcher", /function matchVolumeSuffix/.test(unitsSrc));
check("code-review-fix", "units.ts has mass suffix matcher", /function matchMassSuffix/.test(unitsSrc));
check("code-review-fix", "units.ts has angle suffix matcher", /function matchAngleSuffix/.test(unitsSrc));
const vcSrc = read("src/features/viewcube.ts") || "";
check("code-review-fix", "viewcube.ts disposes the WebGL renderer", /renderer\.dispose\(\)/.test(vcSrc));
const ctxDead = read("src/features/context.ts");
const ctxDeadDisabled = read("src/features/context.ts.disabled");
check("code-review-fix", "dead context.ts is disabled", ctxDead === null && ctxDeadDisabled !== null);
const cgSrc = read("src/modules/clash/geometry.ts") || "";
check("code-review-fix", "clash/geometry.ts warns on 1-based idRanges", /1-based idRanges fallback/.test(cgSrc));
const authSrc2 = read("src/features/authoring.ts") || "";
check("code-review-fix", "authoring.refreshGrips requires live wall-handles overlay", /handlesActive/.test(authSrc2) && /obs-wall-handles/.test(authSrc2));
const navSrc = read("src/features/navigation.ts") || "";
check("code-review-fix", "navigation checks wheel authority before raycast",
  navSrc.indexOf("__OBS_WHEEL_AUTHORITY") >= 0 &&
  navSrc.indexOf("__OBS_WHEEL_AUTHORITY") < navSrc.indexOf("pickWorldPointUnderCursor(g.event.clientX"));
const htmlSrc = read("index.html") || "";
check("code-review-fix", "index.html title is ASCII", /<title>Open BIM Studio - Professional/.test(htmlSrc));
let pkgFix = null;
try { pkgFix = JSON.parse(read("package.json") || "{}"); } catch { pkgFix = null; }
check("code-review-fix", "package.json engines.node >= 20.11", !!(pkgFix && pkgFix.engines && pkgFix.engines.node === ">=20.11.0"));
const collectSrc = read("Collect-Project.ps1") || "";
check("code-review-fix", "collector reads as UTF-8", /ReadAllText\(\$f\.FullName/.test(collectSrc) || /-Encoding UTF8/.test(collectSrc));
// ---- openbim-step1:family-foundation ----
const famTypes = read("src/modules/families/types.ts") || "";
check("family-foundation", "types.ts defines FamilyDefinition", /export interface FamilyDefinition/.test(famTypes));
check("family-foundation", "types.ts defines FamilyService", /export interface FamilyService/.test(famTypes));
const famStore = read("src/modules/families/store.ts") || "";
check("family-foundation", "store.ts boots from localStorage", /obs\.families\.v1/.test(famStore));
check("family-foundation", "store.ts dedupes via Map", /new Map<string, FamilyDefinition>/.test(famStore));
const famGeom = read("src/modules/families/parametric-geometry.ts") || "";
check("family-foundation", "geometry resolver handles box", /case "box":/.test(famGeom));
check("family-foundation", "geometry resolver handles cylinder", /case "cylinder":/.test(famGeom));
check("family-foundation", "geometry resolver handles extrusion", /case "extrusion":/.test(famGeom));
check("family-foundation", "geometry resolver handles composed", /case "composed":/.test(famGeom));
const famRegistry = read("src/modules/families/registry.ts") || "";
check("family-foundation", "registry resolves params with formulas", /function resolveParameters/.test(famRegistry));
check("family-foundation", "registry exposes buildGeometry", /buildGeometry:/.test(famRegistry));
const famBuiltin = read("src/modules/families/builtin-families.ts") || "";
check("family-foundation", "builtin has wall", /sourceElementType: "wall"/.test(famBuiltin));
check("family-foundation", "builtin has door", /sourceElementType: "door"/.test(famBuiltin));
check("family-foundation", "builtin has duct", /sourceElementType: "duct"/.test(famBuiltin));
check("family-foundation", "builtin has pipe", /sourceElementType: "pipe"/.test(famBuiltin));
const famIndex = read("src/modules/families/index.ts") || "";
check("family-foundation", "index exports setupFamilies", /export function setupFamilies/.test(famIndex));
const svcSrc = read("src/core/services.ts") || "";
check("family-foundation", "services.ts imports FamilyService", /import type \{ FamilyService \}/.test(svcSrc));
check("family-foundation", "services.ts has family in ServiceMap", /family:\s*FamilyService;/.test(svcSrc));
check("family-foundation", "services.ts exposes services.family", /get family\(\): FamilyService/.test(svcSrc));
const mainSrc = read("src/main.ts") || "";
check("family-foundation", "main.ts imports setupFamilies", /from "\.\/modules\/families"/.test(mainSrc));
check("family-foundation", "main.ts boots families", /step\("families"/.test(mainSrc));
// ---- openbim-step1.5:family-browser ----
const fbSrc = read("src/features/family-browser.ts") || "";
check("family-browser", "panel module exists", fbSrc.length > 0);
check("family-browser", "exports setupFamilyBrowser", /export function setupFamilyBrowser/.test(fbSrc));
check("family-browser", "exports toggleFamilyBrowser", /export function toggleFamilyBrowser/.test(fbSrc));
check("family-browser", "has search input", /Search families/.test(fbSrc));
check("family-browser", "has category filter", /Filter by category/.test(fbSrc));
check("family-browser", "renders isometric preview", /buildPreviewSvg/.test(fbSrc));
check("family-browser", "exposes Place action", /function onPlace/.test(fbSrc));
check("family-browser", "exposes Duplicate action", /function onDuplicate/.test(fbSrc));
check("family-browser", "exposes Delete action", /function onDelete/.test(fbSrc));
check("family-browser", "exposes Add Type action", /function onAddType/.test(fbSrc));
check("family-browser", "exposes Export JSON action", /function onExport/.test(fbSrc));
check("family-browser", "binds Ctrl+Shift+B shortcut", /ctrlKey.*shiftKey.*key\.toLowerCase\(\) === "b"/.test(fbSrc));
const mainSrc2 = read("src/main.ts") || "";
check("family-browser", "main.ts boots family-browser", /step\("family-browser"/.test(mainSrc2));
check("family-browser", "main.ts imports setupFamilyBrowser", /setupFamilyBrowser/.test(mainSrc2));
const cpSrc = read("src/features/command-palette.ts") || "";
check("family-browser", "command palette exposes familyBrowser.toggle", /familyBrowser\.toggle/.test(cpSrc));
const fbUiSrc = read("src/features/ui-items-register.ts") || "";
check("family-browser", "UI registry entry present", /id:\s*"family-browser"/.test(fbUiSrc));
// ---- openbim-levels:level-driven-modeling ----
const levelsSrc = read("src/modules/levels/levels.ts") || "";
check("levels", "levels facade module exists", levelsSrc.length > 0);
check("levels", "levels facade exposes list()", /list\s*\(\s*\)\s*:\s*LevelRecord\[\]/.test(levelsSrc));
check("levels", "levels facade exposes ensureSeed", /ensureSeed/.test(levelsSrc));
check("levels", "levels facade exposes setActiveId", /setActiveId/.test(levelsSrc));
check("levels", "levels facade exposes findNearest", /findNearest/.test(levelsSrc));

const authLevelSrc = read("src/features/authoring.ts") || "";
check("levels", "authoring has activeLevelId state", /let\s+activeLevelId\s*:/.test(authLevelSrc));
check("levels", "authoring exports getActiveLevelId", /export\s+function\s+getActiveLevelId/.test(authLevelSrc));
check("levels", "authoring exports setActiveLevelById", /export\s+function\s+setActiveLevelById/.test(authLevelSrc));
check("levels", "createElement stamps levelId on new elements", /levelId:\s*activeLevelId/.test(authLevelSrc));
check("levels", "setLevels clears stale activeLevelId", /activeLevelId\s*=\s*null/.test(authLevelSrc));

const projTypesSrc = read("src/modules/projects/types.ts") || "";
check("levels", "AuthoredElement carries optional levelId", /levelId\?:\s*string/.test(projTypesSrc));
check("levels", "LevelDatum carries optional color", /interface\s+LevelDatum[\s\S]{0,200}color\?:\s*string/.test(projTypesSrc));
// ---- openbim-levels:ui-wired ----
const chipSrc = read("src/features/level-chip.ts") || "";
check("levels", "level chip module exists", chipSrc.length > 0);
check("levels", "level chip exports setupLevelChip", /export\s+function\s+setupLevelChip/.test(chipSrc));
check("levels", "level chip renders a floating button", /CHIP_ID\s*=\s*"obs-level-chip"/.test(chipSrc));
check("levels", "level chip has a dropdown switcher", /function\s+openDropdown/.test(chipSrc));
check("levels", "level chip registers command palette entries", /registerCommand\(\{[\s\S]{0,200}id:\s*"level\./.test(chipSrc));
check("levels", "level chip exposes visibility helpers", /export\s+function\s+(show|hide|is)LevelChip/.test(chipSrc));

const ppSrc = read("src/features/property-palette.ts") || "";
check("levels", "property palette imports the levels facade", /import\s+\{\s*levels\s*\}\s+from\s+"\.\.\/modules\/levels"/.test(ppSrc));
check("levels", "property palette has Base Constraint dropdown", /Base Constraint/.test(ppSrc));
check("levels", "property palette has Base Offset numeric", /Base Offset/.test(ppSrc));
check("levels", "property palette constrains the expected element types", /LEVEL_CONSTRAINED_TYPES/.test(ppSrc));
check("levels", "property palette writes element.levelId", /element\.levelId\s*=/.test(ppSrc));

const mainSrcLevels = read("src/main.ts") || "";
check("levels", "main.ts imports setupLevelChip", /setupLevelChip/.test(mainSrcLevels));
check("levels", "main.ts boots level-chip step", /step\("level-chip"/.test(mainSrcLevels));

const projDoc = read("src/modules/projects/types.ts") || "";
check("levels", "ProjectDoc persists activeLevelId", /activeLevelId\?:\s*string\s*\|\s*null/.test(projDoc));

const projSrc = read("src/modules/projects/projects.ts") || "";
check("levels", "projects.ts seeds levels on new project", /levels\.ensureSeed/.test(projSrc));
check("levels", "projects.ts restores active level on open", /levels\.setActiveId\(savedActive\)/.test(projSrc));
check("levels", "projects.ts persists activeLevelId on save", /\(current as any\)\.activeLevelId\s*=/.test(projSrc));
// ---- openbim-families:formula-engine ----
const feSrc = read("src/modules/families/formula-engine.ts") || "";
check("family-formula", "formula engine module exists", feSrc.length > 0);
check("family-formula", "exports evaluateParameters", /export\s+function\s+evaluateParameters/.test(feSrc));
check("family-formula", "exports hasFormulas", /export\s+function\s+hasFormulas/.test(feSrc));
check("family-formula", "exports BUILTIN_FUNCTIONS", /export\s+const\s+BUILTIN_FUNCTIONS/.test(feSrc));
check("family-formula", "builtins cover sqrt", /\bsqrt\s*:/.test(feSrc));
check("family-formula", "builtins cover min / max", /\bmin\s*:/.test(feSrc) && /\bmax\s*:/.test(feSrc));
check("family-formula", "builtins cover round with digits", /\bround\s*:/.test(feSrc));
check("family-formula", "supports '=' prefix", /startsWith\("="\)/.test(feSrc));
check("family-formula", "has topological sort step", /function\s+topoSort/.test(feSrc));
check("family-formula", "detects cycles", /Cycle detected in formula references/.test(feSrc));
check("family-formula", "returns typed error list", /interface\s+FormulaError/.test(feSrc));
check("family-formula", "returns computed parameter set", /computed\s*:\s*Set<string>/.test(feSrc));

const regSrc = read("src/modules/families/registry.ts") || "";
check("family-formula", "registry imports the engine", /from\s+"\.\/formula-engine"/.test(regSrc));
check("family-formula", "registry delegates to evaluateParameters", /evaluateParameters\(\s*family\.parameters/.test(regSrc));
check("family-formula", "registry logs per-parameter formula errors", /formula error --/.test(regSrc));
check("family-formula", "registry no longer builds formulas inline", !/new Function\(\.\.\.Object\.keys\(params\)/.test(regSrc));
// ---- openbim-families:formula-engine-ui ----
const fbFormulaSrc = read("src/features/family-browser.ts") || "";
check("family-formula", "family browser imports the formula engine", /from\s+"\.\.\/modules\/families\/formula-engine"/.test(fbFormulaSrc));
check("family-formula", "family browser evaluates parameters", /evaluateParameters\(\s*fam\.parameters/.test(fbFormulaSrc));
check("family-formula", "family browser tracks computed set", /__fxComputed\s*=\s*__fx\.computed/.test(fbFormulaSrc));
check("family-formula", "family browser tracks errors map", /__fxErrors\s*=\s*new Map\(__fx\.errors/.test(fbFormulaSrc));
check("family-formula", "family browser renders Fx diagnostics block", /function\s+buildFormulaDiagnosticsBlock/.test(fbFormulaSrc));
check("family-formula", "diagnostics block shows computed count", /computed\.size\s*\+\s*" computed"/.test(fbFormulaSrc));
check("family-formula", "diagnostics block shows error count", /errors\.size/.test(fbFormulaSrc));
check("family-formula", "diagnostics block renders each formula text", /p\.formula\s*\?\?\s*""/.test(fbFormulaSrc));
check("family-formula", "diagnostics block colors errored rows red", /color:#fca5a5/.test(fbFormulaSrc));
check("family-formula", "diagnostics block colors computed rows purple", /color:#c084fc/.test(fbFormulaSrc));
// ---- openbim-families:formula-editor ----
const bfSeedSrc = read("src/modules/families/builtin-families.ts") || "";
check("family-formula", "builtin wall declares a formula", /name:\s*"areaPerMeter"[\s\S]{0,200}formula:\s*"= thickness \* height"/.test(bfSeedSrc));
check("family-formula", "builtin column declares a formula", /name:\s*"concreteVolume"[\s\S]{0,200}formula:\s*"= thickness \* depth \* height"/.test(bfSeedSrc));
check("family-formula", "builtin beam declares a formula", /name:\s*"sectionArea"[\s\S]{0,200}formula:\s*"= thickness \* height"/.test(bfSeedSrc));
check("family-formula", "builtin pipe declares a formula using pi()", /formula:\s*"= pi\(\) \* diameter"/.test(bfSeedSrc));
check("family-formula", "builtin families use the min() builtin", /formula:\s*"= height \/ min\(thickness, depth\)"/.test(bfSeedSrc));

const fbEditorSrc = read("src/features/family-browser.ts") || "";
check("family-formula", "family browser shows diagnostics for any family with parameters", /if \(fam\.parameters\.length > 0\)/.test(fbEditorSrc));
check("family-formula", "family browser renders an editable input per formula", /const expr = document\.createElement\("input"\)/.test(fbEditorSrc));
check("family-formula", "family browser saves on Enter", /if \(ev\.key === "Enter"\)/.test(fbEditorSrc));
check("family-formula", "family browser cancels on Escape", /if \(ev\.key === "Escape"\)/.test(fbEditorSrc));
check("family-formula", "family browser writes back via store.update", /store\.update\(fam\.id, \{ parameters: newParams \}\)/.test(fbEditorSrc));
check("family-formula", "family browser re-renders after save", /renderDetail\(\);\s*\n\s*\};/.test(fbEditorSrc));
check("family-formula", "family browser has + Add formula row", /\+ Add formula/.test(fbEditorSrc));
check("family-formula", "family browser shows empty-state note", /No formulas yet/.test(fbEditorSrc));
// ---- openbim-families:instance-wiring ----
const projTypesInst = read("src/modules/projects/types.ts") || "";
check("family-instance", "AuthoredElement carries familyId", /familyId\?:\s*string/.test(projTypesInst));
check("family-instance", "AuthoredElement carries familyTypeId", /familyTypeId\?:\s*string/.test(projTypesInst));

const authInstSrc = read("src/features/authoring.ts") || "";
check("family-instance", "authoring has activeFamilyId state", /let\s+activeFamilyId\s*:/.test(authInstSrc));
check("family-instance", "authoring has activeFamilyTypeId state", /let\s+activeFamilyTypeId\s*:/.test(authInstSrc));
check("family-instance", "authoring exports getActiveFamilyId", /export\s+function\s+getActiveFamilyId/.test(authInstSrc));
check("family-instance", "authoring exports getActiveFamilyTypeId", /export\s+function\s+getActiveFamilyTypeId/.test(authInstSrc));
check("family-instance", "authoring exports setActiveFamily", /export\s+function\s+setActiveFamily/.test(authInstSrc));
check("family-instance", "authoring exports syncFamilyInstances", /export\s+function\s+syncFamilyInstances/.test(authInstSrc));
check("family-instance", "createElement stamps familyId", /familyId:\s*activeFamilyId/.test(authInstSrc));
check("family-instance", "createElement stamps familyTypeId", /familyTypeId:\s*activeFamilyTypeId/.test(authInstSrc));
check("family-instance", "authoring API exposes syncFamilyInstances", /syncFamilyInstances,/.test(authInstSrc));

const fbInstSrc = read("src/features/family-browser.ts") || "";
check("family-instance", "family browser sets the active family on Place", /setActiveFamily\?\.\(fam\.id/.test(fbInstSrc));
check("family-instance", "family browser shows an instances section", /Instances of this family/.test(fbInstSrc));
check("family-instance", "family browser offers a Sync button", /Sync instances/.test(fbInstSrc));
check("family-instance", "family browser counts instances", /instances\.length\s*\+\s*" instance"/.test(fbInstSrc));
check("family-instance", "family browser calls syncFamilyInstances", /syncFamilyInstances\(fam\.id/.test(fbInstSrc));

const ppInstSrc = read("src/features/property-palette.ts") || "";
check("family-instance", "property palette defines family identity block", /function\s+makeFamilyIdentityBlock/.test(ppInstSrc));
check("family-instance", "property palette renders the block when familyId is present", /if\s*\(element\s*&&\s*element\.familyId\)/.test(ppInstSrc));
check("family-instance", "property palette offers a Type dropdown", /selType\s*=\s*document\.createElement\("select"\)/.test(ppInstSrc));
check("family-instance", "property palette calls syncFamilyInstances on change", /syncFamilyInstances\?\.\(fam\.id/.test(ppInstSrc));
// ---- openbim-family-placement (Step 2 milestone) ----

const placementSrc = read("src/modules/families/placement.ts") || "";

check("family-placement", "placement module exists", placementSrc.length > 0);

check("family-placement", "exports resolvePlacement", /export function resolvePlacement/.test(placementSrc));

check("family-placement", "exports applyResolvedParams", /export function applyResolvedParams/.test(placementSrc));

check("family-placement", "exports editFamilyParameter", /export function editFamilyParameter/.test(placementSrc));

check("family-placement", "exposes GEOMETRY_KEYS whitelist", /export const GEOMETRY_KEYS/.test(placementSrc));

check("family-placement", "routes instance-scope edits", /scope === "instance"/.test(placementSrc));

check("family-placement", "routes type-scope edits", /scope === "type"/.test(placementSrc));

check("family-placement", "calls syncFamilyInstances for type edits", /syncFamilyInstances/.test(placementSrc));

const authPlaceSrc = read("src/features/authoring.ts") || "";

check("family-placement", "authoring consults family at place-time", /openbim-family-placement/.test(authPlaceSrc));

check("family-placement", "authoring spreads familyGeometry into params", /\.\.\.familyGeometry/.test(authPlaceSrc));

const ppPlaceSrc = read("src/features/property-palette.ts") || "";

check("family-placement", "palette exposes family parameter table", /openbim-family-placement/.test(ppPlaceSrc));

check("family-placement", "palette shows I/T scope badges", /p\.scope === "type" \? "T" : "I"/.test(ppPlaceSrc));

// ---- openbim-family-placement (alignment pass) ----

const famTypesSrc = read("src/modules/families/types.ts") || "";

check("family-alignment", "FamilyParameter has label field", /label\?:\s*string/.test(famTypesSrc));

const famBuiltinSrc = read("src/modules/families/builtin-families.ts") || "";

check("family-alignment", "slab family uses element-native height key", /name: "height", label: "Thickness"/.test(famBuiltinSrc));

check("family-alignment", "slab geometry ref renamed", /h: REF\("height"\)/.test(famBuiltinSrc));

check("family-alignment", "duct family renamed width -> thickness", /name: "thickness", label: "Width"/.test(famBuiltinSrc));

check("family-alignment", "pipe family renamed diameter -> thickness", /name: "thickness", label: "Diameter"/.test(famBuiltinSrc));

check("family-alignment", "cable-tray renamed width/depth -> thickness/height",

  /name: "thickness", label: "Width"/.test(famBuiltinSrc) &&

  /name: "height", label: "Depth"/.test(famBuiltinSrc));

check("family-alignment", "conduit renamed diameter -> thickness", /label: "Diameter"/.test(famBuiltinSrc));

check("family-alignment", "equipment renamed width -> thickness", /label: "Width"/.test(famBuiltinSrc));

const famBrowserSrc = read("src/features/family-browser.ts") || "";

check("family-alignment", "family browser renders label ?? name", /esc\(p\.label \?\? p\.name\)/.test(famBrowserSrc));

const famPaletteSrc = read("src/features/property-palette.ts") || "";

check("family-alignment", "property palette renders label ?? name", /lbl\.textContent = p\.label \?\? p\.name/.test(famPaletteSrc));

// ---- openbim-family-placement (geometry self-consistency) ----

const famNumRefSrc = read("src/modules/families/types.ts") || "";

check("family-geometry", "NumberRef has { expr } variant", /\{\s*expr\s*:\s*string\s*\}/.test(famNumRefSrc));

const famEngineSrc = read("src/modules/families/formula-engine.ts") || "";

check("family-geometry", "formula-engine exports evaluateFormula", /export function evaluateFormula/.test(famEngineSrc));

const famGeomSrc = read("src/modules/families/parametric-geometry.ts") || "";

check("family-geometry", "resolveNumber handles expr", /"expr" in ref/.test(famGeomSrc));

check("family-geometry", "resolveNumber imports evaluateFormula", /import \{ evaluateFormula \}/.test(famGeomSrc));

const famBuiltinGeomSrc = read("src/modules/families/builtin-families.ts") || "";

check("family-geometry", "pipe preview radius = thickness / 2", /r: \{ expr: "thickness \/ 2" \}/.test(famBuiltinGeomSrc));

check("family-geometry", "no preview uses r: { ref: thickness }", !/r: \{ ref: "thickness" \}/.test(famBuiltinGeomSrc));

// ---- openbim-fix:workspace-layout ----
const wsSrc = read("src/modules/workspace-layout.ts") || "";
check("workspace", "workspace-layout module exists", wsSrc.length > 0);
check("workspace", "exposes registerWorkspacePanel", /export function registerWorkspacePanel/.test(wsSrc));
check("workspace", "exposes restoreWorkspace", /export function restoreWorkspace/.test(wsSrc));
check("workspace", "exposes saveWorkspace", /export function saveWorkspace/.test(wsSrc));
check("workspace", "exposes resetWorkspace", /export function resetWorkspace/.test(wsSrc));
check("workspace", "uses obs.workspace.layout.v1 storage key", /obs\.workspace\.layout\.v1/.test(wsSrc));
check("workspace", "defaultOpen falls back to false", /defaultOpen \?\? false/.test(wsSrc));
check("workspace", "installs beforeunload save hook", /beforeunload/.test(wsSrc));

const wbSrc = read("src/features/workspace-boot.ts") || "";
check("workspace", "workspace-boot module exists", wbSrc.length > 0);
check("workspace", "registers projectBrowser", /reg\("projectBrowser"/.test(wbSrc));
check("workspace", "registers propertyPalette", /reg\("propertyPalette"/.test(wbSrc));
check("workspace", "registers criticalGapsToolbar via window global", /__obsCriticalGapsUI/.test(wbSrc));
check("workspace", "registers workspace.reset command", /id: "workspace\.reset"/.test(wbSrc));
check("workspace", "registers workspace.showAll command", /id: "workspace\.showAll"/.test(wbSrc));

const mainWsSrc = read("src/main.ts") || "";
check("workspace", "main.ts boots workspace-layout", /step\("workspace-layout"/.test(mainWsSrc));
check("workspace", "main.ts imports setupWorkspaceLayout", /setupWorkspaceLayout/.test(mainWsSrc));

const pbSrc = read("src/features/project-browser.ts") || "";
check("workspace", "project-browser registers ctx.features.projectBrowser", /ctx\.features\.projectBrowser\s*=/.test(pbSrc));
const btSrc = read("src/features/bim-toolbox.ts") || "";
check("workspace", "bim-toolbox registers ctx.features.bimToolbox", /ctx\.features\.bimToolbox\s*=/.test(btSrc));
// ---- openbim-fix:lod-always-on ----
const lodSrc = read("src/features/lod-manager.ts") || "";
check("lod", "lod culling disabled by design constant", /LOD_CULLING_DISABLED\s*=\s*true/.test(lodSrc));
check("lod", "applyLod short-circuits when disabled", /LOD_CULLING_DISABLED\s*\|\|\s*!enabled/.test(lodSrc));
check("lod", "isLodEnabled reports always-on", /openbim-fix:lod-always-on/.test(lodSrc));
// ---- openbim-fix:ribbon-persist ----
const rpSrc = read("src/features/ribbon-persist.ts") || "";
check("ribbon-persist", "module exists", rpSrc.length > 0);
check("ribbon-persist", "exports setupRibbonPersist", /export function setupRibbonPersist/.test(rpSrc));
check("ribbon-persist", "uses obs.ribbon.state.v1 storage key", /obs\.ribbon\.state\.v1/.test(rpSrc));
check("ribbon-persist", "uses MutationObserver to discover the ribbon", /new MutationObserver/.test(rpSrc));
check("ribbon-persist", "delegates clicks at capture phase", /addEventListener\("click", onRibbonClick, true\)/.test(rpSrc));
check("ribbon-persist", "saves on beforeunload", /beforeunload/.test(rpSrc));
check("ribbon-persist", "exposes __obsRibbonPersist", /__obsRibbonPersist/.test(rpSrc));
const mainRpSrc = read("src/main.ts") || "";
check("ribbon-persist", "main.ts imports setupRibbonPersist", /setupRibbonPersist/.test(mainRpSrc));
check("ribbon-persist", "main.ts boots ribbon-persist", /step\("ribbon-persist"/.test(mainRpSrc));
// ---- openbim-fix:status-bar-extras ----
const sbSrc = read("src/features/status-bar-extras.ts") || "";
check("status-bar", "module exists", sbSrc.length > 0);
check("status-bar", "exports setupStatusBarExtras", /export function setupStatusBarExtras/.test(sbSrc));
check("status-bar", "renders a selection segment", /ensureSegment\(bar, "selection"/.test(sbSrc));
check("status-bar", "renders a level segment", /ensureSegment\(bar, "level"/.test(sbSrc));
check("status-bar", "renders a tool segment", /ensureSegment\(bar, "tool"/.test(sbSrc));
check("status-bar", "renders a locale segment", /ensureSegment\(bar, "locale"/.test(sbSrc));
check("status-bar", "subscribes to selection changes", /selection\.onChange\(renderSelection\)/.test(sbSrc));
check("status-bar", "subscribes to level changes", /levels\.onChange\(renderLevel\)/.test(sbSrc));
check("status-bar", "exposes __obsStatusBar", /__obsStatusBar/.test(sbSrc));
const mainSbSrc = read("src/main.ts") || "";
check("status-bar", "main.ts imports setupStatusBarExtras", /setupStatusBarExtras/.test(mainSbSrc));
check("status-bar", "main.ts boots status-bar-extras", /step\("status-bar-extras"/.test(mainSbSrc));
// ---- openbim-fix:pp-theme ----
// [auto-fix] duplicate declaration removed: const ppSrc = read("src/features/property-palette.ts") || "";
check("pp-theme", "installPaletteTheme helper present", /function installPaletteTheme/.test(ppSrc));
check("pp-theme", "style element id is obs-pp-theme", /obs-pp-theme/.test(ppSrc));
check("pp-theme", "defines --obs-pp-warn-fg", /--obs-pp-warn-fg/.test(ppSrc));
check("pp-theme", "defines --obs-pp-type-bg", /--obs-pp-type-bg/.test(ppSrc));
check("pp-theme", "defines --obs-pp-type-fg", /--obs-pp-type-fg/.test(ppSrc));
check("pp-theme", "defines --obs-pp-inst-bg", /--obs-pp-inst-bg/.test(ppSrc));
check("pp-theme", "defines --obs-pp-inst-fg", /--obs-pp-inst-fg/.test(ppSrc));
check("pp-theme", "setupPropertyPalette calls installPaletteTheme",
  /setupPropertyPalette\(\)\s*:\s*void\s*\{[\s\S]{0,200}?installPaletteTheme\(\)/.test(ppSrc));
check("pp-theme", "type badge uses var(--obs-pp-type-fg)",
  /var\(--obs-pp-type-fg/.test(ppSrc));
check("pp-theme", "type badge no longer has bare color:#7dd3fc",
  !/color:#7dd3fc[";]/.test(ppSrc));
check("pp-theme", "instance badge no longer has bare color:#c4b5fd",
  !/color:#c4b5fd[";]/.test(ppSrc));
const byGroup = {};
for (const r of results) {
  (byGroup[r.group] ||= []).push(r);
}

let pass = 0;
let fail = 0;
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RST = "\x1b[0m";

console.log("");
console.log("Open BIM Studio - Input / Focus / Emoji / Build regression guard");
console.log("root: " + root);
console.log("");

for (const g of Object.keys(byGroup)) {
  console.log(DIM + "[" + g + "]" + RST);
  for (const r of byGroup[g]) {
    if (r.ok) pass++; else fail++;
    const tag = r.ok ? GREEN + "PASS" + RST : RED + "FAIL" + RST;
    const extra = r.ok || !r.detail ? "" : "  " + DIM + r.detail + RST;
    console.log("  " + tag + "  " + r.name + extra);
  }
  console.log("");
}

console.log(
  (fail === 0 ? GREEN : RED) +
  (fail === 0 ? "REGRESSION GUARD OK" : "REGRESSION GUARD FAILED") +
  RST + "  (" + pass + " passed, " + fail + " failed)",
);
console.log("");

// ---------------------------------------------------------------------------
// Self-install: npm run verify
// ---------------------------------------------------------------------------
if (pkg && pkg.scripts) {
  const desired = "node scripts/verify-input-focus.mjs";
  if (pkg.scripts.verify !== desired) {
    pkg.scripts.verify = desired;
    fs.writeFileSync(full("package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
    console.log("Installed npm script:  npm run verify");
    console.log("");
  }
}

process.exit(fail === 0 ? 0 : 1);