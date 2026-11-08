/**
 * View STEP / IGES / BREP (occt-import-js) and Rhino .3dm (rhino3dm) files as tessellated, view-only geometry.
 * Both readers are prebuilt WebAssembly vendored under public/vendor/ by the "Vendor CAD readers" workflow
 * (docs/COMPATIBILITY.md). Everything runs in the browser tab; nothing is uploaded. Pure logic: src/modules/solids/solid-core.ts.
 * Large files are decoded on the main thread and can freeze the tab for a while; there is a size cap.
 */
import * as THREE from "three";
import { isWasmBytes } from "../modules/rvt/rvt-core";
import {
  has3dmHeader, looksLikeIges, looksLikeStep, occtToParts, rhinoUnitScale, solidKind, summarizeSolids, toAppAxes,
  type SolidKind, type SolidPart,
} from "../modules/solids/solid-core";

const MAX_BYTES = 200 * 1024 * 1024;
const DIRS = { occt: "/vendor/occt/", rhino: "/vendor/rhino3dm/" } as const;
const status = new Map<string, Promise<{ ok: boolean; why: string }>>();

/** Why a vendored reader can or cannot be used. A missing file on an SPA host answers 200 + HTML, so the bytes are checked. */
export function solidReaderStatus(which: keyof typeof DIRS): Promise<{ ok: boolean; why: string }> {
  const file = which === "occt" ? "occt-import-js" : "rhino3dm";
  const p = status.get(which) ?? (async () => {
    try {
      const [w, j] = await Promise.all([fetch(`${DIRS[which]}${file}.wasm`, { cache: "no-cache" }), fetch(`${DIRS[which]}${file}.js`, { cache: "no-cache" })]);
      if (!w.ok || !j.ok) return { ok: false, why: `the reader files answered ${w.status}/${j.status}` };
      if (!isWasmBytes(new Uint8Array(await w.arrayBuffer()).subarray(0, 4))) return { ok: false, why: "the host returned a web page instead of the WebAssembly file, so the reader was not deployed" };
      if (/html/i.test(j.headers.get("content-type") ?? "")) return { ok: false, why: "the reader script is a web page, so it was not deployed" };
      return { ok: true, why: "" };
    } catch (e) { return { ok: false, why: `could not fetch the reader (${e instanceof Error ? e.message : e})` }; }
  })();
  status.set(which, p);
  return p;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

let occtP: Promise<any> | null = null;
function occt(): Promise<any> {
  occtP ??= (async () => {
    if (!(window as any).occtimportjs) await loadScript(DIRS.occt + "occt-import-js.js");
    return (window as any).occtimportjs({ locateFile: (f: string) => DIRS.occt + f });
  })();
  occtP.catch(() => { occtP = null; });
  return occtP;
}
let rhinoP: Promise<any> | null = null;
function rhino(): Promise<any> {
  rhinoP ??= (async () => {
    if (!(window as any).rhino3dm) await loadScript(DIRS.rhino + "rhino3dm.js");
    return (window as any).rhino3dm({ locateFile: (f: string) => DIRS.rhino + f });
  })();
  rhinoP.catch(() => { rhinoP = null; });
  return rhinoP;
}

export function isSolidName(name: string): boolean { return solidKind(name) !== null; }

export function buildSolidGroup(parts: SolidPart[], label: string): THREE.Group {
  const g = new THREE.Group();
  g.name = label;
  for (const p of parts) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
    if (p.normals) geo.setAttribute("normal", new THREE.BufferAttribute(p.normals, 3)); else geo.computeVertexNormals();
    geo.setIndex(new THREE.BufferAttribute(p.indices, 1));
    const color = p.color ? new THREE.Color(p.color[0], p.color[1], p.color[2]) : new THREE.Color(0xb9c2cc);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    m.name = p.name;
    g.add(m);
  }
  return g;
}

export interface SolidOpenResult { object: THREE.Object3D | null; message: string; ok: boolean }

const MISSING = (what: string, why: string, how: string) => ({
  object: null, ok: false,
  message: `Viewing ${what} files directly is not installed on this deployment (${why}). ${how}`,
});

async function openOcct(bytes: Uint8Array, name: string, kind: Exclude<SolidKind, "3dm">): Promise<SolidOpenResult> {
  const st = await solidReaderStatus("occt");
  if (!st.ok) return MISSING("STEP / IGES / BREP", st.why, "Export to a mesh format such as GLB or OBJ from your CAD program, or to IFC, and open that instead. The administrator can follow docs/COMPATIBILITY.md.");
  if (kind === "step" && !looksLikeStep(bytes)) return { object: null, ok: false, message: `"${name}" does not look like a STEP file (no ISO-10303-21 header).` };
  if (kind === "iges" && !looksLikeIges(bytes)) return { object: null, ok: false, message: `"${name}" does not look like an IGES file (fixed 80-column format expected).` };
  const lib = await occt();
  const fn = kind === "step" ? "ReadStepFile" : kind === "iges" ? "ReadIgesFile" : "ReadBrepFile";
  // linearUnit "meter" makes the reader convert from the file's own length unit to metres (checked in CI). BREP files carry no units.
  const res = lib[fn](bytes, { linearUnit: "meter" });
  if (!res?.success) return { object: null, ok: false, message: `Could not read "${name}": the reader reported a failure (damaged or unsupported file).` };
  const { parts, warnings, triangles } = occtToParts(res, 1);
  if (!parts.length) return { object: null, ok: false, message: `"${name}" was read but holds no surfaces that could be drawn (wireframe-only or empty).` };
  const unitsNote = kind === "brep" ? "BREP files carry no units: shown 1 file unit = 1 metre; scale it if it looks wrong." : "Length units converted to metres from the file's own units.";
  return { object: buildSolidGroup(parts, name), ok: true, message: summarizeSolids({ fileName: name, kind, parts: parts.length, triangles, unitsNote, warnings }) };
}

