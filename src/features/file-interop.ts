/** Universal file opening: converts everything the browser can, guides for the rest. */
import * as THREE from "three";
import { ctx } from "../core/context";
import { computeSceneBounds, fitAll } from "./camera-tools";
import { loadIfcFiles, loadFragFiles } from "./importer";
import { markDirty } from "../modules/projects/projects";

export const ACCEPT_ALL =
  ".ifc,.ifczip,.zip,.frag,.obs.json,.json,.glb,.gltf,.obj,.stl,.ply,.fbx,.dae,.3ds,.rvt,.rfa,.dwg,.dxf,.skp";

const DESKTOP_ONLY: Record<string, string> = {
  rvt: "BIM files cannot be converted in the browser.\n\nIn BIM: File → Export → IFC → export the model, then import the .ifc here.",
  rfa: "BIM families cannot be converted in the browser.\n\nLoad the family into a BIM project, then export the project as IFC and import it here.",
  dwg: "DWG cannot be converted in the browser.\n\nIn AutoCAD: save as DXF, or better export the model as IFC / OBJ, then import here.",
  skp: "SketchUp files cannot be converted in the browser.\n\nIn SketchUp: File → Export → IFC / OBJ / DAE (3D model), then import here.",
};

const auxGroup = new THREE.Group();
const auxIds: string[] = [];

