/**
 * Solid reader worker. Thin boundary: bytes in -> triangle buffers out.
 *
 * Runs the vendored occt-import-js (STEP / IGES / BREP) and rhino3dm (.3dm)
 * WebAssembly readers in an isolated worker so the emscripten glue's dynamic
 * code generation never executes under the strict main-document CSP (see
 * solid-reader-protocol.ts for the full why). The worker document is served
 * with its own scoped CSP (see vite.config.ts / vercel.json /
 * public/_headers); the worker has no DOM, no BIM state and no network I/O
 * beyond loading its own vendored reader files from the same origin.
 *
 * The glue files are classic scripts (var X = (() => {...})(), UMD tails).
 * Loading strategy, in order:
 *   1. importScripts() — a classic worker defines the factory on the global
 *      scope directly. A live-browser session (2026-11-16) proved this path
 *      end to end: ReadStepFile returned a real mesh from the test cube.
 *   2. blob-module import — module workers have no importScripts, so the glue
 *      text is wrapped in a UMD shim and imported as a blob module. The glue's
 *      own dynamic code generation (rhino3dm embind) still runs inside this
 *      worker, whose scoped CSP allows it; the blob module itself is parsed as
 *      a module, which side-steps the classic-only parse failure seen when the
 *      raw glue text went through the Function constructor in a module worker.
 */
/// <reference lib="webworker" />
import {
  occtToParts, rhinoUnitScale, toAppAxes,
  type OcctResult, type SolidPart,
} from "./solid-core";
import type { SolidReaderRequest, SolidReaderResponse } from "./solid-reader-protocol";

const DIRS = { occt: "/vendor/occt/", rhino: "/vendor/rhino3dm/" } as const;
/** Largest file the reader worker accepts in one request (mirrors openSolid MAX_BYTES, 200 MB). */
export const SOLID_READER_MAX_BYTES = 200 * 1024 * 1024;
/** Glue file → the global its classic script defines. NOT derivable from the file name: "occt-import-js.js" defines `occtimportjs` (hyphens are not identifiers). */
const GLOBAL_NAMES = { "occt-import-js.js": "occtimportjs", "rhino3dm.js": "rhino3dm" } as const;

const glueCache = new Map<string, (arg?: unknown) => unknown>();

/** Path 1: classic-worker importScripts — factory lands on the worker global. */
function importScriptsGlue(dir: string, file: string, globalName: string): ((arg?: unknown) => unknown) | null {
  const imp = (self as unknown as { importScripts?: (src: string) => void }).importScripts;
  if (typeof imp !== "function") return null;
  try {
    imp(dir + file);
  } catch { return null; } // module workers define importScripts but refuse it — fall through to the blob module
  const f = (self as unknown as Record<string, unknown>)[globalName];
  return typeof f === "function" ? (f as (arg?: unknown) => unknown) : null;
}

