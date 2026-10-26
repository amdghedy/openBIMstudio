/**
 * Visual feedback for Smart Snap & Perpendicular Link.
 * Dark-mode cues while dragging a wall endpoint onto a column:
 *   - blue right-angle guide
 *   - blue anchor disc at the join
 *   - orange floating "End" tooltip
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import type { PlanPt, SmartPerpSnapResult } from "../modules/snapping/smart-perp-snap";

const GUIDE_COLOR = 0x3b82f6;
const ANCHOR_COLOR = 0x3b82f6;
const LABEL_BG = "#f97316";
const LABEL_FG = "#0b0d12";

class SnapFeedbackRenderer {
  private group: THREE.Group | null = null;
  private line: THREE.Line | null = null;
  private anchor: THREE.Mesh | null = null;
  private label: HTMLDivElement | null = null;
  private visible = false;

  private ensure(): void {
    if (this.group) return;
    try {
      const scene = (ctx as any).world?.scene?.three as THREE.Scene | undefined;
      if (!scene) return;

      this.group = new THREE.Group();
      this.group.name = "obs-smart-snap-feedback";
      this.group.renderOrder = 999;

      const geo = new THREE.BufferGeometry();
      geo.setFromPoints([
        new THREE.Vector3(),
        new THREE.Vector3(),
        new THREE.Vector3(),
      ]);
      const mat = new THREE.LineBasicMaterial({
        color: GUIDE_COLOR,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
      });
      this.line = new THREE.Line(geo, mat);
      this.line.frustumCulled = false;
      this.group.add(this.line);

      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.08, 24),
        new THREE.MeshBasicMaterial({
          color: ANCHOR_COLOR,
          depthTest: false,
          transparent: true,
          opacity: 0.95,
          side: THREE.DoubleSide,
        }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.frustumCulled = false;
      this.anchor = disc;
      this.group.add(disc);

      scene.add(this.group);
      this.group.visible = false;

      const host = (ctx as any).rightHost as HTMLElement | undefined;
      if (host) {
        const lab = document.createElement("div");
        lab.textContent = "End";
        lab.style.cssText =
          "position:absolute;transform:translate(-50%,calc(-100% - 14px));" +
          "font:700 10px system-ui,sans-serif;color:" +
          LABEL_FG +
          ";background:" +
          LABEL_BG +
          ";padding:2px 7px;border-radius:3px;white-space:nowrap;" +
          "pointer-events:none;z-index:40;display:none;" +
          "box-shadow:0 2px 6px rgba(0,0,0,.4);letter-spacing:.2px";
        host.appendChild(lab);
        this.label = lab;
      }
    } catch (err) {
      console.warn("[snap-feedback] init failed", err);
    }
  }

  show(result: SmartPerpSnapResult, fixed: PlanPt, elevation = 0): void {
    this.ensure();
    if (!this.group || !this.line || !this.anchor) return;

    const y = elevation + 0.02;
    const attach = new THREE.Vector3(result.attach.x, y, result.attach.z);
    const fixedV = new THREE.Vector3(fixed.x, y, fixed.z);

    // Tick along the face (perp to normal in plan)
    const tx = -result.normal.z;
    const tz = result.normal.x;
    const tickLen = 0.28;
    const tick = attach.clone().add(new THREE.Vector3(tx * tickLen, 0, tz * tickLen));

    const positions = this.line.geometry.attributes.position as THREE.BufferAttribute;
    if (positions && positions.count >= 3) {
      positions.setXYZ(0, fixedV.x, fixedV.y, fixedV.z);
      positions.setXYZ(1, attach.x, attach.y, attach.z);
      positions.setXYZ(2, tick.x, tick.y, tick.z);
      positions.needsUpdate = true;
    } else {
      this.line.geometry.setFromPoints([fixedV, attach, tick]);
    }

    this.anchor.position.copy(attach);
    // Scale disc roughly with distance for readability
    try {
      const cam = (ctx as any).world?.camera?.three as THREE.Camera | undefined;
      if (cam) {
        const dist = cam.position.distanceTo(attach);
        const s = Math.max(0.6, Math.min(2.5, dist * 0.02));
        this.anchor.scale.setScalar(s);
      }
    } catch {
      /* */
    }

    this.group.visible = true;
    this.visible = true;

    if (this.label && (ctx as any).world?.camera?.three && (ctx as any).rightHost) {
      try {
        const cam = (ctx as any).world.camera.three as THREE.Camera;
        const p = attach.clone().project(cam);
        const rect = ((ctx as any).rightHost as HTMLElement).getBoundingClientRect();
        const x = (p.x * 0.5 + 0.5) * rect.width;
        const yy = (-p.y * 0.5 + 0.5) * rect.height;
        this.label.style.left = `${x}px`;
        this.label.style.top = `${yy}px`;
        this.label.style.display = "block";
        this.label.textContent = result.mode === "face" ? "End" : "Corner";
      } catch {
        this.label.style.display = "none";
      }
    }
  }

  hide(): void {
    if (this.group) this.group.visible = false;
    if (this.label) this.label.style.display = "none";
    this.visible = false;
  }

  isVisible(): boolean {
    return this.visible;
  }
}

export const snapFeedback = new SnapFeedbackRenderer();
