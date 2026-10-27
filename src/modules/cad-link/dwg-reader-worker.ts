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
import { parseDwgBytes, toDwgParseError } from "./dwg-parse-core";
import type { DwgParseRequest, DwgParseResponse } from "./dwg-reader-protocol";

self.addEventListener("message", (ev: MessageEvent<DwgParseRequest>) => {
  const req = ev.data;
  if (!req || typeof req.id !== "number" || req.kind !== "parse") return;
  parseDwgBytes(req.bytes, req.fileName)
    .then((res): DwgParseResponse => ({
      id: req.id,
      ok: true,
      doc: res.doc,
      summary: res.summary,
      version: res.version,
      entityCount: res.entityCount,
    }))
    .catch((e): DwgParseResponse => {
      const { code, message, detail } = toDwgParseError(e);
      return { id: req.id, ok: false, code, message, detail };
    })
    .then((res) => {
      // Transfer the doc back; DxfDocument is plain JSON data.
      (self as unknown as Worker).postMessage(res);
    });
});