const uid = () => (crypto as any).randomUUID?.() ?? `aux-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function pickFilesLocal(accept: string, cb: (files: File[]) => void) {
  const input = document.createElement("input");
  input.type = "file"; input.accept = accept; input.multiple = true;
  input.onchange = () => { if (input.files?.length) cb(Array.from(input.files)); };
  input.click();
}

function ext(name: string) { return (name.split(".").pop() ?? "").toLowerCase(); }

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

// ── Aux object lifecycle ──
export function getAuxBox(): THREE.Box3 | null {
  if (!auxGroup.children.length) return null;
  return new THREE.Box3().setFromObject(auxGroup);
}
export function getAuxObjects(): THREE.Object3D[] { return auxGroup.children; }

export function clearAux() {
  while (auxGroup.children.length) {
    const ch = auxGroup.children[0];
    auxGroup.remove(ch);
    ch.traverse((m: any) => {
      m.geometry?.dispose?.();
      if (Array.isArray(m.material)) m.material.forEach((x: any) => x.dispose?.());
      else m.material?.dispose?.();
    });
  }
  auxIds.length = 0;
}

// ─── BIM-style isometric view ─────────────────────────────────
// Positions the camera at 45° azimuth, ~35° elevation looking at
// the scene center. This mimics the default 3D View in BIM.
function applyBIMIsoView() {
  try {
    const cam = (ctx.world.scene as any).camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const controls = (ctx.world.scene as any).controls;
    if (!cam) return;

    // Compute bounding box of the scene (or aux group)
    const target =
      (typeof getAuxBox === "function" ? getAuxBox() : null) ||
      (() => {
        const box = new THREE.Box3();
        ctx.world.scene.three.children.forEach((c: any) => {
          if (c.visible) box.expandByObject(c);
        });
        return box;
      })();

    if (!target || target.isEmpty()) return;

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    target.getCenter(center);
    target.getSize(size);

    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 10;
    const dist = radius * 2.4; // pull back a bit for breathing room

    // BIM default 3D view: SE isometric. In a Y-up system this is:
    // +X to the right, +Z toward viewer, +Y up.
    // Azimuth 45°, elevation ~35.264° (true isometric).
    const az = Math.PI / 4;              // 45°
    const el = Math.atan(1 / Math.SQRT2); // ≈ 35.26°

    const dx = Math.cos(el) * Math.sin(az);
    const dy = Math.sin(el);
    const dz = Math.cos(el) * Math.cos(az);

    const camPos = new THREE.Vector3(
      center.x + dist * dx,
      center.y + dist * dy,
      center.z + dist * dz
    );

    cam.position.copy(camPos);
    cam.up.set(0, 1, 0);
    cam.lookAt(center);
    cam.updateProjectionMatrix();

    if (controls) {
      (controls as any).target?.copy(center);
      (controls as any).update?.();
    }

    // Notify the app that the camera changed (some features listen for this)
    try { window.dispatchEvent(new CustomEvent("obs:camera-changed")); } catch { /* */ }
  } catch (err) {
    console.warn("[file-interop] applyBIMIsoView failed:", err);
  }
}
function addAuxObject(obj: THREE.Object3D, label: string) {
  obj.name = label;
  auxGroup.add(obj);
  computeSceneBounds();
  fitAll();
  // Override the default fit view with a BIM-style isometric view
  setTimeout(() => applyBIMIsoView(), 0);
  markDirty();
}

function geometryToMesh(geo: THREE.BufferGeometry, label: string): THREE.Mesh {
  geo.computeVertexNormals?.();
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xb9c2cc }));
}

/** Re-load a persisted aux blob (called by projects.openProject). */
export async function restoreAux(blob: Blob, name: string, modelId?: string) {
  if (/\.(dwg|dxf)$/i.test(name)) {
    const m = await import("../modules/cad-link");
    m.setupCadLinks();
    await m.restoreCadLinkFromBlob(blob, name, modelId);
    return;
  }
  const buf = await blob.arrayBuffer();
  const obj = await parseModelBytes(buf, name);
  if (obj) addAuxObject(obj, name);
}

async function parseModelBytes(buf: ArrayBuffer, name: string): Promise<THREE.Object3D | null> {
  const e = ext(name);
  try {
    if (e === "glb" || e === "gltf") {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().parseAsync(buf, "");
      return gltf.scene;
    }
    if (e === "obj") {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      return new OBJLoader().parse(new TextDecoder().decode(buf));
    }
    if (e === "stl") {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      return geometryToMesh(new STLLoader().parse(buf), name);
    }
    if (e === "ply") {
      const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
      return geometryToMesh(new PLYLoader().parse(buf), name);
    }
    if (e === "fbx") {
      const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
      return new FBXLoader().parse(buf, "");
    }
    if (e === "dae") {
      const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
      const collada = new ColladaLoader().parse(new TextDecoder().decode(buf), "");
      return collada.scene;
    }
    if (e === "3ds") {
      const { TDSLoader } = await import("three/examples/jsm/loaders/TDSLoader.js");
      return new TDSLoader().parse(buf, "");
    }
  } catch (err: any) {
    alert(`Could not parse "${name}":\n${err?.message ?? err}\n\nTip: .glb (binary, single file) is the most reliable mesh format.`);
  }
  return null;
}

// ── Router ──
export async function importFiles(files: File[]) {
  for (const file of files) {
    const e = ext(file.name);
    try {
      if (e === "ifc") { loadIfcFiles([file]); continue; }
      if (e === "frag") { loadFragFiles([file]); continue; }

      if (e === "ifczip" || (e === "zip" && /\.ifczip$|\.zip$/i.test(file.name))) {
        const JSZip = (await import("jszip")).default;
        const zip = await JSZip.loadAsync(file);
        const ifcPaths: string[] = [];
        zip.forEach((p) => { if (/\.ifc$/i.test(p)) ifcPaths.push(p); });
        if (!ifcPaths.length) { alert(`No .ifc entries inside "${file.name}".`); continue; }
        const converted: File[] = [];
        for (const p of ifcPaths) {
          const bytes = await zip.file(p)!.async("uint8array");
          converted.push(new File([bytes as any], p.split("/").pop() || `from-${file.name}.ifc`));
        }
        loadIfcFiles(converted);
        continue;
      }

      if (file.name.endsWith(".obs.json") || (e === "json" && file.size < 20_000_000)) {
        const text = await file.text();
        if (text.includes("\"elements\"") && text.includes("\"models\"")) {
          const { putProject } = await import("../modules/projects/store");
          const { openProject } = await import("../modules/projects/projects");
          const doc = JSON.parse(text);
          if (!doc?.id || !Array.isArray(doc.elements)) throw new Error("Not a valid Open BIM Studio project file.");
          await putProject(doc);
          await openProject(doc.id);
          continue;
        }
      }

      if (e === "dwg" || e === "dxf") {
        const m = await import("../modules/cad-link");
        m.setupCadLinks();
        await m.linkCadFileInteractive(file);
        continue;
      }

      if (DESKTOP_ONLY[e]) { alert(DESKTOP_ONLY[e]); continue; }

      // Everything else → try as a 3D model (glb/gltf/obj/stl/ply/fbx/dae/3ds)
      const buf = await file.arrayBuffer();
      const obj = await parseModelBytes(buf, file.name);
      if (obj) {
        addAuxObject(obj, file.name);
        const bytes = new Uint8Array(buf);
        (ctx.features.projects as any)?.onModelImported?.(`aux-${uid()}`, file.name, bytes);
      } else {
        alert(`Unsupported file type: "${file.name}"\n\nSupported: ${ACCEPT_ALL}\n\n${Object.entries(DESKTOP_ONLY).map(([k, v]) => `.${k}: ${v.split("\n")[0]}`).join("\n")}`);
      }
    } catch (err: any) {
      console.error("[file-interop]", err);
      alert(`Failed to open "${file.name}":\n${err?.message ?? err}`);
    }
  }
}

export function pickAndImport() { pickFilesLocal(ACCEPT_ALL, importFiles); }

// ── Setup ──
export function setupFileInterop() {
  ctx.world.scene.three.add(auxGroup);
  ctx.features.fileInterop = {
    importFiles, pickAndImport, ACCEPT_ALL,
    getAuxBox, getAuxObjects, clearAux, restoreAux,
  };

  // --- Autodesk dialog event bridge --------------------------------
  // The "Import from Autodesk Viewer" dialog dispatches a CustomEvent
  // after a file drop. We catch it here and route it into importFiles().
  const dialogDropHandler = (evt: Event) => {
    const detail = (evt as CustomEvent<{ file?: File; blob?: Blob; name?: string }>).detail || {};
    const candidates: File[] = [];
    if (detail.file instanceof File) candidates.push(detail.file);
    if (detail.blob instanceof Blob) {
      const n = detail.name || "imported.glb";
      candidates.push(new File([detail.blob], n));
    }
    const evtAny = evt as any;
    if (evtAny.file instanceof File) candidates.push(evtAny.file);

    if (candidates.length) {
      void importFiles(candidates);
    } else {
      console.warn("[file-interop] dialog event had no usable file:", evt);
    }
  };

  const EVENT_NAMES = [
    "openbimstudio:load-geometry",
    "openbimstudio:load-glb",
    "openbimstudio:load-file",
    "obs:load-geometry",
    "obs:load-glb",
    "obs:load-file",
    "obs:import-file",
  ];
  for (const n of EVENT_NAMES) {
    window.addEventListener(n, dialogDropHandler as EventListener);
  }
  console.log("[file-interop] Autodesk dialog bridge installed.");
}

