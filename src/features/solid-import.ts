/**
 * View STEP / IGES / BREP (occt-import-js) and Rhino .3dm (rhino3dm) files as tessellated, view-only geometry.
 * Both readers are prebuilt WebAssembly vendored under public/vendor/ by the "Vendor CAD readers" workflow
 * (docs/COMPATIBILITY.md). Everything runs in this browser tab; nothing is uploaded. Pure logic: src/modules/solids/solid-core.ts.
 *
 * The wasm readers are parsed in an isolated reader worker (solid-reader-worker.ts): the emscripten glue
 * evaluates JavaScript strings during startup, which the main-document CSP deliberately forbids (a real-browser
 * session on 2026-11-16 failed every import with that CSP error). The worker is served with a scoped CSP that
 * allows dynamic execution only in that document; bytes in, triangle buffers out — see solid-reader-protocol.ts.
 */
import * as THREE from "three";
import { isWasmBytes } from "../modules/rvt/rvt-core";
import {
  has3dmHeader, looksLikeIges, looksLikeStep, solidKind, summarizeSolids,
  type SolidKind,
} from "../modules/solids/solid-core";
import type { SolidReaderRequest, SolidReaderResponse, SolidReaderSuccess } from "../modules/solids/solid-reader-protocol";

const MAX_BYTES = 200 * 1024 * 1024;
/** Worker parse timeout: large assemblies take a while; past this the request is cancelled. */
const SOLID_PARSE_TIMEOUT_MS = 180_000;
const status = new Map<string, Promise<{ ok: boolean; why: string }>>();

/** Why a vendored reader can or cannot be used. A missing file on an SPA host answers 200 + HTML, so the bytes are checked. */
export function solidReaderStatus(which: "occt" | "rhino"): Promise<{ ok: boolean; why: string }> {
  const file = which === "occt" ? "occt-import-js" : "rhino3dm";
  const p = status.get(which) ?? (async () => {
    try {
      const [w, j] = await Promise.all([fetch(`/vendor/${which === "occt" ? "occt/occt-import-js" : "rhino3dm/rhino3dm"}.wasm`, { cache: "no-cache" }), fetch(`/vendor/${which === "occt" ? "occt/occt-import-js" : "rhino3dm/rhino3dm"}.js`, { cache: "no-cache" })]);
      if (!w.ok || !j.ok) return { ok: false, why: `the reader files answered ${w.status}/${j.status}` };
      if (!isWasmBytes(new Uint8Array(await w.arrayBuffer()).subarray(0, 4))) return { ok: false, why: "the host returned a web page instead of the WebAssembly file, so the reader was not deployed" };
      if (/html/i.test(j.headers.get("content-type") ?? "")) return { ok: false, why: "the reader script is a web page, so it was not deployed" };
      return { ok: true, why: "" };
    } catch (e) { return { ok: false, why: `could not fetch the reader (${e instanceof Error ? e.message : e})` }; }
  })();
  status.set(which, p);
  return p;
}

export function buildSolidGroup(parts: SolidReaderSuccess["parts"], label: string): THREE.Group {
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

// ---------------------------------------------------------------------------
// Reader worker client (one shared worker; bytes are transferred, results come
// back as triangle buffers — see solid-reader-protocol.ts).
// ---------------------------------------------------------------------------
let readerWorker: Worker | null = null;
let readerWorkerFailed = false;
let nextId = 1;
const pending = new Map<number, {
  resolve: (r: SolidReaderSuccess) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  fileName: string;
}>();

function failAllPending(message: string): void {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(message)); }
  pending.clear();
}

function resetReaderWorker(): void {
  if (readerWorker) { try { readerWorker.terminate(); } catch { /* */ } }
  readerWorker = null;
}

function ensureReaderWorker(): Worker {
  if (readerWorker) return readerWorker;
  if (readerWorkerFailed) {
    throw new Error("the solid reader worker could not start in this browser (Web Workers unavailable)");
  }
  try {
    readerWorker = new Worker(new URL("../modules/solids/solid-reader-worker.ts", import.meta.url), {
      type: "module",
      name: "obs-solid-reader-worker",
    });
  } catch (err) {
    readerWorkerFailed = true;
    throw new Error(`the solid reader worker could not start: ${err instanceof Error ? err.message : String(err)}`);
  }
  readerWorker.addEventListener("message", (ev: MessageEvent<SolidReaderResponse>) => {
    const res = ev.data;
    const p = res && typeof res.id === "number" ? pending.get(res.id) : undefined;
    if (!p) return;
    if (res.kind === "started") {
      // The worker picked up this parse: now (and only now) does the parse
      // timeout start — earlier requests in the queue must not eat into it.
      clearTimeout(p.timer);
      p.timer = setTimeout(() => {
        pending.delete(res.id);
        resetReaderWorker(); // cancel = terminate the parser; the next import gets a fresh worker
        p.reject(new Error(
          `${p.fileName}: the solid reader did not finish within ${Math.round(SOLID_PARSE_TIMEOUT_MS / 1000)}s and was cancelled. The model may be very large — retry once (the reader warms up), or export a lighter mesh format such as GLB or OBJ.`,
        ));
      }, SOLID_PARSE_TIMEOUT_MS);
      return;
    }
    if (res.kind !== "done") return;
    pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok) p.resolve(res);
    else p.reject(new Error(res.message || "the solid reader failed"));
  });
  readerWorker.addEventListener("error", (ev: ErrorEvent) => {
    failAllPending(`the solid reader worker crashed: ${ev.message || "unknown error"}`);
    resetReaderWorker(); // next import respawns a fresh worker and retries
  });
  return readerWorker;
}

