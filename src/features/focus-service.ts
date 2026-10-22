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

  const elements = auth.getElements?.() ?? auth.elements ?? [];
  const box = new THREE.Box3();

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

async function getFragmentBox(
  frag: Record<string, Set<number>>,
): Promise<THREE.Box3 | null> {
  const entries = Object.entries(frag).filter(
    ([, ids]) => ids instanceof Set && ids.size,
  );

  if (!entries.length) return null;

  const box = new THREE.Box3();
  const cont = c();

  try {
    const wbMod: any = await import("../modules/geometry/world-box");

    for (const [modelId, ids] of entries) {
      const model: any =
        cont.fragments?.list?.get?.(modelId) ??
        cont.fragments?.list?.get?.(String(modelId));

      if (!model) continue;

      const idList = [...ids]
        .map(Number)
        .filter((n) => Number.isFinite(n));

      if (!idList.length) continue;

      const wbs = await wbMod.getElementWorldBoxes?.(
        model,
        idList,
        modelId,
      );

      for (const item of wbs ?? []) {
        const b = boxFromAnyBox(item?.box ?? item);

        if (b && !b.isEmpty()) {
          box.union(b);
        }
      }
    }
  } catch (err) {
    console.warn("[focus-service] world-box failed", err);
  }

  if (!box.isEmpty()) return box;

  const scene: any = cont.world?.scene?.three ?? cont.world?.scene;

  if (scene && typeof scene.traverse === "function") {
    try {
      scene.updateMatrixWorld?.(true);
    } catch {
      /* ignore */
    }

    const lookup = new Map<string, Set<string>>();

    for (const [modelId, ids] of entries) {
      const set = new Set<string>();

      for (const id of ids) {
        set.add(String(id));
      }

      if (set.size) {
        lookup.set(String(modelId), set);
      }
    }

    scene.traverse((obj: Any) => {
      const ud = obj?.userData || {};

      const mid = String(
        ud.modelID ??
          ud.modelId ??
          ud.model ??
          ud.fragmentModelID ??
          ud.ownerModelID ??
          "",
      );

      const lid = String(
        ud.expressID ??
          ud.localID ??
          ud.localId ??
          ud.id ??
          ud.elementID ??
          ud.instanceID ??
          "",
      );

      if (!mid || !lid) return;

      const set = lookup.get(mid);

      if (set?.has(lid)) {
        includeObject(obj, box);
      }
    });
  }

  return box.isEmpty() ? null : box;
}

