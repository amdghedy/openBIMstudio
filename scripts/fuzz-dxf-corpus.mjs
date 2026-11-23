#!/usr/bin/env node
/**
 * DXF parser fuzz — invalid/incomplete drawing handling gate.
 *
 * Mirrors scripts/fuzz-ifc-corpus.mjs: mutates corpus bytes (the real DXF
 * fixtures in tests/fixtures/dxf-corpus) and feeds each buffer to parseDxf in
 * an ISOLATED child process with a capped V8 heap. The child reports "ready"
 * after the compiled reader loads; the parser timeout then measures the
 * parse only, not Node startup or the tsc compile.
 *
 * Outcomes:
 *   ok              — parse returned a document with only finite numbers
 *   typed-error     — child threw a catchable JS Error (controlled failure)
 *   bad-output      — parse returned a document containing a non-finite
 *                     number (hard invariant, same as test:dxf-malformed)
 *   timeout         — parser did not finish within CHILD_TIMEOUT_MS
 *   startup-timeout — Node/reader load did not finish within INIT_TIMEOUT_MS
 *   contained-crash — child died without a result token (OOM kill / abort)
 *
 * Gate fails when: contained-crash rate exceeds 35%, parser timeout rate
 * exceeds 30%, startup timeout rate exceeds 1%, any bad-output is recorded,
 * or no outcomes are recorded. Each mutation remains process-isolated.
 *
 * Env: FUZZ_ITER (default 60), FUZZ_SEED (default 42).
 *   FUZZ_KIND (default "mixed"): "mixed" alternates the two families;
 *   "bitflip" forces the raw bit-flip family only; "structural" forces
 *   structure-preserving line mutations only.
 *   FUZZ_ARTIFACT_DIR: failing inputs + summary.json land here.
 *   FUZZ_INIT_TIMEOUT_MS (default 30000), FUZZ_CHILD_TIMEOUT_MS (default 8000).
 */
import { spawn, execSync } from "child_process";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const root = dirname(fileURLToPath(import.meta.url));
const REPO = join(root, "..");
const CORPUS = join(REPO, "tests/fixtures/dxf-corpus");
const CHILD = join(root, "fuzz-dxf-child.mjs");
const ITER = Math.max(1, Number(process.env.FUZZ_ITER) || 60);
const SEED = Number(process.env.FUZZ_SEED) || 42;
const KIND = (process.env.FUZZ_KIND || "mixed").toLowerCase();
if (!["mixed", "bitflip", "structural"].includes(KIND)) {
  console.error(`fuzz-dxf: FUZZ_KIND must be mixed, bitflip or structural (got ${process.env.FUZZ_KIND})`);
  process.exit(2);
}
const ARTIFACT_DIR = process.env.FUZZ_ARTIFACT_DIR ? resolve(process.cwd(), process.env.FUZZ_ARTIFACT_DIR) : null;
const INIT_TIMEOUT_MS = Math.max(1, Number(process.env.FUZZ_INIT_TIMEOUT_MS) || 30000);
const CHILD_TIMEOUT_MS = Math.max(1, Number(process.env.FUZZ_CHILD_TIMEOUT_MS) || 8000);
const TIMEOUT_RATE_MAX = 0.3;
const STARTUP_TIMEOUT_RATE_MAX = 0.01;
const CRASH_RATE_MAX = 0.35;

// Deterministic LCG so CI failures are reproducible (same stream as the IFC fuzzer).
let state = SEED >>> 0;
function rand(n) {
  state = (1103515245 * state + 12345) & 0x7fffffff;
  return state % n;
}

const seeds = readdirSync(CORPUS)
  .filter((f) => f.endsWith(".dxf"))
  .map((f) => ({ name: f, bytes: readFileSync(join(CORPUS, f)) }));
if (!seeds.length) {
  console.error("fuzz-dxf: no corpus files found");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "obs-fuzz-dxf-"));
// Compile the real reader closure once (same invocation as tests/dxf-malformed.test.cjs).
// node_modules is symlinked in so any bare imports in the closure resolve.
symlinkSync(join(REPO, "node_modules"), join(tmp, "node_modules"), "junction");
execSync(
  `npx tsc src/modules/drawings/dxf-reader.ts --outDir ${tmp} --module commonjs --target es2020 --skipLibCheck`,
  { stdio: "pipe", cwd: REPO },
);
const READER = ["modules/drawings/dxf-reader.js", "dxf-reader.js"]
  .map((p) => join(tmp, p))
  .find((p) => existsSync(p));
if (!READER) {
  console.error("fuzz-dxf: expected compiled module (dxf-reader.js) under the tsc outDir");
  process.exit(1);
}
if (ARTIFACT_DIR) mkdirSync(ARTIFACT_DIR, { recursive: true });