/** One parse request through the reader worker (transfer the bytes, get buffers back). */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
function parseInWorker(req: DistOmit<SolidReaderRequest, "id">, fileName: string): Promise<SolidReaderSuccess> {
  const worker = ensureReaderWorker();
  const id = nextId++;
  return new Promise<SolidReaderSuccess>((resolve, reject) => {
    pending.set(id, {
      resolve, reject,
      timer: setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${fileName}: the solid reader did not start in time and was cancelled.`));
      }, SOLID_PARSE_TIMEOUT_MS),
      fileName,
    });
    const transfer: Transferable[] = [req.bytes];
    worker.postMessage({ ...req, id }, transfer);
  });
}

async function openOcct(bytes: Uint8Array, name: string, kind: Exclude<SolidKind, "3dm">): Promise<SolidOpenResult> {
  const st = await solidReaderStatus("occt");
  if (!st.ok) return MISSING("STEP / IGES / BREP", st.why, "Export to a mesh format such as GLB or OBJ from your CAD program, or to IFC, and open that instead. The administrator can follow docs/COMPATIBILITY.md.");
  if (kind === "step" && !looksLikeStep(bytes)) return { object: null, ok: false, message: `"${name}" does not look like a STEP file (no ISO-10303-21 header).` };
  if (kind === "iges" && !looksLikeIges(bytes)) return { object: null, ok: false, message: `"${name}" does not look like an IGES file (fixed 80-column format expected).` };
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const res = await parseInWorker({ kind: "occt", fileKind: kind, bytes: buf, fileName: name }, name);
  if (!res.parts.length) return { object: null, ok: false, message: `"${name}" was read but holds no surfaces that could be drawn (wireframe-only or empty).` };
  const unitsNote = kind === "brep" ? "BREP files carry no units: shown 1 file unit = 1 metre; scale it if it looks wrong." : "Length units converted to metres from the file's own units.";
  return { object: buildSolidGroup(res.parts, name), ok: true, message: summarizeSolids({ fileName: name, kind, parts: res.parts.length, triangles: res.triangles, unitsNote, warnings: res.warnings }) };
}

async function open3dm(bytes: Uint8Array, name: string): Promise<SolidOpenResult> {
  const st = await solidReaderStatus("rhino");
  if (!st.ok) return MISSING("Rhino 3dm", st.why, "In Rhino use File → Export and save as GLB, OBJ or IFC, and open that instead. The administrator can follow docs/COMPATIBILITY.md.");
  if (!has3dmHeader(bytes)) return { object: null, ok: false, message: `"${name}" does not look like a Rhino 3dm file (bad header).` };
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const res = await parseInWorker({ kind: "rhino", bytes: buf, fileName: name }, name);
  if (!res.parts.length) return { object: null, ok: false, message: summarizeSolids({ fileName: name, kind: "3dm", parts: 0, triangles: 0, unitsNote: "", warnings: ["Nothing drawable: this reader only draws meshes and surface models that were saved with render meshes."], skippedTypes: res.skippedTypes }) };
  const warnings = res.unitKnown ? res.warnings : ["The file has no recognised length unit: shown 1 file unit = 1 metre."];
  return { object: buildSolidGroup(res.parts, name), ok: true, message: summarizeSolids({ fileName: name, kind: "3dm", parts: res.parts.length, triangles: res.triangles, unitsNote: `Length unit: ${res.unitLabel ?? "metres"}.`, warnings, skippedTypes: res.skippedTypes }) };
}

export async function openSolid(buf: ArrayBuffer, name: string): Promise<SolidOpenResult> {
  const kind = solidKind(name);
  if (!kind) return { object: null, ok: false, message: `"${name}" is not a STEP, IGES, BREP or Rhino 3dm file.` };
  if (buf.byteLength > MAX_BYTES) return { object: null, ok: false, message: `"${name}" is ${(buf.byteLength / 1048576).toFixed(0)} MB; files over ${MAX_BYTES / 1048576} MB are refused to keep memory use sane (the reader holds the whole mesh in wasm memory).` };
  const bytes = new Uint8Array(buf);
  try { return kind === "3dm" ? await open3dm(bytes, name) : await openOcct(bytes, name, kind); }
  catch (e) { return { object: null, ok: false, message: `Could not read "${name}": ${e instanceof Error ? e.message : String(e)}` }; }
}
