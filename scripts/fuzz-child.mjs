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
import { validateIfcStepSyntax } from "../src/modules/ifc-semantics/step-preflight.ts";

const file = process.argv[2];
if (!file) process.exit(2);

const bytes = readFileSync(file);
const syntaxErrors = validateIfcStepSyntax(bytes);
if (syntaxErrors.length) {
  console.log("ready");
  console.log("typed-error");
  process.exit(0);
}

const ifc = new IfcAPI();
await ifc.Init();
console.log("ready");

let model = -1;
try {
  model = ifc.OpenModel(bytes);
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
