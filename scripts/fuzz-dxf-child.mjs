/**
 * DXF fuzz child: parse one (possibly mutated) DXF buffer in an isolated process.
 *
 * The parent runs this with a capped V8 heap so parser over-allocation kills
 * ONLY this process, not the gate. Emits "ready" after the compiled reader is
 * loaded so the parent can apply a separate, accurate timeout to the untrusted
 * parse. Result tokens: ready, then exactly one of ok | typed-error | bad-output.
 *
 *   ok          — parseDxf returned a document with only finite numbers
 *   typed-error — parseDxf threw a catchable JS Error (controlled failure)
 *   bad-output  — parseDxf returned a document containing a non-finite
 *                 number (the malformed-DXF invariant: geometry must stay
 *                 finite even for hostile input)
 *
 * Usage: node scripts/fuzz-dxf-child.mjs <compiled-dxf-reader.js> <file.dxf>
 * The input file is read as latin1 so byte-level mutations survive the
 * round trip exactly (DXF is ASCII; mutated bytes stay bytes).
 */
import { readFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const compiledReader = process.argv[2];
const file = process.argv[3];
if (!compiledReader || !file) process.exit(2);

const { parseDxf } = require(compiledReader);
console.log("ready");

const text = readFileSync(file, "latin1");

/** Iterative finite check (same invariant as tests/dxf-malformed.test.cjs). */
function firstNonFinite(root) {
  const stack = [[root, "entities"]];
  const seen = new Set();
  while (stack.length) {
    const [v, path] = stack.pop();
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return path;
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push([v[i], `${path}[${i}]`]);
    } else if (v && typeof v === "object") {
      if (seen.has(v)) continue;
      seen.add(v);
      for (const k of Object.keys(v)) stack.push([v[k], `${path}.${k}`]);
    }
  }
  return null;
}

try {
  const doc = parseDxf(text);
  const bad = firstNonFinite(doc?.entities ?? doc);
  if (bad) {
    console.log(`bad-output:${bad}`);
  } else {
    console.log("ok");
  }
} catch {
  console.log("typed-error");
}
process.exit(0);