/** Path 2: fetch the glue text and import it as a UMD-wrapped blob module. */
async function blobModuleGlue(dir: string, file: string, globalName: string): Promise<(arg?: unknown) => unknown> {
  const res = await fetch(dir + file, { cache: "no-cache" });
  if (!res.ok) throw new Error(`could not load the reader script (${res.status})`);
  const text = await res.text();
  if (!text.includes(globalName)) throw new Error(`fetched text is not the ${globalName} glue (len=${text.length} head=${JSON.stringify(text.slice(0, 80))})`);
  const wrapped =
    `const module = { exports: {} }; const exports = module.exports; const define = undefined;\n` +
    text +
    `\nexport default (typeof ${globalName} !== "undefined" ? ${globalName} : module.exports);`;
  const url = URL.createObjectURL(new Blob([wrapped], { type: "text/javascript" }));
  try {
    // Vite's dev transform rewrites literal `import(url)` calls (it appends a
    // `?import` query and pulls in the vite client), which breaks blob: module
    // imports inside the worker. Build the import through code generation so
    // the bundler never sees it; the scoped CSP of this worker allows it.
    const dynImport = new Function("u", "return import(u);") as (u: string) => Promise<{ default?: (arg?: unknown) => unknown }>;
    const mod = await dynImport(url);
    const f = mod?.default;
    if (typeof f !== "function") throw new Error("the reader script did not provide its factory");
    return f;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function glueFactory(dir: string, file: string): Promise<(arg?: unknown) => unknown> {
  const cached = glueCache.get(file);
  if (cached) return cached;
  const globalName = GLOBAL_NAMES[file as keyof typeof GLOBAL_NAMES];
  if (!globalName) throw new Error(`no known global for reader glue "${file}"`);
  const viaImportScripts = importScriptsGlue(dir, file, globalName);
  const factory = viaImportScripts ?? (await blobModuleGlue(dir, file, globalName));
  glueCache.set(file, factory);
  return factory;
}

let occtP: Promise<any> | null = null;
function occt(): Promise<any> {
  occtP ??= (async () => {
    const factory = await glueFactory(DIRS.occt, "occt-import-js.js");
    return factory({ locateFile: (f: string) => DIRS.occt + f });
  })();
  occtP.catch(() => { occtP = null; });
  return occtP;
}

let rhinoP: Promise<any> | null = null;
function rhino(): Promise<any> {
  rhinoP ??= (async () => {
    const factory = await glueFactory(DIRS.rhino, "rhino3dm.js");
    return factory({ locateFile: (f: string) => DIRS.rhino + f });
  })();
  rhinoP.catch(() => { rhinoP = null; });
  return rhinoP;
}

/** STEP / IGES / BREP → parts (same reader calls and unit handling as the main thread used to run). */
async function readOcct(req: Extract<SolidReaderRequest, { kind: "occt" }>): Promise<SolidReaderResponse> {
  const bytes = new Uint8Array(req.bytes);
  const lib = await occt();
  const fn = req.fileKind === "step" ? "ReadStepFile" : req.fileKind === "iges" ? "ReadIgesFile" : "ReadBrepFile";
  // linearUnit "meter" makes the reader convert from the file's own length unit to metres (checked in CI). BREP files carry no units.
  const res = lib[fn](bytes, { linearUnit: "meter" }) as OcctResult | undefined;
  if (!res?.success) {
    return { id: req.id, kind: "done", ok: false, code: "parse-failed", message: `the reader reported a failure (damaged or unsupported file)` };
  }
  const { parts, warnings, triangles } = occtToParts(res, 1);
  return { id: req.id, kind: "done", ok: true, parts: parts as SolidPart[], warnings, triangles };
}

/** Rhino 3dm → parts, drawing meshes and Brep render meshes, counting the rest (same policy as before). */
async function read3dm(req: Extract<SolidReaderRequest, { kind: "rhino" }>): Promise<SolidReaderResponse> {
  const bytes = new Uint8Array(req.bytes);
  const R = await rhino();
  const doc = R.File3dm.fromByteArray(bytes);
  if (!doc) return { id: req.id, kind: "done", ok: false, code: "parse-failed", message: `damaged file, or newer than this reader supports` };
  const unit = rhinoUnitScale(doc.settings?.()?.modelUnitSystem?.value ?? doc.settings?.()?.modelUnitSystem);
  const parts: SolidPart[] = [];
  const skipped: Record<string, number> = {};
  const note = (t: string) => { skipped[t] = (skipped[t] ?? 0) + 1; };
  const take = (mesh: any, label: string): boolean => {
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
  return { id: req.id, kind: "done", ok: true, parts: parts as SolidPart[], warnings: unit.known ? [] : ["The file has no recognised length unit: shown 1 file unit = 1 metre."], triangles, skippedTypes: skipped, unitLabel: unit.label, unitKnown: unit.known };
}

self.addEventListener("message", (ev: MessageEvent<SolidReaderRequest>) => {
  const req = ev.data;
  if (!req || typeof req.id !== "number" || (req.kind !== "occt" && req.kind !== "rhino")) return;
  const post = (res: SolidReaderResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(res, transfer);
  // Validate the request payload before the readers touch it (issue #90).
  // The worker is same-origin and created by the app, so this guards
  // against a buggy caller, not a remote attacker — but a malformed
  // payload must fail as a typed reader error, never crash the worker or
  // hang the main thread's 180 s timeout. Mirrors openSolid MAX_BYTES.
  if (!(req.bytes instanceof ArrayBuffer) || req.bytes.byteLength === 0 || req.bytes.byteLength > SOLID_READER_MAX_BYTES) {
    post({ id: req.id, kind: "done", ok: false, code: "invalid-file",
      message: "The reader received an invalid file payload (expected file bytes up to 200 MB)." });
    return;
  }
  post({ id: req.id, kind: "started" });
  (req.kind === "occt" ? readOcct(req) : read3dm(req))
    .then((res): SolidReaderResponse => res)
    .catch((e): SolidReaderResponse => ({
      id: req.id, kind: "done", ok: false, code: "init-failed",
      message: e instanceof Error ? e.message : String(e),
    }))
    .then((res) => {
      // Transfer the triangle buffers back without a copy when the request succeeded.
      if (res.kind !== "done" || !res.ok) { post(res); return; }
      const transfer: Transferable[] = res.parts.flatMap((p) => [p.positions.buffer as ArrayBuffer, p.indices.buffer as ArrayBuffer, ...(p.normals ? [p.normals.buffer as ArrayBuffer] : [])]);
      post(res, transfer);
    });
});