function getCurrentTarget(cam: Any, controls: Any): THREE.Vector3 {
  const t = new THREE.Vector3();

  try {
    if (typeof controls?.getTarget === "function") {
      controls.getTarget(t);

      if (
        Number.isFinite(t.x) &&
        Number.isFinite(t.y) &&
        Number.isFinite(t.z)
      ) {
        return t;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    t.copy(cam.position).addScaledVector(dir, 10);
  } catch {
    t.set(0, 0, 0);
  }

  return t;
}

function focusBoxManual(box: THREE.Box3): boolean {
  const cont = c();
  const cam: Any = cont.world?.camera?.three;
  const controls: Any = cont.world?.camera?.controls;

  if (!cam || box.isEmpty()) return false;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);

  const target = center.clone();
  const currentTarget = getCurrentTarget(cam, controls);

  const dir = new THREE.Vector3().subVectors(cam.position, currentTarget);

  if (!Number.isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-8) {
    dir.set(0, 0.35, 1);
  }

  dir.normalize();

  let distance: number;

  if (cam.isOrthographicCamera) {
    distance = Math.max(maxDim * 2.5, 1);

    const height = Math.abs(Number(cam.top ?? 1) - Number(cam.bottom ?? -1));
    const width = Math.abs(Number(cam.right ?? 1) - Number(cam.left ?? -1));

    const zoomY = height / Math.max(maxDim * 1.35, 0.0001);
    const zoomX = width / Math.max(maxDim * 1.35, 0.0001);
    const zoom = Math.min(zoomX, zoomY);

    cam.zoom = Math.max(0.0001, Math.min(100000, Number(zoom) || 1));

    syncOrthoZoom(cam);
    cam.updateProjectionMatrix();
  } else {
    const fov = THREE.MathUtils.degToRad(Number(cam.fov) || 50);
    distance = ((maxDim / 2) / Math.tan(fov / 2)) * 1.75;
    distance = Math.max(distance, maxDim * 0.85);
  }

  const pos = target.clone().addScaledVector(dir, distance);

  try {
    if (typeof controls?.setLookAt === "function") {
      controls.setLookAt(
        pos.x,
        pos.y,
        pos.z,
        target.x,
        target.y,
        target.z,
        true,
      );

      controls.update?.(0);
    } else {
      cam.position.copy(pos);
      cam.lookAt(target);
    }
  } catch {
    cam.position.copy(pos);

    try {
      cam.lookAt(target);
    } catch {
      /* ignore */
    }
  }

  try {
    window.dispatchEvent(new CustomEvent("obs:camera-changed"));
  } catch {
    /* ignore */
  }

  return true;
}

async function applyBox(box: THREE.Box3): Promise<boolean> {
  if (!box || box.isEmpty()) return false;

  try {
    const cam: any = await import("./camera-tools");

    if (typeof cam.focusOnBox === "function") {
      await cam.focusOnBox(box);
      return true;
    }
  } catch {
    /* fallback below */
  }

  return focusBoxManual(box);
}

async function tryFitToMap(frag: any): Promise<boolean> {
  try {
    const cam: any = await import("./camera-tools");

    if (typeof cam.fitToMap === "function") {
      await cam.fitToMap(frag);
      return true;
    }
  } catch {
    /* ignore */
  }

  return false;
}

async function pickAndFocus(event: any): Promise<boolean> {
  if (!event) return false;

  const cont = c();
  const auth = cont.features?.authoring || w().__obsAuthoring;

  try {
    const authoredId = auth?.pickAuthoredElementAt?.(event);

    if (authoredId) {
      const ids = [String(authoredId)];
      auth?.setSelectedAuthored?.(ids, "replace");

      const box = getAuthoredBox(ids);

      if (box) {
        return await applyBox(box);
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const selMod: any = await import("./selection");
    const hit = await selMod.pickFragmentAtPointer?.();

    if (hit) {
      const lid = Number(hit.localId);

      selMod.selection?.applyClick?.(hit.modelId, hit.localId, {});
      await selMod.selection?.applyToHighlighter?.();

      if (Number.isFinite(lid)) {
        const frag: Record<string, Set<number>> = {};
        frag[String(hit.modelId)] = new Set<number>([lid]);

        const box = await getFragmentBox(frag);

        if (box) {
          return await applyBox(box);
        }

        return await tryFitToMap(frag);
      }
    }
  } catch {
    /* ignore */
  }

  return false;
}

export async function focusSelected(event?: any): Promise<boolean> {
  const authIds = getAuthoredSelection();
  const frag = getFragmentSelection();

  const box = new THREE.Box3();
  let has = false;

  if (authIds.length) {
    const ab = getAuthoredBox(authIds);

    if (ab) {
      box.union(ab);
      has = true;
    }
  }

  if (Object.keys(frag).length) {
    const fb = await getFragmentBox(frag);

    if (fb) {
      box.union(fb);
      has = true;
    }
  }

  if (has && !box.isEmpty()) {
    return await applyBox(box);
  }

  if (Object.keys(frag).length) {
    const ok = await tryFitToMap(frag);

    if (ok) return true;
  }

  if (authIds.length) {
    try {
      const auth: any = c().features?.authoring;

      if (typeof auth?.focusSelected === "function") {
        await auth.focusSelected();
        return true;
      }
    } catch {
      /* ignore */
    }
  }

  return await pickAndFocus(event ?? (w() as Any).__obsLastCtxEvent ?? null);
}

(w() as Any).__obsFocusSelected = focusSelected;

(w() as Any).__obsFocusService = {
  focusSelected,
  getAuthoredSelection,
  getFragmentSelection,
};

console.log("[focus-service] ready");
