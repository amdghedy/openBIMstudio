import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function full(rel) { return path.join(root, rel); }
function exists(rel) { try { fs.accessSync(full(rel)); return true; } catch { return false; } }
function read(rel) { try { return fs.readFileSync(full(rel), "utf8"); } catch { return null; } }
function backup(rel) {
  if (!exists(rel)) return false;
  fs.copyFileSync(full(rel), full(rel) + ".bak-" + stamp);
  console.log("  Backup: " + rel);
  return true;
}

// ---------------------------------------------------------------------------
// 1. constraint-solver.ts : full rewrite -> button-driven, no placement race.
//    Marker: "solver-mode: button-driven". authoring.ts is NOT touched here.
// ---------------------------------------------------------------------------
const CS_REL = "src/features/constraint-solver.ts";
const CS_MARKER = "solver-mode: button-driven";

const CS_NEW = `// solver-mode: button-driven (no pointerup / no auto-rebuild race with placement)
// openingsForWall() in authoring.ts already re-clamps hosted offsets at READ time on
// the single rebuild the placement/move commit performs, so the solver must NOT also
// solve on pointerup. The [S] button calls solveHostedConstraints() deliberately.
import { ctx } from "../core/context";

type Any = Record<string, any>;

let solving = false;

function getFeatures(): Any {
  const c = ctx as Any;
  if (!c.features) c.features = {};
  return c.features as Any;
}

function getAuthoring(): Any | null {
  const f = getFeatures();
  return (f.authoring as Any) ?? (window as Any).__obsAuthoring ?? null;
}

function getElements(): Any[] {
  const a = getAuthoring();
  if (!a) return [];
  if (typeof a.getElements === "function") {
    try { return a.getElements() ?? []; } catch { return []; }
  }
  if (Array.isArray(a.elements)) return a.elements;
  return [];
}

function rebuildAuthoring(): void {
  const a = getAuthoring();
  if (!a) return;
  try {
    if (typeof a.rebuildAuthored === "function") a.rebuildAuthored();
    else if (typeof a.rebuild === "function") a.rebuild();
  } catch { /* ignore */ }
  try {
    if (typeof a.markAuthoringDirty === "function") a.markAuthoringDirty();
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent("obs:authoring-changed", { detail: { reason: "constraint-solver" } }));
  } catch { /* ignore */ }
}

function pair(v: Any): [number, number] | null {
  if (Array.isArray(v) && v.length >= 2) return [Number(v[0]), Number(v[1])];
  if (v && typeof v === "object") {
    if ("x" in v && "z" in v) return [Number(v.x), Number(v.z)];
    if ("x" in v && "y" in v) return [Number(v.x), Number(v.y)];
  }
  return null;
}

export function solveHostedConstraints(): number {
  if (solving) return 0;
  solving = true;
  try {
    const elements = getElements();
    if (!elements.length) return 0;

    const hosts = new Map<string, Any>();
    for (const el of elements) {
      if (!el || !el.id || !el.params) continue;
      const t = String(el.type ?? "");
      if ((t === "wall" || t === "beam" || t === "line" || t === "mline") && el.params.start && el.params.end) {
        hosts.set(String(el.id), el);
      }
    }

    let changed = 0;
    for (const el of elements) {
      if (!el || !el.hostId || !el.params) continue;
      const t = String(el.type ?? "");
      if (t !== "door" && t !== "window" && t !== "opening" && t !== "fitting") continue;

      const host = hosts.get(String(el.hostId));
      if (!host || !host.params) continue;

      const p = el.params as Any;
      const hp = host.params as Any;
      const start = pair(hp.start);
      const end = pair(hp.end);
      if (!start || !end) continue;

      const ax = start[0], az = start[1], bx = end[0], bz = end[1];
      const dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (!Number.isFinite(L) || L < 0.01) continue;

      const half = Number(p.width ?? p.WIDTH ?? 0.9) / 2;
      const current = Number(p.offsetAlongHost ?? p.offset ?? L / 2);
      const min = Math.min(half, L / 2);
      const max = Math.max(L - half, L / 2);
      const clamped = Math.max(min, Math.min(max, current));

      if (typeof p.offsetAlongHost !== "number" || Math.abs(clamped - current) > 1e-4) {
        p.offsetAlongHost = Math.round(clamped * 1000) / 1000;
        changed++;
      }
    }

    if (changed) rebuildAuthoring();
    return changed;
  } finally {
    solving = false;
  }
}

export function setupConstraintSolver(): void {
  const f = getFeatures();
  f.constraintSolver = { solve: solveHostedConstraints };
  (window as Any).__obsSolveHostedConstraints = solveHostedConstraints;
  console.log("[constraint-solver] button-driven ready (no pointerup auto-solve; openingsForWall clamps at read)");
}
`;

