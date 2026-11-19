/**
 * Fuzz child: parse one (possibly mutated) IFC buffer in an isolated process.
 *
 * The parent runs this with a capped 256 MB V8 heap so parser over-allocation
 * kills ONLY this process, not the gate. Emits "ready" after WASM initialization
 * so the parent can apply a separate, accurate timeout to the untrusted parse.
 * Result tokens: ready, then exactly one of ok | typed-error.
 */
import { IfcAPI } from "web-ifc";
import { readFileSync } from "fs";

const file = process.argv[2];
if (!file) process.exit(2);

const ifc = new IfcAPI();
await ifc.Init();
console.log("ready");

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
