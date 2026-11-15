/**
 * Fuzz child: parse one (possibly mutated) IFC buffer in an isolated process.
 *
 * The parent (scripts/fuzz-ifc-corpus.mjs) runs this with a capped heap
 * (--max-old-space-size=512) so parser over-allocation on adversarial bytes
 * kills ONLY this process, not the gate. Prints exactly one outcome token:
 *   ok | typed-error
 * A kill/signal/crash leaves the token missing — the parent classifies it.
 */
import { IfcAPI } from "web-ifc";
import { readFileSync } from "fs";

const file = process.argv[2];
if (!file) process.exit(2);

const ifc = new IfcAPI();
await ifc.Init();

let model = -1;
try {
  model = ifc.OpenModel(new Uint8Array(readFileSync(file)));
  ifc.GetModelSchema(model);
  console.log("ok");
} catch {
  console.log("typed-error");
} finally {
  if (model >= 0) {
    try { ifc.CloseModel(model); } catch { /* already gone */ }
  }
}
process.exit(0);
