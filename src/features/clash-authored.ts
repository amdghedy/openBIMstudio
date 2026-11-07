/**
 * Native (authored) elements as clash items. The authoring tools keep their
 * elements as Three.js meshes in one group, outside the IFC fragment models,
 * so the engine needs this adapter to see them.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import type { Tri } from "../modules/clash/geometry";

/** Pseudo model id used in clash results for authored elements. */
export const AUTHORED_MODEL_ID = "__authored__";

const idToLocal = new Map<string, number>();
const localToId = new Map<number, string>();

/** Stable numeric id for an authored element id (clash refs use numbers). */
export function authoredLocalId(elementId: string): number {
  let n = idToLocal.get(elementId);
  if (n == null) { n = idToLocal.size + 1; idToLocal.set(elementId, n); localToId.set(n, elementId); }
  return n;
}
export function authoredElementId(localId: number): string | undefined { return localToId.get(localId); }

export interface AuthoredClashSource {
  elementId: string;
  localId: number;
  name: string;
  /** e.g. NATIVE_wall, matching the category dialog. */
  category: string;
  box: THREE.Box3;
  tris: Tri[];
}

/** Triangles of one mesh in world space. Skips lines/points and degenerate meshes. */
export function meshWorldTriangles(mesh: THREE.Mesh): Tri[] {
  const geo = mesh.geometry as THREE.BufferGeometry | undefined;
  const pos = geo?.attributes?.position as THREE.BufferAttribute | undefined;
  if (!pos) return [];
  const idx = geo!.index as THREE.BufferAttribute | null;
  const m = mesh.matrixWorld;
  const v = new THREE.Vector3();
  const out: Tri[] = [];
  const count = idx ? idx.count : pos.count;
  for (let i = 0; i + 2 < count; i += 3) {
    const t = new Float32Array(9);
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx.getX(i + k) : i + k;
      v.fromBufferAttribute(pos, vi).applyMatrix4(m);
      t[k * 3] = v.x; t[k * 3 + 1] = v.y; t[k * 3 + 2] = v.z;
    }
    out.push(t);
  }
  return out;
}

export function boxOfTriangles(tris: readonly Tri[]): THREE.Box3 {
  const b = new THREE.Box3();
  for (const t of tris) for (let k = 0; k < 3; k++) b.expandByPoint(new THREE.Vector3(t[k * 3], t[k * 3 + 1], t[k * 3 + 2]));
  return b;
}

/** Every authored element that currently has solid geometry in the scene. */
export function collectAuthoredSources(): AuthoredClashSource[] {
  const auth: any = (ctx.features as any)?.authoring;
  if (!auth?.getElements || !auth?.getAuthoredGroup) return [];
  const group: THREE.Object3D = auth.getAuthoredGroup();
  const elements: Array<{ id: string; type: string; name?: string }> = auth.getElements() ?? [];
  const byId = new Map(elements.map((e) => [e.id, e]));
  try { group.updateMatrixWorld(true); } catch { /* */ }

  const perElement = new Map<string, Tri[]>();
  group.traverse((o: any) => {
    if (!o?.isMesh) return;
    let id: string | null = null;
    for (let p: THREE.Object3D | null = o; p && !id; p = p.parent) if (p.userData?.elementId) id = String(p.userData.elementId);
    if (!id || !byId.has(id)) return;
    const tris = meshWorldTriangles(o as THREE.Mesh);
    if (!tris.length) return;
    const list = perElement.get(id) ?? [];
    for (const t of tris) list.push(t);
    perElement.set(id, list);
  });

  const out: AuthoredClashSource[] = [];
  for (const [id, tris] of perElement) {
    const el = byId.get(id)!;
    const box = boxOfTriangles(tris);
    if (box.isEmpty()) continue;
    out.push({ elementId: id, localId: authoredLocalId(id), name: el.name || `${el.type} ${id}`, category: `NATIVE_${String(el.type).toLowerCase()}`, box, tris });
  }
  return out;
}
