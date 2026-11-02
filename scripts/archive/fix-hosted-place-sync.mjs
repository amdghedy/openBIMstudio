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
// 1. NEW owned module: hosted-place-sync.ts
// ---------------------------------------------------------------------------
const PS_REL = "src/features/hosted-place-sync.ts";
const PS_SRC = `import * as THREE from "three";
import { ctx } from "../core/context";

type Any = Record<string, any>;

function c(): Any {
  return (ctx as Any) || (window as Any).__OBS_CTX__ || {};
}

function getAuthoring(): Any | null {
  const cont = c();
  return (cont.features as Any)?.authoring ?? (window as Any).__obsAuthoring ?? null;
}

// place-sync: reconcile hosted door/window mesh transforms to the SAME
// offsetAlongHost the wall hole and the authored grips use, after every
// rebuild. buildDoor/buildWindow build in local coords; placeHostedElement
// applies the world transform. If that transform is derived from a positional
// field the placement commit never provides, the mesh floats off the host
// while the hole stays correct. This re-places the group from offsetAlongHost
// using the author's own basis convention (makeBasis(dir, up, normal)), so
// door == hole == on-wall, deterministically, without touching the builders.
export function syncHostedPlacement(): number {
  const auth = getAuthoring();
  if (!auth) return 0;

  const els: Any[] =
    typeof auth.getElements === "function"
      ? auth.getElements() ?? []
      : Array.isArray(auth.elements)
        ? auth.elements
        : [];

  const group: Any =
    typeof auth.getAuthoredGroup === "function"
      ? auth.getAuthoredGroup()
      : auth.group ?? auth.root ?? auth.three;

  if (!group || typeof group.traverse !== "function" || !Array.isArray(group.children)) {
    return 0;
  }

  const walls = new Map<string, Any>();
  for (const e of els) {
    if (e && e.type === "wall" && e.params?.start && e.params?.end) {
      walls.set(String(e.id), e);
    }
  }

  const up = new THREE.Vector3(0, 1, 0);
  let synced = 0;

  for (const d of els) {
    if (!d || (d.type !== "door" && d.type !== "window") || !d.hostId) continue;
    const host = walls.get(String(d.hostId));
    if (!host) continue;

    const hp = host.params;
    const ax = Number(hp.start[0]);
    const az = Number(hp.start[1]);
    const bx = Number(hp.end[0]);
    const bz = Number(hp.end[1]);
    const dx = bx - ax;
    const dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (!(L > 1e-6)) continue;

    const ux = dx / L;
    const uz = dz / L;
    const off = Number(d.params?.offsetAlongHost ?? L / 2);
    if (!Number.isFinite(off)) continue;

    const dir = new THREE.Vector3(ux, 0, uz);
    const normal = new THREE.Vector3(-uz, 0, ux);
    const basis = new THREE.Matrix4().makeBasis(dir, up, normal);
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis);

    const elev = Number(hp.elevation ?? 0);
    const sill = Number(d.params?.sillHeight ?? (d.type === "window" ? 0.9 : 0));
    const px = ax + ux * off;
    const pz = az + uz * off;
    const py = (Number.isFinite(elev) ? elev : 0) + (Number.isFinite(sill) ? sill : 0);

    let target: Any = null;
    for (const child of group.children) {
      let hit = false;
      try {
        child.traverse((m: Any) => {
          if (m?.isMesh && m?.userData?.elementId === d.id) hit = true;
        });
      } catch {
        /* ignore */
      }
      if (hit) {
        target = child;
        break;
      }
    }
    if (!target) continue;

    try {
      target.position.set(px, py, pz);
      target.quaternion.copy(quat);
      target.updateMatrix?.();
      synced++;
    } catch {
      /* ignore */
    }
  }

  return synced;
}

(window as Any).__obsSyncHostedPlacement = syncHostedPlacement;

export function setupHostedPlaceSync(): void {
  (window as Any).__obsSyncHostedPlacement = syncHostedPlacement;
  console.log(
    "[hosted-place-sync] ready: reconciles hosted door/window meshes to clamped offsetAlongHost after every rebuild",
  );
}
`;

function writePlaceSync() {
  const cur = read(PS_REL);
  if (cur && cur.includes("place-sync: reconcile hosted")) {
    console.log("  NO CHANGE: hosted-place-sync.ts already present");
    return;
  }
  backup(PS_REL);
  fs.mkdirSync(path.dirname(full(PS_REL)), { recursive: true });
  fs.writeFileSync(full(PS_REL), PS_SRC, "utf8");
  console.log("  OK: " + PS_REL + " (new owned module)");
}

// ---------------------------------------------------------------------------
// 2. authoring.ts : ONE anchored insert in rebuild() after refreshGrips();
//    No import added. Marker: "hosted-place-sync:". Idempotent.
// ---------------------------------------------------------------------------
const AUTH_REL = "src/features/authoring.ts";
const AUTH_MARKER = "hosted-place-sync:";

