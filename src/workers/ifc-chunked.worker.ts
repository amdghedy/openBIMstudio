/**
 * Converts a (large) IFC File to FRAG off the main thread. web-ifc reads the
 * file through a chunked callback, so the CONVERSION never holds the whole file
 * as one JS ArrayBuffer. NOTE: the STEP preflight below DOES make one transient
 * whole-file read (see Safety), so peak memory is still ~file size briefly.
 *
 * The @thatopen/fragments IfcImporter accepts `readFromCallback` + a
 * synchronous `readCallback(offset, size)` (web-ifc OpenModelFromCallback).
 * A synchronous read of a File slice is only possible in a worker
 * (FileReaderSync), which is why this runs here and not on the main thread.
 *
 *   main -> worker: { type: "convert", file: File, wasmPath: string, coordToPlace?: number[] }
 *   worker -> main: { type: "progress", progress, data }
 *                 | { type: "ready", frag: Uint8Array } | { type: "error", message }
 *
 * Safety: the same whole-file structural STEP preflight the main-thread path
 * runs (hang-class corruption, issue #231) runs HERE first, on a transient
 * in-worker read of the file that is released before web-ifc opens it. A
 * preflight scan that is slow cannot freeze the page, and the worker can be
 * terminated. If the browser cannot allocate that transient buffer the
 * conversion fails visibly; it never skips the check.
 *
 * Honest limit: this removes the whole-file JS copy during conversion (not
 * during the preflight) and keeps the page
 * responsive/terminable. It does NOT by itself guarantee that the parsed
 * model of a multi-GB IFC fits the 32-bit WASM heap.
 */
import * as WEBIFC from "web-ifc";
import * as FRAGS from "@thatopen/fragments";
import { preflightStep } from "../modules/ifc-semantics/step-preflight";

const post = (m: unknown, t?: Transferable[]) =>
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(m, t);

// Same single-thread forcing as importer.ts getImporter(): never pick web-ifc's MT build.
try {
  const proto = (WEBIFC as any).IfcAPI?.prototype;
  if (proto && typeof proto.Init === "function" && !proto.Init.__obsForcedST) {
    const orig = proto.Init;
    proto.Init = function (handler?: any, _f?: boolean) { return orig.call(this, handler, true); };
    proto.Init.__obsForcedST = true;
  }
} catch { /* ignore */ }

self.addEventListener("message", async (ev: MessageEvent) => {
  const msg = ev.data;
  if (!msg || msg.type !== "convert") return;
  try {
    const file: File = msg.file;
    const reader = new (self as any).FileReaderSync();
    const size = file.size;
    post({ type: "phase", text: "validating STEP structure (worker)…" });
    {
      let whole: Uint8Array | null = new Uint8Array(reader.readAsArrayBuffer(file));
      const pre = preflightStep(whole);
      whole = null; // release before web-ifc opens the file
      if (!pre.ok) {
        throw new Error(`This file is not a valid IFC (STEP) file: ${pre.reason}${pre.line ? ` (line ${pre.line})` : ""}. It was not opened.`);
      }
    }
    post({ type: "phase", text: "streaming file into web-ifc worker…" });
    const importer: any = new FRAGS.IfcImporter();
    importer.wasm = { absolute: true, path: String(msg.wasmPath) };
    importer.webIfcSettings = importer.webIfcSettings ?? {};
    importer.webIfcSettings.COORDINATE_TO_ORIGIN = false; // same as importer.ts
    const settings: any = {
      readFromCallback: true,
      readCallback: (offset: number, length: number): Uint8Array => {
        const end = Math.min(size, offset + length);
        if (offset >= end) return new Uint8Array(0);
        return new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, end)));
      },
      progressCallback: (progress: number, data?: unknown) =>
        post({ type: "progress", progress, data: data ? JSON.parse(JSON.stringify(data)) : undefined }),
    };
    if (Array.isArray(msg.coordToPlace)) settings.coordToPlace = msg.coordToPlace;
    const out: Uint8Array = await importer.process(settings);
    const frag = out.slice(); // detach from WASM-backed memory
    post({ type: "ready", frag }, [frag.buffer as ArrayBuffer]);
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
});
