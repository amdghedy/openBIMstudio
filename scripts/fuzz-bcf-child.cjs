/**
 * BCF fuzz child: parse one (possibly mutated) markup.bcf buffer in an
 * isolated process.
 *
 * The parent runs this with a capped V8 heap so parser over-allocation kills
 * ONLY this process, not the gate. Emits "ready" after the compiled markup
 * module loads so the parent can apply a separate, accurate timeout to the
 * untrusted parse. Result tokens: ready, then exactly one of
 * ok | typed-error | bad-output.
 *
 *   ok          — parseBcfMarkup returned a topic with only finite numbers
 *   typed-error — parseBcfMarkup (or the XML shim) threw a catchable JS
 *                 Error (controlled failure)
 *   bad-output  — parseBcfMarkup returned a topic containing a non-finite
 *                 number (dates are normalized to 0, so this must not happen)
 *
 * Scope note: the XML tokenization here is the minimal shim in
 * ./fuzz-bcf-xml-shim.cjs (same code as tests/bcf21-roundtrip.test.cjs);
 * production uses the browser DOMParser. This child therefore fuzzes the
 * markup *semantic* layer, not the browser tokenizer.
 *
 * Usage: node scripts/fuzz-bcf-child.cjs <compiled-bcf-markup.js> <file.bcf>
 * The input file is read as latin1 so byte-level mutations survive exactly.
 */
const { readFileSync } = require("fs");

const compiledMarkup = process.argv[2];
const file = process.argv[3];
if (!compiledMarkup || !file) process.exit(2);

const { parseBcfMarkup, setBcfDomParserFactory } = require(compiledMarkup);
const { makeBcfDomParserFactory } = require("./fuzz-bcf-xml-shim.cjs");
setBcfDomParserFactory(makeBcfDomParserFactory());
console.log("ready");

const xml = readFileSync(file, "latin1");

function firstNonFinite(root) {
  const stack = [[root, "topic"]];
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
  const topic = parseBcfMarkup(xml);
  const bad = firstNonFinite(topic);
  if (bad) {
    console.log(`bad-output:${bad}`);
  } else {
    console.log("ok");
  }
} catch {
  console.log("typed-error");
}
process.exit(0);