async function open3dm(bytes: Uint8Array, name: string): Promise<SolidOpenResult> {
  const st = await solidReaderStatus("rhino");
  if (!st.ok) return MISSING("Rhino 3dm", st.why, "In Rhino use File → Export and save as GLB, OBJ or IFC, and open that instead. The administrator can follow docs/COMPATIBILITY.md.");
  if (!has3dmHeader(bytes)) return { object: null, ok: false, message: `"${name}" does not look like a Rhino 3dm file (bad header).` };
  const R = await rhino();
  const doc = R.File3dm.fromByteArray(bytes);
  if (!doc) return { object: null, ok: false, message: `Could not read "${name}" (damaged file, or newer than this reader supports).` };
  const unit = rhinoUnitScale(doc.settings?.()?.modelUnitSystem?.value ?? doc.settings?.()?.modelUnitSystem);
  const parts: SolidPart[] = [];
  const skipped: Record<string, number> = {};
  const note = (t: string) => { skipped[t] = (skipped[t] ?? 0) + 1; };
  const take = (mesh: any, label: string) => {
    const raw = mesh.toThreejsJSON?.();
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    const pos = j?.data?.attributes?.position?.array, idx = j?.data?.index?.array;
    if (!pos?.length || !idx?.length) return false;
    const nrm = j.data.attributes.normal?.array;
    const positions = Float32Array.from(pos as ArrayLike<number>, (v) => v * unit.scale);
    parts.push(toAppAxes({ name: label, color: null, positions, normals: nrm && nrm.length === pos.length ? Float32Array.from(nrm as ArrayLike<number>) : null, indices: Uint32Array.from(idx as ArrayLike<number>) }));
    return true;
  };
  const objs = doc.objects();
  const count = objs.count as number;
  for (let i = 0; i < count; i++) {
    const o = objs.get(i);
    const g = o.geometry();
    const t: number = g.objectType?.value ?? g.objectType;
    const label = o.attributes?.().name || `Object ${i + 1}`;
    try {
      if (t === 32) { if (!take(g, label)) note("empty meshes"); }                    // Mesh
      else if (t === 16) {                                                           // Brep: only its cached render meshes can be drawn
        let any = false;
        const faces = g.faces();
        for (let f = 0; f < faces.count; f++) { const m = faces.get(f).getMesh(R.MeshType.Any); if (m && take(m, label)) any = true; }
        if (!any) note("surface models without a render mesh");
      } else if (t === 4) note("curves"); else if (t === 1) note("points"); else if (t === 512) note("annotations");
      else if (t === 4096) note("block instances"); else if (t === 1073741824) note("extrusions");
      else if (t === 262144) note("SubD surfaces"); else note("other objects");
    } catch { note("objects that failed to convert"); }
  }
  const triangles = parts.reduce((s, p) => s + Math.floor(p.indices.length / 3), 0);
  if (!parts.length) return { object: null, ok: false, message: summarizeSolids({ fileName: name, kind: "3dm", parts: 0, triangles: 0, unitsNote: "", warnings: ["Nothing drawable: this reader only draws meshes and surface models that were saved with render meshes."], skippedTypes: skipped }) };
  const warnings = unit.known ? [] : ["The file has no recognised length unit: shown 1 file unit = 1 metre."];
  return { object: buildSolidGroup(parts, name), ok: true, message: summarizeSolids({ fileName: name, kind: "3dm", parts: parts.length, triangles, unitsNote: `Length unit: ${unit.label}.`, warnings, skippedTypes: skipped }) };
}

export async function openSolid(buf: ArrayBuffer, name: string): Promise<SolidOpenResult> {
  const kind = solidKind(name);
  if (!kind) return { object: null, ok: false, message: `"${name}" is not a STEP, IGES, BREP or Rhino 3dm file.` };
  if (buf.byteLength > MAX_BYTES) return { object: null, ok: false, message: `"${name}" is ${(buf.byteLength / 1048576).toFixed(0)} MB; files over ${MAX_BYTES / 1048576} MB are refused because they are read on the main thread and would freeze the tab.` };
  const bytes = new Uint8Array(buf);
  try { return kind === "3dm" ? await open3dm(bytes, name) : await openOcct(bytes, name, kind); }
  catch (e) { return { object: null, ok: false, message: `Could not read "${name}": ${e instanceof Error ? e.message : String(e)}` }; }
}
