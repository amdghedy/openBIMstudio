#!/usr/bin/env node
/**
 * Copy the OCR runtime into public/ocr/ so scanned sheets are read on this
 * device with no network call (no CDN: tests/no-cdn-imports.test.cjs).
 *
 * Sources, all installed from npm at exact versions (see package.json):
 *   tesseract.js 7.0.0               Apache-2.0  worker script
 *   tesseract.js-core (its dependency) Apache-2.0  WebAssembly OCR engine (LSTM variants)
 *   @tesseract.js-data/eng 1.0.0     package MIT; model files are tessdata_best_int
 *                                    from tesseract-ocr, Apache-2.0
 * The output folder is generated and git-ignored.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "ocr");
const nm = (...p) => path.join(root, "node_modules", ...p);

const files = [
  [nm("tesseract.js", "dist", "worker.min.js"), "worker.min.js"],
  [nm("tesseract.js-core", "tesseract-core-lstm.wasm.js"), "tesseract-core-lstm.wasm.js"],
  [nm("tesseract.js-core", "tesseract-core-simd-lstm.wasm.js"), "tesseract-core-simd-lstm.wasm.js"],
  [nm("tesseract.js-core", "tesseract-core-relaxedsimd-lstm.wasm.js"), "tesseract-core-relaxedsimd-lstm.wasm.js"],
  [nm("@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz"), "eng.traineddata.gz"],
];

if (!existsSync(nm("tesseract.js"))) {
  console.log("[ocr] tesseract.js is not installed; OCR assets not copied (run npm install)");
  process.exit(0);
}
mkdirSync(out, { recursive: true });
let total = 0;
for (const [src, name] of files) {
  if (!existsSync(src)) { console.error(`[ocr] missing ${src}`); process.exit(1); }
  copyFileSync(src, path.join(out, name));
  total += statSync(src).size;
}
const v = (p) => JSON.parse(readFileSync(nm(p, "package.json"), "utf8")).version;
console.log(`[ocr] copied ${files.length} files (${(total / 1048576).toFixed(1)} MB) tesseract.js ${v("tesseract.js")} core ${v("tesseract.js-core")}`);