function runChild(bytes) {
  return new Promise((resolve) => {
    const file = join(tmp, "buf.dxf");
    writeFileSync(file, bytes);
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=256", CHILD, READER, file],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let stage = "startup";
    let timedOutStage = null;
    let timer;

    const armTimeout = (ms, timeoutStage) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOutStage = timeoutStage;
        child.kill("SIGKILL");
      }, ms);
    };

    armTimeout(INIT_TIMEOUT_MS, "startup");
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (stage === "startup" && out.includes("ready")) {
        stage = "parse";
        armTimeout(CHILD_TIMEOUT_MS, "parse");
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (out.includes("ok")) resolve({ outcome: "ok" });
      else if (out.includes("bad-output")) resolve({ outcome: "bad-output", detail: out.match(/bad-output:(\S+)/)?.[1] ?? null });
      else if (out.includes("typed-error")) resolve({ outcome: "typed-error" });
      else if (timedOutStage === "startup") resolve({ outcome: "startup-timeout" });
      else if (timedOutStage === "parse") resolve({ outcome: "timeout" });
      else resolve({ outcome: "contained-crash", code, signal });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ outcome: "contained-crash", code: -1, signal: null });
    });
  });
}

const POISON_NUMBERS = ["NaN", "Infinity", "-1e999", "1e999", "abc", "", " ", "0x10", "--5", "9".repeat(400), "1e308", "-1e308", "2147483647", "-5"];

/** Line-level mutations on the DXF code/value text (adapted from tests/dxf-malformed.test.cjs). */
function structuralMutate(srcBytes) {
  const lines = srcBytes.toString("latin1").split("\n");
  const op = rand(10);
  if (op === 0) return Buffer.from(lines.slice(0, 1 + rand(lines.length - 1)).join("\n"), "latin1"); // truncate
  if (op === 1) { for (let i = 0; i < 1 + rand(8); i++) lines.splice(rand(lines.length), 1); } // delete lines
  if (op === 2) { for (let i = 0; i < 1 + rand(8); i++) lines[rand(lines.length)] = POISON_NUMBERS[rand(POISON_NUMBERS.length)]; } // poison values
  if (op === 3) { for (let i = 0; i < 1 + rand(6); i++) lines.splice(rand(lines.length), 0, String(rand(1000))); } // desync code/value pairs
  if (op === 4) { // absurd LWPOLYLINE vertex count (group 90)
    const idx = lines.findIndex((l) => l.trim() === "90");
    if (idx > 0) lines[idx + 1] = ["2147483647", "-5", "1000000000", "3.7"][rand(4)];
  }
  if (op === 5) { // poison a radius (group 40)
    const idx = lines.findIndex((l) => l.trim() === "40");
    if (idx > 0) lines[idx + 1] = ["0", "-3", "1e308", "NaN"][rand(4)];
  }
  if (op === 6) { // nested INSERT flood (block expansion path)
    const at = lines.findIndex((l) => l.trim() === "INSERT");
    if (at > 0) {
      const block = ["0", "INSERT", "8", "0", "2", "B1", "41", "1e308", "42", "1e-308", "50", "1e30", "10", "1e300", "20", "1e300"];
      for (let k = 0; k < 1 + rand(4); k++) lines.splice(at, 0, ...block);
    }
  }
  if (op === 7) { // line-ending chaos
    return Buffer.from(lines.join("\n").replace(/\n/g, ["\r\n", "\r", "\n\n"][rand(3)]), "latin1");
  }
  if (op === 8) { // binary garbage spliced in
    const s = lines.join("\n");
    const at = rand(s.length);
    const garbage = Buffer.from(Array.from({ length: 1 + rand(40) }, () => rand(256))).toString("latin1");
    return Buffer.from(s.slice(0, at) + garbage + s.slice(at), "latin1");
  }
  // entity flood: thousands of LINEs appended before EOF
  const flood = [];
  for (let i = 0; i < 1000 + rand(3000); i++) flood.push("0", "LINE", "8", "0", "10", "0", "20", "0", "11", "1", "21", "1");
  const eof = lines.lastIndexOf("EOF");
  if (eof > 0) lines.splice(eof - 1, 0, ...flood);
  else lines.push(...flood);
  return Buffer.from(lines.join("\n"), "latin1");
}

let ok = 0, typedError = 0, badOutput = 0, containedCrash = 0, timeout = 0, startupTimeout = 0;
const byKind = {};
const timeoutsBySeed = {};
const failures = [];

