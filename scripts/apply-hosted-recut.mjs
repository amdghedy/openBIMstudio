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
// 1. authoring.ts : clamp openings to the host's CURRENT length at read time,
//    and write the clamp back to the hosted element params so the door/window
//    mesh and the wall hole agree in the SAME rebuild pass (no flicker, no
//    float, every rebuild path covered). Whitespace-robust, idempotent.
// ---------------------------------------------------------------------------
const AUTH_REL = "src/features/authoring.ts";
const MARKER = "hosted-recut: clamp each opening";

const NEW_FN = `function openingsForWall(wallId: string): WallOpening[] {
  // hosted-recut: clamp each opening to the host's CURRENT length so a moved or
  // resized wall re-cuts its door/window holes in-bounds on every rebuild, and
  // write the clamp back to the hosted element params so the door/window mesh
  // (built from the same offsetAlongHost) stays glued to the wall in one pass.
  const out: WallOpening[] = [];
  const wall = elements.find((e) => e.id === wallId);
  const wp = wall?.params;
  let L = 0;
  let ax = 0, az = 0, dx = 0, dz = 0;
  if (wp && wp.start && wp.end) {
    ax = wp.start[0]; az = wp.start[1];
    dx = wp.end[0] - ax; dz = wp.end[1] - az;
    L = Math.hypot(dx, dz);
  }
  const angle = L > 1e-6 ? Math.atan2(dz, dx) : 0;
  for (const el of getHostedForWall(wallId)) {
    const p = el.params;
    const w = p.width ?? DEFAULTS[el.type]?.width ?? 0.9;
    const h = p.height;
    const sill = el.type === "window" ? (p.sillHeight ?? 0.9) : (p.sillHeight ?? 0);
    let offset = p.offsetAlongHost ?? (L > 0 ? L / 2 : 0);
    if (L > 1e-6) {
      const half = w / 2;
      if (L <= w + 0.02) offset = L / 2;
      else offset = Math.max(half, Math.min(L - half, offset));
      offset = Math.round(offset * 1000) / 1000;
      p.offsetAlongHost = offset;
      const t01 = offset / L;
      const cx = ax + dx * t01;
      const cz = az + dz * t01;
      if ("x" in p) p.x = Math.round(cx * 1000) / 1000;
      if ("z" in p) p.z = Math.round(cz * 1000) / 1000;
      if ("hostAngle" in p) p.hostAngle = Math.round(angle * 10000) / 10000;
      if ("rotation" in p) p.rotation = p.hostAngle;
      if ("angle" in p) p.angle = p.hostAngle;
    }
    out.push({ offset, width: w, height: h, sill });
  }
  return out;
}`;

function patchAuthoring() {
  if (!exists(AUTH_REL)) { console.log("  SKIP: " + AUTH_REL + " not found"); return false; }
  let src = read(AUTH_REL);
  if (src.includes(MARKER)) { console.log("  NO CHANGE: authoring.ts already has hosted-recut clamp"); return false; }

  // Match the whole openingsForWall function: signature ... first column-0 closing brace.
  const re = /function openingsForWall\(wallId: string\): WallOpening\[\] \{[\s\S]*?\n\}/;
  if (!re.test(src)) { console.log("  SKIP: openingsForWall anchor not matched (paste the raw function if so)"); return false; }

  backup(AUTH_REL);
  src = src.replace(re, NEW_FN);
  fs.writeFileSync(full(AUTH_REL), src, "utf8");
  console.log("  PATCHED: authoring.ts openingsForWall -> clamp-to-host-length at read");
  return true;
}

// ---------------------------------------------------------------------------
// 2. Extend the regression guard with a [hosted-recut] check group, inserted
//    right before the report section. Idempotent.
// ---------------------------------------------------------------------------
const GUARD_REL = "scripts/verify-input-focus.mjs";
const GUARD_MARKER = "hosted-recut contract";

const GUARD_BLOCK = `// ---- hosted-recut contract (added by Apply-Hosted-Recut) ----
const authSrc = read("src/features/authoring.ts") || "";
check("hosted-recut", "openingsForWall clamps offset to host length", /hosted-recut: clamp each opening/.test(authSrc));
check("hosted-recut", "openingsForWall writes clamp back to p.offsetAlongHost", /p\\.offsetAlongHost\\s*=\\s*offset/.test(authSrc));
check("hosted-recut", "wall build still dispatches openings to builder", /openingsForWall\\(el\\.id\\)/.test(authSrc) && /buildWallWithOpenings\\(el, openings\\)/.test(authSrc));
check("hosted-recut", "legacy builder still cuts holes from openings", /for \\(const op of openings\\)/.test(authSrc) && /new THREE\\.Path\\(\\)/.test(authSrc));
const owCount = (authSrc.match(/function openingsForWall/g) || []).length;
check("hosted-recut", "exactly one openingsForWall definition (no duplicate owner)", owCount === 1, "found " + owCount);
check("hosted-recut", "constraint-solver still exports solveHostedConstraints", /export function solveHostedConstraints/.test(read("src/features/constraint-solver.ts") || ""));

`;

function patchGuard() {
  if (!exists(GUARD_REL)) { console.log("  SKIP: " + GUARD_REL + " not found (run Add-Regression-Guard.ps1 first)"); return false; }
  let src = read(GUARD_REL);
  if (src.includes(GUARD_MARKER)) { console.log("  NO CHANGE: guard already has hosted-recut checks"); return false; }

  const anchor = "const byGroup = {};";
  const idx = src.indexOf(anchor);
  if (idx < 0) { console.log("  SKIP: guard report anchor not found"); return false; }

  backup(GUARD_REL);
  src = src.slice(0, idx) + GUARD_BLOCK + src.slice(idx);
  fs.writeFileSync(full(GUARD_REL), src, "utf8");
  console.log("  PATCHED: guard extended with [hosted-recut] checks");
  return true;
}

console.log("");
console.log("Applying hosted re-cut patch...");
console.log("");
patchAuthoring();
patchGuard();
console.log("");
console.log("Hosted re-cut patch applied (IFC authored-void export intentionally deferred).");