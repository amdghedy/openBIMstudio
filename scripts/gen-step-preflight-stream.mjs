#!/usr/bin/env node
/* Generates src/modules/ifc-semantics/step-preflight-stream.ts from step-preflight.ts.
 * `node scripts/gen-step-preflight-stream.mjs`          rewrite the generated file
 * `node scripts/gen-step-preflight-stream.mjs --check`  exit 1 if it drifted from the scanner */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcP = path.join(root, "src/modules/ifc-semantics/step-preflight.ts");
const outP = path.join(root, "src/modules/ifc-semantics/step-preflight-stream.ts");
const src = fs.readFileSync(srcP, "utf8");
const a = src.indexOf("export function preflightStep(");
const b = src.indexOf("/* \u2500\u2500 STEP header fields");
if (a < 0 || b < 0) { console.error("scanner markers not found"); process.exit(2); }
let body = src.slice(a, b).replace(/bytes\[([^\[\]]+)\]/g, "g($1)");
const HEAD = "export function preflightStep(bytes: Uint8Array): StepPreflightResult {\n  const n = bytes.length;";
if (!body.includes(HEAD)) { console.error("scanner head changed"); process.exit(2); }
body = body.replace(HEAD, `export function preflightStepStreaming(
  size: number,
  read: (offset: number, length: number) => Uint8Array,
  blockSize: number = 32 * 1024 * 1024,
): StepPreflightResult {
  const n = size;
  // Two-block cache: memory stays <= 2 * blockSize regardless of file size.
  // Random access outside the cached blocks (e.g. a lookbehind across a block
  // edge) re-reads the block, so results are identical to the whole-buffer scan.
  let c0 = -1, c1 = -1;
  let b0: Uint8Array = new Uint8Array(0), b1: Uint8Array = new Uint8Array(0);
  const g = (p: number): number => {
    if (p < 0 || p >= n) return undefined as unknown as number;
    const blk = Math.floor(p / blockSize);
    if (blk === c0) return b0[p - blk * blockSize];
    if (blk === c1) return b1[p - blk * blockSize];
    const off = blk * blockSize;
    const data = read(off, Math.min(blockSize, n - off));
    c1 = c0; b1 = b0; c0 = blk; b0 = data;
    return data[p - off];
  };
  const startsWithAt = (_b: unknown, i: number, s: string): boolean => {
    if (i + s.length > n) return false;
    for (let k = 0; k < s.length; k++) if (g(i + k) !== s.charCodeAt(k)) return false;
    return true;
  };`).replaceAll("startsWithAt(bytes,", "startsWithAt(null,");
let cs = src.indexOf("const MAX_DEPTH"); if (cs < 0) cs = src.indexOf("const MAX_DIGIT_RUN");
let consts = src.slice(cs, a).replace(/function startsWithAt\([\s\S]*?\n}\n/, "");
const out = `/**
 * Streaming / windowed twin of preflightStep (step-preflight.ts). GENERATED from
 * that scanner by replacing whole-buffer indexing with a two-block cached reader,
 * so the logic and results are identical while peak memory is <= 2 blocks.
 * tests/step-preflight-stream.test.mjs checks equivalence on every malformed
 * fixture and with block sizes that cut strings, comments and tokens.
 */
import type { StepPreflightResult } from "./step-preflight";

` + consts + body;
if (process.argv.includes("--check")) {
  const cur = fs.existsSync(outP) ? fs.readFileSync(outP, "utf8") : "";
  if (cur !== out) { console.error("step-preflight-stream.ts drifted from step-preflight.ts: run node scripts/gen-step-preflight-stream.mjs"); process.exit(1); }
  console.log("step-preflight-stream.ts is in sync"); process.exit(0);
}
fs.writeFileSync(outP, out);
console.log("wrote", path.relative(root, outP));
