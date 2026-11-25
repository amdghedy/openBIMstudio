/* Streaming STEP preflight must give the SAME result as the whole-buffer scanner, and must not drift.
 * Checks: (1) generated file in sync with step-preflight.ts, (2) equivalence on every .ifc fixture,
 * the malformed corpus and deterministic mutants (cut / stray quote / stray ".AB" / stray comment opener)
 * with block sizes that split strings, comments and tokens, (3) no read larger than the block size.
 * Run: node tests/step-preflight-stream.test.mjs */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert";
import { createRequire } from "node:module"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [path.join(root, "scripts/gen-step-preflight-stream.mjs"), "--check"], { stdio: "inherit" });
const out = fs.mkdtempSync(path.join(os.tmpdir(), "spfs-"));
fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction");
execSync(`npx tsc src/modules/ifc-semantics/step-preflight.ts src/modules/ifc-semantics/step-preflight-stream.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { cwd: root, stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name === "node_modules") continue; const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const req = createRequire(import.meta.url);
const { preflightStep } = req(find(out, "step-preflight.js"));
const { preflightStepStreaming } = req(find(out, "step-preflight-stream.js"));
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ifc$/i.test(e.name) && fs.statSync(p).size < 30e6) files.push(p); } })(path.join(root, "tests"));
const inputs = files.map((f) => [path.basename(f), new Uint8Array(fs.readFileSync(f))]);
const small = fs.readFileSync(files.find((f) => /generated-small/.test(f)) || files[0]);
let s = 12345; const rng = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let k = 0; k < 300; k++) {
  const t = Math.floor(rng() * small.length), op = k % 4, ins = [null, "'", ".AB", "/*"][op];
  const b = op === 0 ? small.subarray(0, t) : Buffer.concat([small.subarray(0, t), Buffer.from(ins), small.subarray(t)]);
  inputs.push([`mutant${k}`, new Uint8Array(b)]);
}
let runs = 0, ok = 0, rejected = 0;
for (const [name, u] of inputs) {
  const ref = preflightStep(u); ref.ok ? ok++ : rejected++;
  const sizes = u.length > 5e6 ? [1 << 20, 7 << 20] : [1, 2, 3, 5, 7, 13, 64, 1000, 4096];
  for (const bs of sizes) {
    let maxRead = 0;
    const r = preflightStepStreaming(u.length, (o, l) => { maxRead = Math.max(maxRead, l); return u.subarray(o, o + l); }, bs);
    runs++;
    assert.deepStrictEqual(r, ref, `${name} block=${bs}`);
    assert.ok(maxRead <= bs, `${name} read ${maxRead} > block ${bs}`);
  }
}
assert.ok(ok > 0 && rejected > 0, "need both accepted and rejected inputs");
console.log(`step-preflight-stream: ${inputs.length} inputs, ${runs} runs, ${ok} accepted, ${rejected} rejected, 0 differences`);
