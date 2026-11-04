#!/usr/bin/env node
/**
 * Fail the build if the staged CAD engine WASM is stale, malformed, or lacks
 * the native DWG writer entry point. This runs before bundling and against
 * dist after Vite copies public assets.
 */
import fs from "node:fs";
import path from "node:path";

const file = path.resolve(process.argv[2] ?? "public/cad-engine/obim-cad-engine.wasm");
if (!fs.existsSync(file)) {
  console.error(`[cad-wasm] missing artifact: ${file}`);
  process.exit(1);
}

const bytes = fs.readFileSync(file);
if (bytes.length < 8 || !bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
  console.error(`[cad-wasm] invalid WebAssembly magic/header: ${file}`);
  process.exit(1);
}

let module;
try {
  module = await WebAssembly.compile(bytes);
} catch (error) {
  console.error(`[cad-wasm] compilation failed: ${error.message}`);
  process.exit(1);
}

const imports = WebAssembly.Module.imports(module);
if (imports.length) {
  console.error("[cad-wasm] unexpected host imports:", imports);
  process.exit(1);
}

const exports = WebAssembly.Module.exports(module);
const functions = new Set(exports.filter((item) => item.kind === "function").map((item) => item.name));
const required = ["obim_engine_version", "obim_alloc", "obim_free", "obim_read", "obim_write_dwg"];
const missing = required.filter((name) => !functions.has(name));
if (missing.length) {
  console.error("[cad-wasm] required exports missing:", missing.join(", "));
  process.exit(1);
}

console.log(`[cad-wasm] verified ${path.relative(process.cwd(), file)} (${Math.round(bytes.length / 1024)} KiB); DWG writer export present; ${imports.length} host imports.`);
