/**
 * Open Revit files (.rvt / .rfa) for VIEWING, inside the browser tab.
 * Nothing is uploaded: the file is decoded by the rvt-rs WebAssembly reader in
 * a worker and the result is added to the scene as view-only geometry (like an
 * imported mesh: no BIM properties, not part of clash tests or authoring).
 * See src/modules/rvt/rvt-core.ts and docs/RVT-VIEWER.md.
 */
import { notify } from "../core/notify";
import { RVT_JS_URL, RVT_WASM_URL, isRevitName, isWasmBytes, preflight, summarizeDiagnostics, viewFileName, type RvtDiagnostics } from "../modules/rvt/rvt-core";

let availability: Promise<{ ok: boolean; why: string }> | null = null;

/** Why the decoder can or cannot be used on this deployment. A missing file on an SPA host answers 200 + HTML, so the bytes are checked. */
export function rvtDecoderStatus(): Promise<{ ok: boolean; why: string }> {
  availability ??= (async () => {
    try {
      const [w, j] = await Promise.all([fetch(RVT_WASM_URL, { cache: "no-cache" }), fetch(RVT_JS_URL, { cache: "no-cache" })]);
      if (!w.ok) return { ok: false, why: `${RVT_WASM_URL} answered ${w.status}` };
      if (!j.ok) return { ok: false, why: `${RVT_JS_URL} answered ${j.status}` };
      const head = new Uint8Array(await w.arrayBuffer()).subarray(0, 4);
      if (!isWasmBytes(head)) return { ok: false, why: `${RVT_WASM_URL} is not a WebAssembly file (the host returned a web page, so the decoder was not deployed)` };
      if (/html/i.test(j.headers.get("content-type") ?? "")) return { ok: false, why: `${RVT_JS_URL} is a web page, not the decoder` };
      return { ok: true, why: "" };
    } catch (e) { return { ok: false, why: `could not fetch the decoder (${e instanceof Error ? e.message : e})` }; }
  })();
  return availability;
}

export async function rvtDecoderAvailable(): Promise<boolean> { return (await rvtDecoderStatus()).ok; }

const UNAVAILABLE =
  "Viewing Revit files directly is not installed on this deployment (the decoder was not built into it). " +
  "In Revit use File → Export → IFC and open the .ifc here instead, or ask the administrator to follow docs/RVT-VIEWER.md.";

interface Ready { glb: Uint8Array; diagnostics: RvtDiagnostics }

function decodeInWorker(bytes: Uint8Array, onProgress: (t: string) => void, largeModel: boolean): Promise<Ready> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("../workers/rvt.worker.ts", import.meta.url), { type: "module", name: "obs-rvt-worker" });
    const done = () => w.terminate();
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m?.type === "progress") onProgress(m.text);
      else if (m?.type === "stage") onProgress(`Decoding: ${m.stage}${m.total ? ` ${Math.round((m.done / m.total) * 100)}%` : ""}`);
      else if (m?.type === "ready") { done(); resolve({ glb: m.glb, diagnostics: m.diagnostics }); }
      else if (m?.type === "error") { done(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { done(); reject(new Error(e.message || "The Revit decoder stopped unexpectedly.")); };
    // Copy: the original bytes stay usable if a retry is needed.
    const copy = bytes.slice();
    w.postMessage({ type: "parse", bytes: copy, largeModel }, [copy.buffer]);
  });
}

export async function openRevitFile(file: File): Promise<boolean> {
  if (!isRevitName(file.name)) { notify("error", `"${file.name}" is not a Revit file.`); return false; }
  const st = await rvtDecoderStatus();
  if (!st.ok) { console.warn("[rvt] decoder unavailable:", st.why); notify("error", `${UNAVAILABLE} (Detail: ${st.why}.)`, { timeout: 16000 }); return false; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pre = preflight(file.name, bytes);
  if (!pre.ok) { notify("error", pre.reason, { timeout: 12000 }); return false; }
  if (pre.warn) notify("warn", pre.warn);

  notify("info", `Reading ${file.name} in your browser (nothing is uploaded)…`);
  let result: Ready;
  try {
    result = await decodeInWorker(bytes, () => { /* progress is shown once, at the end, to keep toasts quiet */ }, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    notify("error", `Could not read "${file.name}": ${msg}. Try exporting IFC from Revit.`, { timeout: 14000 });
    return false;
  }

  // Count what will actually be drawn, so "nothing to draw" is reported instead of an empty scene.
  let triangles = 0;
  try {
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().parseAsync(result.glb.buffer.slice(result.glb.byteOffset, result.glb.byteOffset + result.glb.byteLength) as ArrayBuffer, "");
    gltf.scene.traverse((o: any) => { if (o.isMesh && o.geometry) triangles += (o.geometry.index?.count ?? o.geometry.attributes?.position?.count ?? 0) / 3; });
  } catch { triangles = 0; }

  const summary = summarizeDiagnostics(result.diagnostics, triangles);
  if (!summary.drawable) { notify("warn", summary.headline, { timeout: 16000 }); return false; }

  const { importFiles } = await import("./file-interop");
  await importFiles([new File([result.glb as BlobPart], viewFileName(file.name), { type: "model/gltf-binary" })]);
  notify("info", summary.headline + " View-only: no Revit parameters, and not part of clash tests.", { timeout: 16000 });
  return true;
}

export function pickRevitFile(): void {
  const input = document.createElement("input");
  input.type = "file"; input.accept = ".rvt,.rfa,.rte,.rft";
  input.onchange = () => { const f = input.files?.[0]; if (f) void openRevitFile(f); };
  input.click();
}