function patchConstraintSolver() {
  if (!exists(CS_REL)) { console.log("  SKIP: " + CS_REL + " not found"); return; }
  const cur = read(CS_REL) || "";
  if (cur.includes(CS_MARKER)) { console.log("  NO CHANGE: constraint-solver already button-driven"); return; }
  backup(CS_REL);
  fs.writeFileSync(full(CS_REL), CS_NEW, "utf8");
  console.log("  PATCHED: constraint-solver.ts -> button-driven (race removed)");
}

// ---------------------------------------------------------------------------
// 2. hosted-openings.ts : refreshDownstream -> data-only (no geometry rebuild).
//    Marker: "hosted-openings: data-only refresh".
// ---------------------------------------------------------------------------
const HO_REL = "src/features/hosted-openings.ts";
const HO_MARKER = "hosted-openings: data-only refresh";

function patchHostedOpenings() {
  if (!exists(HO_REL)) { console.log("  SKIP: " + HO_REL + " not found"); return; }
  let src = read(HO_REL) || "";
  if (src.includes(HO_MARKER)) { console.log("  NO CHANGE: hosted-openings already data-only"); return; }

  // Remove the const a = getAuthoring(); + the two rebuild try-blocks at the top
  // of refreshDownstream, leaving only the event dispatches. Tolerant regex.
  const re = /function refreshDownstream\(\): void \{[\s\S]*?try \{\s*\(window as Any\)\.__obsCost\?\.refresh\?\.\(\);\s*\} catch \{[\s\S]*?\}/;
  const m = re.exec(src);
  if (!m) { console.log("  SKIP: hosted-openings refreshDownstream anchor not matched"); return; }

  const replacement =
    "function refreshDownstream(): void {\n" +
    "  // " + HO_MARKER + "\n" +
    "  // 3D openings come from authoring.openingsForWall() at read time; this data\n" +
    "  // layer only refreshes schedules / cost / IFC events. It must NOT rebuild\n" +
    "  // geometry, or it races the placement commit (hollow wall / floating door).\n" +
    "  try {\n" +
    "    (window as Any).__obsProjects?.markDirty?.();\n" +
    "  } catch {\n" +
    "    // ignore\n" +
    "  }\n" +
    "  try {\n" +
    "    (window as Any).__obsSchedules?.refresh?.();\n" +
    "  } catch {\n" +
    "    // ignore\n" +
    "  }\n" +
    "  try {\n" +
    "    (window as Any).__obsCost?.refresh?.();\n" +
    "  } catch {\n" +
    "    // ignore\n" +
    "  }";

  src = src.slice(0, m.index) + replacement + src.slice(m.index + m[0].length);
  backup(HO_REL);
  fs.writeFileSync(full(HO_REL), src, "utf8");
  console.log("  PATCHED: hosted-openings.ts -> data-only refresh (no rebuild)");
}

// ---------------------------------------------------------------------------
// 3. critical-gaps-ui.ts : toolbar horizontal bottom-centered (no palette
//    overlap) + correct [S] tooltip. Marker: "flex-direction: row".
// ---------------------------------------------------------------------------
const UI_REL = "src/features/critical-gaps-ui.ts";

function patchToolbarLayout() {
  if (!exists(UI_REL)) { console.log("  SKIP: " + UI_REL + " not found"); return; }
  let src = read(UI_REL) || "";
  if (/flex-direction:\s*row/.test(src)) { console.log("  NO CHANGE: toolbar already horizontal-centered"); return; }
  const before = src;

  src = src.replace("right: 18px;", "left: 50%;\n  transform: translateX(-50%);");
  src = src.replace("flex-direction: column;", "flex-direction: row;");
  src = src.replace(
    "gap: 8px;",
    "gap: 6px;\n  flex-wrap: wrap;\n  justify-content: center;\n  max-width: calc(100vw - 620px);"
  );
  src = src.replace("width: 190px;", "width: auto;\n  min-width: 132px;");
  src = src.replace(
    "Run parametric hosted-element constraint solver and opening recompute.",
    "Run parametric hosted-element offset solver (clamps offsets + rebuilds once)."
  );

  if (src === before) { console.log("  SKIP: toolbar CSS anchors not matched"); return; }
  backup(UI_REL);
  fs.writeFileSync(full(UI_REL), src, "utf8");
  console.log("  PATCHED: critical-gaps-ui.ts -> horizontal-centered toolbar (no palette overlap)");
}

// ---------------------------------------------------------------------------
// 4. Extend the regression guard: replace the stale sig check + append
//    [derace] + [layout] groups. Marker: "solver de-race contract".
// ---------------------------------------------------------------------------
const GUARD_REL = "scripts/verify-input-focus.mjs";
const GUARD_MARKER = "solver de-race contract";

const OLD_SIG = 'check("sig", "constraint-solver recomputes openings", /recomputeHostedOpenings/.test(read("src/features/constraint-solver.ts") || ""));';
const NEW_SIG = 'check("sig", "constraint-solver is button-driven (no auto recompute)", !/recomputeHostedOpenings/.test(read("src/features/constraint-solver.ts") || "") && /export function solveHostedConstraints/.test(read("src/features/constraint-solver.ts") || ""));';

const DERACE_BLOCK = [
  "// ---- " + GUARD_MARKER + " (added by Fix-Hosted-Placement-Race) ----",
  'const csSrc = read("src/features/constraint-solver.ts") || "";',
  'check("derace", "solver has NO pointerup auto-solve", !/addEventListener\\(\\s*["\']pointerup["\']/.test(csSrc));',
  'check("derace", "solver has NO obs:authoring-changed auto-listener", !/window\\.addEventListener\\(\\s*["\']obs:authoring-changed["\']/.test(csSrc));',
  'check("derace", "solver has NO patchMethod auto-wrap", !/patchMethod\\(/.test(csSrc));',
  'check("derace", "solver solve does NOT call recomputeHostedOpenings", !/recomputeHostedOpenings\\(/.test(csSrc));',
  'check("derace", "solver still exports solveHostedConstraints", /export function solveHostedConstraints/.test(csSrc));',
  'const hoSrc = read("src/features/hosted-openings.ts") || "";',
  'check("derace", "hosted-openings refresh does NOT rebuild geometry", !/rebuildAuthored\\(/.test(hoSrc) && !/\\.rebuild\\(/.test(hoSrc) && !/markAuthoringDirty\\(/.test(hoSrc));',
  'check("derace", "hosted-openings still writes params.openings data", /\\.openings\\s*=/.test(hoSrc));',
  'check("derace", "hosted-openings still refreshes schedules/cost/ifc", /obs:schedule-refresh/.test(hoSrc) && /obs:cost-refresh/.test(hoSrc));',
  'const uiSrc = read("src/features/critical-gaps-ui.ts") || "";',
  'check("layout", "toolbar horizontal bottom-centered (no palette overlap)", /flex-direction:\\s*row/.test(uiSrc) && /translateX\\(-50%\\)/.test(uiSrc) && /max-width:\\s*calc\\(100vw/.test(uiSrc));',
  'check("layout", "toolbar no longer vertical right-anchored", !/flex-direction:\\s*column/.test(uiSrc) && !/right:\\s*18px/.test(uiSrc));',
  "",
].join("\n");

function patchGuard() {
  if (!exists(GUARD_REL)) { console.log("  SKIP: " + GUARD_REL + " not found (run Add-Regression-Guard.ps1 first)"); return; }
  let src = read(GUARD_REL) || "";
  let changed = false;

  if (src.includes(OLD_SIG)) {
    src = src.replace(OLD_SIG, NEW_SIG);
    changed = true;
    console.log("  PATCHED: guard sig check -> button-driven");
  }

  if (!src.includes(GUARD_MARKER)) {
    const anchor = "const byGroup = {};";
    const idx = src.indexOf(anchor);
    if (idx < 0) { console.log("  SKIP: guard report anchor not found"); }
    else {
      src = src.slice(0, idx) + DERACE_BLOCK + src.slice(idx);
      changed = true;
      console.log("  PATCHED: guard appended [derace] + [layout] groups");
    }
  } else {
    console.log("  NO CHANGE: guard already has de-race checks");
  }

  if (changed) {
    backup(GUARD_REL);
    fs.writeFileSync(full(GUARD_REL), src, "utf8");
  }
}

console.log("");
console.log("Applying hosted placement de-race patch (owned files only)...");
console.log("");
patchConstraintSolver();
patchHostedOpenings();
patchToolbarLayout();
patchGuard();
console.log("");
console.log("De-race patch applied. authoring.ts was NOT modified.");