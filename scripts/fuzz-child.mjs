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
import { pathToFileURL } from "url";

const file = process.argv[2];
const preflightModule = process.argv[3]; // transpiled src/modules/ifc-semantics/step-preflight.ts
if (!file) process.exit(2);

const ifc = new IfcAPI();
await ifc.Init();
console.log("ready");

// Same bounded structural gate the application runs before handing bytes to the WASM parser.
const bytes = new Uint8Array(readFileSync(file));
if (preflightModule) {
  const { preflightStep } = await import(pathToFileURL(preflightModule).href);
  if (!preflightStep(bytes).ok) { console.log("preflight-rejected"); console.log("typed-error"); process.exit(0); }
}

let model = -1;
try {
  console.log("opening");
  model = ifc.OpenModel(bytes);
  console.log("opened");
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
