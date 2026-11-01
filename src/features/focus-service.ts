import * as THREE from "three";
import { ctx } from "../core/context";
import { syncOrthoZoom } from "../core/ortho-zoom";

type Any = Record<string, any>;

function w(): Any {
  return window as Any;
}

function c(): Any {
  return (ctx as Any) || w().__OBS_CTX__ || {};
}

function asSet(v: any): Set<number> {
  const out = new Set<number>();

  if (!v) return out;

  if (v instanceof Set) {
    for (const x of v) {
      const n = Number(x);
      if (Number.isFinite(n)) out.add(n);
    }
    return out;
  }

  if (Array.isArray(v)) {
    for (const x of v) {
      const n = Number(x);
      if (Number.isFinite(n)) out.add(n);
    }
    return out;
  }

  if (typeof v === "number" && Number.isFinite(v)) {
    out.add(v);
  }

  return out;
}

function mergeMap(
  target: Record<string, Set<number>>,
  source: any,
): void {
  if (!source || typeof source !== "object") return;

  if (source instanceof Map) {
    for (const [modelId, value] of source.entries()) {
      const ids = asSet(value);
      if (!ids.size) continue;

      const key = String(modelId);

      if (!target[key]) {
        target[key] = new Set<number>();
      }

      for (const id of ids) {
        target[key].add(id);
      }
    }

    return;
  }

  for (const [modelId, value] of Object.entries(source)) {
    const ids = asSet(value);
    if (!ids.size) continue;

    const key = String(modelId);

    if (!target[key]) {
      target[key] = new Set<number>();
    }

    for (const id of ids) {
      target[key].add(id);
    }
  }
}

function getFragmentSelection(): Record<string, Set<number>> {
  const out: Record<string, Set<number>> = {};
  const cont = c();

  const sources: any[] = [
    cont.features?.selection,
    cont.selection,
    cont.highlighter,
    cont.highlighter?.selection,
    cont.features?.selectionManager,
    cont.selectionManager,
    w().__obsSelection,
    w().__obsSelectionManager,
  ];

  for (const s of sources) {
    if (!s) continue;

    let snap: any = null;

    if (typeof s.snapshot === "function") {
      try {
        snap = s.snapshot();
      } catch {
        snap = null;
      }
    }

    if (!snap && s.selection && typeof s.selection === "object") {
      snap = s.selection;
    }

    if (!snap && typeof s === "object" && !(s instanceof Map)) {
      const proto = Object.getPrototypeOf(s);

      if (proto === Object.prototype || proto === null) {
        snap = s;
      }
    }

    if (snap) {
      mergeMap(out, snap);
    }
  }

  return out;
}

function getAuthoredSelection(): string[] {
  const cont = c();
  const auth = cont.features?.authoring || w().__obsAuthoring;

  const raw =
    auth?.getSelectedIds?.() ??
    auth?.selectedIds ??
    auth?.selection ??
    [];

  return Array.from(raw as any)
    .map((x: any) => String(x))
    .filter(Boolean);
}

function boxFromAnyBox(b: any): THREE.Box3 | null {
  if (!b) return null;

  if (b.isBox3) {
    return new THREE.Box3().copy(b);
  }

  if (b.min && b.max) {
    try {
      return new THREE.Box3(
        new THREE.Vector3(b.min.x, b.min.y, b.min.z),
        new THREE.Vector3(b.max.x, b.max.y, b.max.z),
      );
    } catch {
      return null;
    }
  }

  return null;
}

function includeObject(obj: any, box: THREE.Box3): void {
  if (!obj) return;

  if (obj.isMesh) {
    const geo = obj.geometry;

    if (!geo) return;

    if (!geo.boundingBox) {
      try {
        geo.computeBoundingBox();
      } catch {
        return;
      }
    }

    const bb = geo.boundingBox;

    if (bb && !bb.isEmpty()) {
      box.union(bb.clone().applyMatrix4(obj.matrixWorld));
    }

    return;
  }

  if (Array.isArray(obj.children)) {
    for (const child of obj.children) {
      includeObject(child, box);
    }
  }
}

function getAuthoredBox(ids: string[]): THREE.Box3 | null {
  const cont = c();
  const auth = cont.features?.authoring || w().__obsAuthoring;

  if (!auth || !ids.length) return null;

  const idSet = new Set(ids.map(String));
  const box = new THREE.Box3();

  // Prefer live scene meshes (matches what the user actually sees).
  try {
    const group = auth.getAuthoredGroup?.();
    if (group) {
      try { group.updateMatrixWorld?.(true); } catch { /* */ }
      group.traverse((o: Any) => {
        if (!o?.isMesh) return;
        const eid = o.userData?.elementId;
        if (eid == null || !idSet.has(String(eid))) return;
        includeObject(o, box);
      });
      if (!box.isEmpty()) return box;
    }
  } catch { /* fall through */ }

  const elements = auth.getElements?.() ?? auth.elements ?? [];

  for (const id of ids) {
    const el = (elements as any[]).find(
      (x: any) => String(x?.id) === id,
    );

    if (!el) continue;

    const candidates = [
      auth.getElementWorldBox?.(el),
      auth.getWorldBox?.(el),
      auth.getBoundingBox?.(el),
      el.worldBox,
      el.box,
      el.boundingBox,
    ];

    let added = false;

    for (const cand of candidates) {
      const b = boxFromAnyBox(cand);

      if (b && !b.isEmpty()) {
        box.union(b);
        added = true;
        break;
      }
    }

    if (!added) {
      includeObject(el.mesh ?? el.three ?? el.object ?? el, box);
    }
  }

  return box.isEmpty() ? null : box;
}
