/**
 * Runs the rvt-rs WebAssembly decoder off the main thread.
 * The decoder (/rvt/rvt.js + rvt_bg.wasm) is a build artifact of
 * scripts/build-rvt-wasm.mjs; the page checks it exists before starting this worker.
 *
 *   main -> worker: { type: "parse", bytes: Uint8Array, largeModel?: boolean }
 *   worker -> main: { type: "progress", text } | { type: "stage", stage, done, total }
 *                 | { type: "ready", glb, diagnostics, phases, types, propertyCount } | { type: "error", message }
 */
import { decodeRVT, type RvtWasmApi } from "../modules/rvt/rvt-core";

const send = (m: unknown, transfer?: Transferable[]) => (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(m, transfer);
let api: (RvtWasmApi & { default: (o: { module_or_path: string }) => Promise<unknown> }) | null = null;

self.addEventListener("message", async (ev: MessageEvent) => {
  const msg = ev.data;
  if (!msg || msg.type !== "parse") return;
  try {
    if (!api) {
      send({ type: "progress", text: "Loading the RVT decoder" });
      // Same-origin file generated at build time; not part of the Vite bundle.
      api = await import(/* @vite-ignore */ new URL("/rvt/rvt.js", self.location.origin).href);
      await api!.default({ module_or_path: new URL("/rvt/rvt_bg.wasm", self.location.origin).href });
    }
    const r = decodeRVT(api!, msg.bytes as Uint8Array, {
      step: (text) => send({ type: "progress", text }),
      stage: (stage, done, total) => send({ type: "stage", stage, done, total }),
    }, { largeModel: !!msg.largeModel });
    send({ type: "ready", glb: r.glb, diagnostics: r.diagnostics, phases: r.phases, types: r.types, propertyCount: r.propertyCount }, [r.glb.buffer as ArrayBuffer]);
  } catch (e) {
    send({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
});
