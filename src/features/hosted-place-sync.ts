import * as THREE from "three";
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

    let target: Any | null = null;
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