function patchAuthoringRebuild() {
  if (!exists(AUTH_REL)) { console.log("  SKIP: " + AUTH_REL + " not found"); return; }
  let src = read(AUTH_REL) || "";
  if (src.includes(AUTH_MARKER)) { console.log("  NO CHANGE: authoring.ts rebuild already calls place-sync"); return; }

  const re = /(\n([ \t]*)refreshGrips\(\);)(\s*\n[ \t]*\})/;
  if (!re.test(src)) { console.log("  SKIP: rebuild() refreshGrips anchor not matched"); return; }

  const insert =
    "$1\n$2// hosted-place-sync: reconcile hosted door/window mesh transforms to the\n" +
    "$2// clamped offsetAlongHost (same source as the wall hole) so a freshly placed\n" +
    "$2// opening cannot float off its host. No-op if the module is not loaded.\n" +
    "$2(window as any).__obsSyncHostedPlacement?.();$3";

  src = src.replace(re, insert);
  backup(AUTH_REL);
  fs.writeFileSync(full(AUTH_REL), src, "utf8");
  console.log("  PATCHED: authoring.ts rebuild() -> +1 line place-sync call (no builder change)");
}

// ---------------------------------------------------------------------------
// 3. critical-gaps-boot.ts : wire hosted-place-sync (dynamic import pattern).
// ---------------------------------------------------------------------------
const BOOT_REL = "src/critical-gaps-boot.ts";
const BOOT_TOKEN = "hosted-place-sync";

function patchBoot() {
  if (!exists(BOOT_REL)) { console.log("  SKIP: " + BOOT_REL + " not found"); return; }
  let src = read(BOOT_REL) || "";
  if (src.includes(BOOT_TOKEN)) { console.log("  NO CHANGE: boot already wires hosted-place-sync"); return; }

  const anchor = '  await safe("critical-gaps-ui", setupCriticalGapsUI);';
  if (!src.includes(anchor)) { console.log("  SKIP: boot critical-gaps-ui anchor not found"); return; }

  const inject =
    '  await safe("hosted-place-sync", async () => {\n' +
    '    await import("./features/hosted-place-sync");\n' +
    "  });\n\n" +
    anchor;

  src = src.replace(anchor, inject);
  backup(BOOT_REL);
  fs.writeFileSync(full(BOOT_REL), src, "utf8");
  console.log("  PATCHED: boot wires hosted-place-sync");
}

// ---------------------------------------------------------------------------
// 4. Extend the regression guard with a [place-sync] group. Marker idempotent.
// ---------------------------------------------------------------------------
const GUARD_REL = "scripts/verify-input-focus.mjs";
const GUARD_MARKER = "place-sync contract";

const BLOCK = [
  "// ---- " + GUARD_MARKER + " (added by Fix-Hosted-Place-Sync) ----",
  'const psSrc = read("src/features/hosted-place-sync.ts") || "";',
  'check("place-sync", "hosted-place-sync module exists", psSrc.length > 0);',
  'check("place-sync", "sets __obsSyncHostedPlacement", /__obsSyncHostedPlacement\\s*=/.test(psSrc));',
  'check("place-sync", "reconciles from offsetAlongHost (same source as hole)", /offsetAlongHost/.test(psSrc));',
  'check("place-sync", "uses author basis makeBasis(dir, up, normal)", /makeBasis\\(\\s*dir,\\s*up,\\s*normal\\s*\\)/.test(psSrc));',
  'check("place-sync", "authoring rebuild calls the sync", /__obsSyncHostedPlacement\\?\\.\\(\\)/.test(read("src/features/authoring.ts") || ""));',
  'check("place-sync", "boot wires hosted-place-sync", /hosted-place-sync/.test(read("src/critical-gaps-boot.ts") || ""));',
  "",
].join("\n");

function patchGuard() {
  if (!exists(GUARD_REL)) { console.log("  SKIP: " + GUARD_REL + " not found"); return; }
  let src = read(GUARD_REL) || "";
  if (src.includes(GUARD_MARKER)) { console.log("  NO CHANGE: guard already has place-sync checks"); return; }
  const anchor = "const byGroup = {};";
  const idx = src.indexOf(anchor);
  if (idx < 0) { console.log("  SKIP: guard report anchor not found"); return; }
  backup(GUARD_REL);
  src = src.slice(0, idx) + BLOCK + src.slice(idx);
  fs.writeFileSync(full(GUARD_REL), src, "utf8");
  console.log("  PATCHED: guard appended [place-sync] group");
}

console.log("");
console.log("Applying hosted place-sync patch...");
console.log("");
writePlaceSync();
patchAuthoringRebuild();
patchBoot();
patchGuard();
console.log("");
console.log("Place-sync patch applied. Builders (buildDoor/buildWindow/placeHostedElement/wallAtPoint) were NOT modified.");