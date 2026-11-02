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
// openingsForWall : keep last turn's clamp + write-back + hostAngle TS fix,
// and ADD a full-face skip so a wall can never be hollowed into a frame.
// Markers: "hosted-recut: clamp each opening" (old) + "skip full-face opening" (new).
// ---------------------------------------------------------------------------
const AUTH_REL = "src/features/authoring.ts";
const NEW_MARKER = "hosted-recut: skip full-face opening";

const NEW_FN = `function openingsForWall(wallId: string): WallOpening[] {
  // hosted-recut: clamp each opening to the host's CURRENT length so a moved or
  // resized wall re-cuts its door/window holes in-bounds on every rebuild, and
  // write the clamp back to the hosted element params so the door/window mesh
  // (built from the same offsetAlongHost) stays glued to the wall in one pass.
  // hosted-recut: skip full-face opening so a bad/degenerate opening can never
  // hollow the wall solid into a thin frame (the door mesh still draws on top).
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
  const H = Number(wp?.height ?? 3);
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
      const hostAngle = Math.round(angle * 10000) / 10000;
      if ("hostAngle" in p) (p as any).hostAngle = hostAngle;
      if ("rotation" in p) (p as any).rotation = hostAngle;
      if ("angle" in p) (p as any).angle = hostAngle;
    }
    // full-face skip: compute the hole rect exactly as the legacy builder does,
    // and drop the opening if it would erase >= 90% of the wall face.
    const u0 = Math.max(0, offset - w / 2);
    const u1 = Math.min(L, offset + w / 2);
    const v0 = Math.max(0, sill);
    const v1 = Math.min(H, sill + h);
    const holeW = u1 - u0;
    const holeH = v1 - v0;
    const degenerate = holeW < 0.02 || holeH < 0.02;
    const fullFace = L > 0.05 && H > 0.05 && holeW >= L * 0.9 && holeH >= H * 0.9;
    if (degenerate || fullFace) continue;
    out.push({ offset, width: w, height: h, sill });
  }
  return out;
}`;

function patchAuthoring() {
  if (!exists(AUTH_REL)) { console.log("  SKIP: " + AUTH_REL + " not found"); return; }
  let src = read(AUTH_REL) || "";
  if (src.includes(NEW_MARKER)) { console.log("  NO CHANGE: openingsForWall already hardened (full-face skip)"); return; }
  const re = /function openingsForWall\(wallId: string\): WallOpening\[\] \{[\s\S]*?\n\}/;
  if (!re.test(src)) { console.log("  SKIP: openingsForWall anchor not matched"); return; }
  backup(AUTH_REL);
  src = src.replace(re, NEW_FN);
  fs.writeFileSync(full(AUTH_REL), src, "utf8");
  console.log("  PATCHED: authoring.ts openingsForWall -> + full-face skip (wall can never hollow)");
}

// ---------------------------------------------------------------------------
// Extend the regression guard with a [recut-hardening] group. Marker idempotent.
// ---------------------------------------------------------------------------
const GUARD_REL = "scripts/verify-input-focus.mjs";
const GUARD_MARKER = "recut hardening contract";

const BLOCK = [
  "// ---- " + GUARD_MARKER + " (added by Harden-Hosted-Recut) ----",
  'const authH = read("src/features/authoring.ts") || "";',
  'check("recut-hardening", "openingsForWall keeps clamp marker", /hosted-recut: clamp each opening/.test(authH));',
  'check("recut-hardening", "openingsForWall has full-face skip", /hosted-recut: skip full-face opening/.test(authH));',
  'check("recut-hardening", "skip drops degenerate OR full-face holes", /degenerate\\s*\\|\\|\\s*fullFace/.test(authH) && /holeW >= L \\* 0\\.9 && holeH >= H \\* 0\\.9/.test(authH));',
  'check("recut-hardening", "hostAngle TS narrowing fix still present", /const hostAngle = Math\\.round\\(angle \\* 10000\\) \\/ 10000;/.test(authH) && /\\(p as any\\)\\.rotation = hostAngle/.test(authH));',
  'const owN = (authH.match(/function openingsForWall/g) || []).length;',
  'check("recut-hardening", "exactly one openingsForWall definition", owN === 1, "found " + owN);',
  "",
].join("\n");

function patchGuard() {
  if (!exists(GUARD_REL)) { console.log("  SKIP: " + GUARD_REL + " not found"); return; }
  let src = read(GUARD_REL) || "";
  if (src.includes(GUARD_MARKER)) { console.log("  NO CHANGE: guard already has recut-hardening checks"); return; }
  const anchor = "const byGroup = {};";
  const idx = src.indexOf(anchor);
  if (idx < 0) { console.log("  SKIP: guard report anchor not found"); return; }
  backup(GUARD_REL);
  src = src.slice(0, idx) + BLOCK + src.slice(idx);
  fs.writeFileSync(full(GUARD_REL), src, "utf8");
  console.log("  PATCHED: guard appended [recut-hardening] group");
}

console.log("");
console.log("Applying hosted re-cut hardening (owned function only)...");
console.log("");
patchAuthoring();
patchGuard();
console.log("");
console.log("Hardening applied. authoring.ts builders / placement / rebuild were NOT modified.");