for (let i = 0; i < ITER; i++) {
  const src = seeds[rand(seeds.length)];
  const kind = KIND === "mixed" ? (rand(1000) < 500 ? "bitflip" : "structural") : KIND; // not rand(2): the LCG low bit has a period of 2
  let bytes;
  if (kind === "bitflip") {
    bytes = Buffer.from(src.bytes);
    const nMut = 8 + rand(17);
    for (let k = 0; k < nMut; k++) {
      const pos = rand(bytes.length);
      bytes[pos] ^= 1 << rand(8);
    }
  } else {
    bytes = structuralMutate(src.bytes);
  }
  const r = await runChild(bytes);
  byKind[kind] = byKind[kind] || { n: 0, ok: 0, typed: 0, badOutput: 0, timeout: 0, crash: 0 };
  byKind[kind].n++;
  if (r.outcome === "ok") { ok++; byKind[kind].ok++; }
  else if (r.outcome === "typed-error") { typedError++; byKind[kind].typed++; }
  else if (r.outcome === "bad-output") { badOutput++; byKind[kind].badOutput++; }
  else if (r.outcome === "timeout") { timeout++; byKind[kind].timeout++; timeoutsBySeed[src.name] = (timeoutsBySeed[src.name] || 0) + 1; }
  else if (r.outcome === "startup-timeout") { startupTimeout++; byKind[kind].crash++; }
  else { containedCrash++; byKind[kind].crash++; }

  if (["timeout", "startup-timeout", "contained-crash", "bad-output"].includes(r.outcome)) {
    console.warn(`fuzz-dxf: ${r.outcome} at iteration ${i} (seed ${src.name}, kind ${kind})${r.detail ? ` at ${r.detail}` : ""} — bounded by harness kill`);
    const failure = { iteration: i, seed: src.name, kind, outcome: r.outcome, detail: r.detail ?? null, code: r.code ?? null, signal: r.signal ?? null };
    failures.push(failure);
    if (ARTIFACT_DIR) writeFileSync(join(ARTIFACT_DIR, `failure-${String(i).padStart(4, "0")}.dxf`), bytes);
  }
}

rmSync(tmp, { recursive: true, force: true });

const total = ok + typedError + badOutput + containedCrash + timeout + startupTimeout;
if (ARTIFACT_DIR) {
  writeFileSync(join(ARTIFACT_DIR, "summary.json"), JSON.stringify({
    format: "dxf", seed: SEED, iterations: ITER, kind: KIND, total, ok, typedError, badOutput, preflightRejected: 0, containedCrash, timeout, startupTimeout, timeoutsByOp: {}, timeoutsBySeed, byKind, failures,
  }, null, 2) + "\n");
}
console.log(`fuzz-dxf: outcomes by mutation kind ${JSON.stringify(byKind)}`);
console.log(`fuzz-dxf: timeouts by seed ${JSON.stringify(timeoutsBySeed)}`);
console.log(`fuzz-dxf: ${ITER} mutations over ${seeds.length} seeds — ok: ${ok}, typed-error: ${typedError}, bad-output: ${badOutput}, parser-timeout: ${timeout}, startup-timeout: ${startupTimeout}, contained-crash: ${containedCrash}`);

let failed = false;
if (total === 0) {
  console.error("fuzz-dxf: no outcomes recorded — corpus or parser broken");
  failed = true;
}
const crashRate = containedCrash / Math.max(1, total);
const timeoutRate = timeout / Math.max(1, total);
const startupTimeoutRate = startupTimeout / Math.max(1, total);
if (crashRate > CRASH_RATE_MAX) {
  console.error(`fuzz-dxf: contained-crash rate ${(crashRate * 100).toFixed(0)}% exceeds the ${(CRASH_RATE_MAX * 100).toFixed(0)}% baseline — parser robustness regressed`);
  failed = true;
}
if (timeoutRate > TIMEOUT_RATE_MAX) {
  console.error(`fuzz-dxf: parser timeout rate ${(timeoutRate * 100).toFixed(0)}% exceeds ${(TIMEOUT_RATE_MAX * 100).toFixed(0)}% — pathological grind on adversarial input`);
  failed = true;
}
if (startupTimeoutRate > STARTUP_TIMEOUT_RATE_MAX) {
  console.error(`fuzz-dxf: startup timeout rate ${(startupTimeoutRate * 100).toFixed(0)}% exceeds ${(STARTUP_TIMEOUT_RATE_MAX * 100).toFixed(0)}% — Node/reader initialization is unstable`);
  failed = true;
}
if (badOutput > 0) {
  console.error(`fuzz-dxf: ${badOutput} parse(s) returned non-finite geometry — the finite-output invariant is broken`);
  failed = true;
}
process.exit(failed ? 1 : 0);
