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
import { validateDwgReaderRequest } from "./dwg-reader-protocol";
import type { DwgReaderRequest, DwgReaderResponse } from "./dwg-reader-protocol";

self.addEventListener("message", (ev: MessageEvent<DwgReaderRequest>) => {
  const req = ev.data;
  const post = (res: DwgReaderResponse) => (self as unknown as Worker).postMessage(res);
  // Validate the request payload before the bytes reach the wasm parser
  // (issue #90): a malformed request fails as a typed `invalid-file` error
  // instead of crashing the worker or hanging the main thread's timeout.
  // Without a numeric id there is no pending entry to answer, so drop it.
  const checked = validateDwgReaderRequest(req);
  if (!checked.ok) {
    if (checked.id !== null) {
      post((req as { kind?: unknown } | null)?.kind === "thumbnail"
        ? { id: checked.id, kind: "thumbnail", ok: false, code: "invalid-file", message: checked.message }
        : { id: checked.id, ok: false, code: "invalid-file", message: checked.message });
    }
    return;
  }
  const valid = checked.request;
  if (valid.kind === "thumbnail") {
    post({ id: valid.id, kind: "started" });
    extractDwgThumbnail(valid.bytes, valid.fileName)
      .then((thumb): DwgReaderResponse => ({ id: valid.id, kind: "thumbnail", ok: true, mime: thumb.mime, dataB64: thumb.dataB64 }))
      .catch((e): DwgReaderResponse => {
        const { code, message, detail } = toDwgParseError(e);
        return { id: valid.id, kind: "thumbnail", ok: false, code, message, detail };
      })
      .then(post);
    return;
  }
  // Ack before touching the bytes: the worker processes messages sequentially,
  // so this also tells the main thread when its parse timer actually starts.
  post({ id: valid.id, kind: "started" });
  parseDwgBytes(valid.bytes, valid.fileName)
    .then((res): DwgReaderResponse => ({
      id: valid.id,
      ok: true,
      doc: res.doc,
      summary: res.summary,
      version: res.version,
      entityCount: res.entityCount,
    }))
    .catch((e): DwgReaderResponse => {
      const { code, message, detail } = toDwgParseError(e);
      return { id: valid.id, ok: false, code, message, detail };
    })
    .then((res) => {
      // Transfer the doc back; DxfDocument is plain JSON data.
      post(res);
    });
});
