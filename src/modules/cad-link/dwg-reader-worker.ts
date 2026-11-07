/**
 * DWG reader worker. Thin boundary: bytes in -> DxfDocument JSON out.
 *
 * Runs the @mlightcad/libredwg-web wasm in an isolated module worker so the
 * embind runtime's dynamic invoker generation (`new Function`) never executes
 * under the strict main-document CSP. The worker document is served with its
 * own scoped CSP (see vite.config.ts / vercel.json / public/_headers); the
 * worker has no DOM, no BIM state and no network I/O beyond loading its own
 * wasm asset from the same origin.
 */
import { parseDwgBytes, extractDwgThumbnail, toDwgParseError } from "./dwg-parse-core";
import type { DwgReaderRequest, DwgReaderResponse } from "./dwg-reader-protocol";

self.addEventListener("message", (ev: MessageEvent<DwgReaderRequest>) => {
  const req = ev.data;
  if (!req || typeof req.id !== "number") return;
  const post = (res: DwgReaderResponse) => (self as unknown as Worker).postMessage(res);
  if (req.kind === "thumbnail") {
    post({ id: req.id, kind: "started" });
    extractDwgThumbnail(req.bytes, req.fileName)
      .then((thumb): DwgReaderResponse => ({ id: req.id, kind: "thumbnail", ok: true, mime: thumb.mime, dataB64: thumb.dataB64 }))
      .catch((e): DwgReaderResponse => {
        const { code, message, detail } = toDwgParseError(e);
        return { id: req.id, kind: "thumbnail", ok: false, code, message, detail };
      })
      .then(post);
    return;
  }
  if (req.kind !== "parse") return;
  // Ack before touching the bytes: the worker processes messages sequentially,
  // so this also tells the main thread when its parse timer actually starts.
  post({ id: req.id, kind: "started" });
  parseDwgBytes(req.bytes, req.fileName)
    .then((res): DwgReaderResponse => ({
      id: req.id,
      ok: true,
      doc: res.doc,
      summary: res.summary,
      version: res.version,
      entityCount: res.entityCount,
    }))
    .catch((e): DwgReaderResponse => {
      const { code, message, detail } = toDwgParseError(e);
      return { id: req.id, ok: false, code, message, detail };
    })
    .then((res) => {
      // Transfer the doc back; DxfDocument is plain JSON data.
      post(res);
    });
});
