/**
 * Interactive 3D preview for the Family Creator panel.
 *
 * Draws the object the real parametric engine built (not a re-drawing of
 * it). Drag to orbit, wheel to zoom, right-drag to pan, Fit to reset.
 * Rendering is on demand, so an idle preview costs nothing. If WebGL is not
 * available the caller keeps the plain drawing and shows a message.
 *
 * The canvas carries data-* attributes (camera, target, size, mesh count)
 * so a browser test can confirm the geometry and the interaction.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const PART_COLORS = [0x64748b, 0x60a5fa, 0x38bdf8, 0xf59e0b, 0x94a3b8, 0x22c55e];

export interface Preview3D {
  /** Wrapper element to place in the panel. It survives re-renders. */
  readonly el: HTMLElement;
  /** Show the engine-built object. `fit` re-frames the camera. */
  setObject(obj: THREE.Object3D | null, fit: boolean): void;
  fit(): void;
  dispose(): void;
}

export function createPreview3D(width = 340, height = 250): Preview3D | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
  } catch {
    return null;
  }
  const canvas = renderer.domElement;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  canvas.style.cssText = `width:${width}px;height:${height}px;display:block;border-radius:6px;touch-action:none;cursor:grab`;
  canvas.setAttribute("data-fc3d", "canvas");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const grid = new THREE.GridHelper(4, 16, 0x475569, 0x1e293b);
  scene.add(grid);

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.01, 500);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;

  const holder = new THREE.Group();
  scene.add(holder);
  let current: THREE.Object3D | null = null;
  let raf = 0;
  let disposed = false;

  const wrap = document.createElement("div");
  wrap.setAttribute("data-fc", "preview3d");
  // The main viewport owns the wheel globally; this opts the preview out so it can zoom itself.
  wrap.setAttribute("data-obs-own-wheel", "");
  wrap.appendChild(canvas);

  const bounds = () => (current ? new THREE.Box3().setFromObject(current) : null);

  const publish = () => {
    const b = bounds();
    const f = (n: number) => Math.round(n * 1000) / 1000;
    canvas.dataset.cam = [camera.position.x, camera.position.y, camera.position.z].map(f).join(",");
    canvas.dataset.target = [controls.target.x, controls.target.y, controls.target.z].map(f).join(",");
    canvas.dataset.dist = String(f(camera.position.distanceTo(controls.target)));
    if (b) {
      const s = b.getSize(new THREE.Vector3());
      // Engine axes are X width, Y up, Z depth. Reported as width, depth, height in mm.
      canvas.dataset.size = [s.x, s.z, s.y].map((n) => Math.round(n * 1000 * 100) / 100).join(",");
    } else delete canvas.dataset.size;
    let meshes = 0;
    current?.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
    canvas.dataset.meshes = String(meshes);
    canvas.dataset.frames = String(Number(canvas.dataset.frames ?? "0") + 1);
  };

  const render = () => {
    raf = 0;
    if (disposed) return;
    renderer.render(scene, camera);
    publish();
  };
  const request = () => { if (!raf && !disposed) raf = requestAnimationFrame(render); };
  controls.addEventListener("change", request);

  const fit = () => {
    const b = bounds();
    if (!b) return;
    const size = b.getSize(new THREE.Vector3());
    const center = b.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.05);
    const dist = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
    const dir = new THREE.Vector3(1, 0.7, 1.3).normalize();
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = Math.max(dist / 500, 0.001);
    camera.far = dist * 20;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    const gs = Math.max(size.x, size.z) * 2.2;
    grid.scale.setScalar(Math.max(gs / 4, 0.1));
    request();
  };

  const clear = () => {
    while (holder.children.length) {
      const c = holder.children[0];
      holder.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
      });
    }
  };

  return {
    el: wrap,
    setObject(obj, doFit) {
      clear();
      current = null;
      if (obj) {
        // Work on a copy so the engine's own object is left untouched.
        const copy = obj.clone(true);
        let i = 0;
        const edges: THREE.LineSegments[] = [];
        copy.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.material = new THREE.MeshStandardMaterial({ color: PART_COLORS[i % PART_COLORS.length], roughness: 0.7, metalness: 0.05 });
          i++;
          edges.push(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 25), new THREE.LineBasicMaterial({ color: 0x0b1220 })));
          edges[edges.length - 1].matrixAutoUpdate = false;
          m.updateWorldMatrix(true, false);
          edges[edges.length - 1].matrix.copy(m.matrixWorld);
        });
        copy.updateMatrixWorld(true);
        // Edges carry world matrices from the engine group, so add them next to the copy.
        holder.add(copy);
        const edgeGroup = new THREE.Group();
        edges.forEach((e) => edgeGroup.add(e));
        holder.add(edgeGroup);
        current = copy;
      }
      if (doFit) fit(); else request();
    },
    fit,
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      controls.dispose();
      clear();
      renderer.dispose();
      wrap.remove();
    },
  };
}
