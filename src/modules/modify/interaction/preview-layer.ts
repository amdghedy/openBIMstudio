/**
 * Non-destructive preview overlay for modify commands.
 * Ghosts are transient meshes; the authored model is untouched until Commit.
 */
import * as THREE from "three";
import type { PreviewFrame, PlanPoint } from "./types";

const GHOST_COLOR = 0x38bdf8;
const COPY_COLOR = 0xa78bfa;
const RUBBER_COLOR = 0xfbbf24;

export class PreviewLayer {
  readonly group = new THREE.Group();
  private rubber: THREE.Line | null = null;
  private labelSprites: THREE.Sprite[] = [];
  private ghostMeshes: THREE.Object3D[] = [];
  private scene: THREE.Scene | null = null;

  attach(scene: THREE.Scene): void {
    if (this.scene === scene) return;
    this.detach();
    this.scene = scene;
    this.group.name = "obs-modify-preview";
    scene.add(this.group);
  }

  detach(): void {
    this.clear();
    if (this.scene && this.group.parent === this.scene) this.scene.remove(this.group);
    this.scene = null;
  }

  clear(): void {
    for (const m of this.ghostMeshes) {
      this.group.remove(m);
      disposeObject(m);
    }
    this.ghostMeshes = [];
    if (this.rubber) {
      this.group.remove(this.rubber);
      disposeObject(this.rubber);
      this.rubber = null;
    }
    for (const s of this.labelSprites) {
      this.group.remove(s);
      disposeObject(s);
    }
    this.labelSprites = [];
  }

  show(frame: PreviewFrame | null, sourceMeshes: Map<string, THREE.Object3D[]>): void {
    this.clear();
    if (!frame) return;

    for (const g of frame.ghosts) {
      const srcs = sourceMeshes.get(g.sourceId) ?? [];
      for (const src of srcs) {
        const clone = src.clone(true);
        clone.traverse((o: any) => {
          if (o.isMesh && o.material) {
            const mat = Array.isArray(o.material)
              ? o.material.map((m: THREE.Material) => ghostMaterial(m, g.isCopy))
              : ghostMaterial(o.material, g.isCopy);
            o.material = mat;
            o.raycast = () => {};
          }
        });
        clone.position.x += g.dx;
        clone.position.z += g.dz;
        if (g.dy) clone.position.y += g.dy;
        if (g.rot && g.pivot) {
          const px = g.pivot.x;
          const pz = g.pivot.z;
          const dx = clone.position.x - px;
          const dz = clone.position.z - pz;
          const c = Math.cos(g.rot);
          const s = Math.sin(g.rot);
          clone.position.x = px + dx * c - dz * s;
          clone.position.z = pz + dx * s + dz * c;
          clone.rotation.y += g.rot;
        }
        clone.userData.modifyGhost = true;
        this.group.add(clone);
        this.ghostMeshes.push(clone);
      }
    }

    if (frame.rubberFrom && frame.rubberTo) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(frame.rubberFrom.x, 0.05, frame.rubberFrom.z),
        new THREE.Vector3(frame.rubberTo.x, 0.05, frame.rubberTo.z),
      ]);
      const mat = new THREE.LineDashedMaterial({
        color: RUBBER_COLOR,
        dashSize: 0.15,
        gapSize: 0.1,
        depthTest: false,
      });
      this.rubber = new THREE.Line(geo, mat);
      this.rubber.computeLineDistances();
      this.rubber.renderOrder = 999;
      this.group.add(this.rubber);
    }

    for (const dim of frame.tempDims ?? []) {
      const spr = makeTextSprite(dim.label);
      spr.position.set((dim.from.x + dim.to.x) / 2, 0.4, (dim.from.z + dim.to.z) / 2);
      this.group.add(spr);
      this.labelSprites.push(spr);
    }

    if (frame.cursorLabel && frame.rubberTo) {
      const spr = makeTextSprite(frame.cursorLabel);
      spr.position.set(frame.rubberTo.x, 0.6, frame.rubberTo.z);
      this.group.add(spr);
      this.labelSprites.push(spr);
    }
  }
}

function ghostMaterial(src: THREE.Material, isCopy?: boolean): THREE.Material {
  const m = src.clone();
  (m as any).transparent = true;
  (m as any).opacity = 0.45;
  (m as any).depthWrite = false;
  if ((m as any).color) (m as any).color.setHex(isCopy ? COPY_COLOR : GHOST_COLOR);
  if ((m as any).emissive) (m as any).emissive.setHex(isCopy ? COPY_COLOR : GHOST_COLOR);
  return m;
}

function makeTextSprite(text: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(15,23,42,0.85)";
  g.fillRect(8, 8, 240, 48);
  g.fillStyle = "#f8fafc";
  g.font = "bold 22px system-ui,sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(1.6, 0.4, 1);
  spr.renderOrder = 1000;
  return spr;
}

function disposeObject(o: THREE.Object3D): void {
  o.traverse((child: any) => {
    if (child.geometry) child.geometry.dispose?.();
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        m.map?.dispose?.();
        m.dispose?.();
      }
    }
  });
}

export function distPlan(a: PlanPoint, b: PlanPoint): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

export function formatDist(m: number): string {
  if (Math.abs(m) >= 1) return `${m.toFixed(2)} m`;
  return `${(m * 1000).toFixed(0)} mm`;
}
