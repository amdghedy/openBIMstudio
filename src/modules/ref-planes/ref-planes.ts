/**
 * Reference Planes & Reference Lines - BIM-style construction geometry.
 *
 * Used as hosts for constraints, alignment targets, and work plane picks.
 * They are non-printing helper objects stored per project.
 */

import * as THREE from "three";
import { ctx } from "../../core/context";

export type RefPlaneId = string;
export type RefLineId = string;

export interface RefPlane {
  id: RefPlaneId;
  name: string;
  /** Origin point (world metres). */
  origin: { x: number; y: number; z: number };
  /** Unit normal. */
  normal: { x: number; y: number; z: number };
  /** Extent half-size for display (m). */
  extent: number;
  pinned: boolean;
  /** Associated level if horizontal. */
  levelId?: string | null;
}

export interface RefLine {
  id: RefLineId;
  name: string;
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  pinned: boolean;
}

const STORAGE = "obs.ref-planes.v1";
type Listener = () => void;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

class RefPlanesStore {
  private planes = new Map<RefPlaneId, RefPlane>();
  private lines = new Map<RefLineId, RefLine>();
  private listeners = new Set<Listener>();
  private activeWorkPlaneId: RefPlaneId | null = null;
  private overlay: THREE.Group | null = null;
  private booted = false;

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) {
        const data = JSON.parse(raw);
        for (const p of data.planes ?? []) this.planes.set(p.id, p);
        for (const l of data.lines ?? []) this.lines.set(l.id, l);
        this.activeWorkPlaneId = data.activeWorkPlaneId ?? null;
      }
    } catch { /* */ }

    // Seed three orthographic planes if empty
    if (!this.planes.size) {
      this.planes.set("rp-xy", {
        id: "rp-xy",
        name: "Floor Plane (XY)",
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
        extent: 50,
        pinned: true,
      });
      this.planes.set("rp-xz", {
        id: "rp-xz",
        name: "Front Plane (XZ)",
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        extent: 50,
        pinned: true,
      });
      this.planes.set("rp-yz", {
        id: "rp-yz",
        name: "Side Plane (YZ)",
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 },
        extent: 50,
        pinned: true,
      });
      this.activeWorkPlaneId = "rp-xy";
      this.persist();
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE,
        JSON.stringify({
          planes: [...this.planes.values()],
          lines: [...this.lines.values()],
          activeWorkPlaneId: this.activeWorkPlaneId,
        }),
      );
    } catch { /* */ }
    for (const cb of this.listeners) {
      try { cb(); } catch { /* */ }
    }
    this.refreshOverlay();
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  listPlanes(): RefPlane[] {
    return [...this.planes.values()];
  }

  listLines(): RefLine[] {
    return [...this.lines.values()];
  }

  getPlane(id: RefPlaneId): RefPlane | null {
    return this.planes.get(id) ?? null;
  }

  createPlane(input: {
    name: string;
    origin: RefPlane["origin"];
    normal: RefPlane["normal"];
    extent?: number;
    levelId?: string | null;
  }): RefPlane {
    const plane: RefPlane = {
      id: uid("rp"),
      name: input.name,
      origin: { ...input.origin },
      normal: { ...input.normal },
      extent: input.extent ?? 20,
      pinned: false,
      levelId: input.levelId ?? null,
    };
    this.planes.set(plane.id, plane);
    this.persist();
    return plane;
  }

  createLine(input: {
    name: string;
    start: RefLine["start"];
    end: RefLine["end"];
  }): RefLine {
    const line: RefLine = {
      id: uid("rl"),
      name: input.name,
      start: { ...input.start },
      end: { ...input.end },
      pinned: false,
    };
    this.lines.set(line.id, line);
    this.persist();
    return line;
  }

  removePlane(id: RefPlaneId): boolean {
    const p = this.planes.get(id);
    if (!p || p.pinned) return false;
    this.planes.delete(id);
    if (this.activeWorkPlaneId === id) this.activeWorkPlaneId = "rp-xy";
    this.persist();
    return true;
  }

  removeLine(id: RefLineId): boolean {
    const ok = this.lines.delete(id);
    if (ok) this.persist();
    return ok;
  }

  getActiveWorkPlane(): RefPlane | null {
    return this.activeWorkPlaneId
      ? this.planes.get(this.activeWorkPlaneId) ?? null
      : null;
  }

  setActiveWorkPlane(id: RefPlaneId): void {
    if (!this.planes.has(id)) return;
    this.activeWorkPlaneId = id;
    this.persist();
  }

  /** THREE.Plane for raycasting / placement. */
  toThreePlane(id: RefPlaneId): THREE.Plane | null {
    const p = this.planes.get(id);
    if (!p) return null;
    return new THREE.Plane(
      new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z).normalize(),
      -new THREE.Vector3(p.origin.x, p.origin.y, p.origin.z).dot(
        new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z).normalize(),
      ),
    );
  }

  /** Project a world point onto the active work plane. */
  projectToWorkPlane(point: THREE.Vector3): THREE.Vector3 | null {
    const plane = this.activeWorkPlaneId
      ? this.toThreePlane(this.activeWorkPlaneId)
      : null;
    if (!plane) return null;
    const out = new THREE.Vector3();
    plane.projectPoint(point, out);
    return out;
  }

  private refreshOverlay(): void {
    const scene = (ctx as any).world?.scene?.three as THREE.Scene | undefined;
    if (!scene) return;

    if (this.overlay) {
      scene.remove(this.overlay);
      this.overlay.traverse((o: any) => {
        if (o.geometry) o.geometry.dispose?.();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m: any) => m.dispose?.());
          else o.material.dispose?.();
        }
      });
    }

    this.overlay = new THREE.Group();
    this.overlay.name = "obs-ref-planes";
    this.overlay.userData.isHelper = true;

    for (const p of this.planes.values()) {
      if (p.pinned && p.id !== this.activeWorkPlaneId) continue; // only show active orthographic by default
      const size = p.extent;
      const geo = new THREE.PlaneGeometry(size * 2, size * 2);
      const mat = new THREE.MeshBasicMaterial({
        color: p.id === this.activeWorkPlaneId ? 0x38bdf8 : 0x64748b,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.origin.x, p.origin.y, p.origin.z);
      mesh.lookAt(
        p.origin.x + p.normal.x,
        p.origin.y + p.normal.y,
        p.origin.z + p.normal.z,
      );
      mesh.userData.refPlaneId = p.id;
      this.overlay.add(mesh);

      // Edge outline
      const edges = new THREE.EdgesGeometry(geo);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
          color: p.id === this.activeWorkPlaneId ? 0x38bdf8 : 0x475569,
          transparent: true,
          opacity: 0.5,
        }),
      );
      line.position.copy(mesh.position);
      line.quaternion.copy(mesh.quaternion);
      this.overlay.add(line);
    }

    for (const l of this.lines.values()) {
      const pts = [
        new THREE.Vector3(l.start.x, l.start.y, l.start.z),
        new THREE.Vector3(l.end.x, l.end.y, l.end.z),
      ];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: 0xf59e0b, linewidth: 1 }),
      );
      line.userData.refLineId = l.id;
      this.overlay.add(line);
    }

    scene.add(this.overlay);
  }

  showOverlay(visible: boolean): void {
    if (this.overlay) this.overlay.visible = visible;
  }
}

export const refPlanesStore = new RefPlanesStore();

export function setupRefPlanes(): typeof refPlanesStore {
  refPlanesStore.boot();
  (ctx.features as any).refPlanes = refPlanesStore;
  (window as any).__obsRefPlanes = refPlanesStore;
  // Deferred overlay attach once scene exists
  window.setTimeout(() => {
    try { (refPlanesStore as any).refreshOverlay?.(); } catch { /* */ }
  }, 800);
  console.log("[ref-planes] ready -", refPlanesStore.listPlanes().length, "planes");
  return refPlanesStore;
}
