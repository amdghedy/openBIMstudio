#!/usr/bin/env node
/**
 * IFC parser fuzz — invalid/incomplete model handling gate.
 *
 * Mutates corpus bytes (valid fixtures + the invalid/ subtree) and feeds each
 * buffer to web-ifc in an ISOLATED child process with a capped V8 heap.
 * The child reports "ready" after WASM initialization; the parser timeout then
 * measures OpenModel/GetModelSchema only, not Node startup or WASM boot time.
 *
 * Outcomes:
 *   ok              — model opened + schema read (mutation hit inert bytes)
 *   typed-error     — child threw a catchable JS Error (controlled failure)
 *   timeout         — parser did not finish within CHILD_TIMEOUT_MS
 *   startup-timeout — Node/WASM initialization did not finish within
 *                     INIT_TIMEOUT_MS
 *   contained-crash — child died without a result token (OOM kill / abort)
 *
 * Gate fails when: contained-crash rate exceeds the measured baseline
 * (>35%), parser timeout rate exceeds 30%, startup timeout rate exceeds 1%,
 * or no outcomes are recorded. Each mutation remains process-isolated.
 *
 * Env: FUZZ_ITER (default 60), FUZZ_SEED (default 42).
 */
import { spawn } from "child_process";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const root = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(root, "..", "tests/fixtures/ifc-corpus");
const CHILD = join(root, "fuzz-child.mjs");
const ITER = Math.max(1, Number(process.env.FUZZ_ITER) || 60);
const SEED = Number(process.env.FUZZ_SEED) || 42;
const ARTIFACT_DIR = process.env.FUZZ_ARTIFACT_DIR ? resolve(process.cwd(), process.env.FUZZ_ARTIFACT_DIR) : null;
const INIT_TIMEOUT_MS = Math.max(1000, Number(process.env.FUZZ_INIT_TIMEOUT_MS) || 30000);
const CHILD_TIMEOUT_MS = Math.max(1000, Number(process.env.FUZZ_CHILD_TIMEOUT_MS) || 40000);
const TIMEOUT_RATE_MAX = 0.3;
const STARTUP_TIMEOUT_RATE_MAX = 0.01;
/**
 * Baseline measured on adversarial mutations: without an address-space cap,
 * the OS OOM-kills the child on ~25% of mutated count fields. Isolation
 * contains those failures so they cannot corrupt the parent or later cases.
 */
const CRASH_RATE_MAX = 0.35;

// Deterministic LCG so CI failures are reproducible.
let state = SEED >>> 0;
function rand(n) {
  state = (1103515245 * state + 12345) & 0x7fffffff;
  return state % n;
}

const seeds = readdirSync(CORPUS)
  .filter((f) => f.endsWith(".ifc"))
  .map((f) => ({ name: f, bytes: readFileSync(join(CORPUS, f)) }));

const invalidDir = join(CORPUS, "invalid");
try {
  for (const f of readdirSync(invalidDir).filter((x) => x.endsWith(".ifc"))) {
    seeds.push({ name: `invalid/${f}`, bytes: readFileSync(join(invalidDir, f)) });
  }
} catch { /* no invalid dir */ }

if (!seeds.length) {
  console.error("fuzz: no corpus files found");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "obs-fuzz-"));
if (ARTIFACT_DIR) mkdirSync(ARTIFACT_DIR, { recursive: true });

function runChild(bytes) {
  return new Promise((resolve) => {
    const file = join(tmp, "buf.ifc");
    writeFileSync(file, bytes);
    const child = spawn(
      process.execPath,
      ["--import=tsx", "--max-old-space-size=256", CHILD, file],
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

let ok = 0, typedError = 0, containedCrash = 0, timeout = 0, startupTimeout = 0;
const failures = [];

for (let i = 0; i < ITER; i++) {
  const src = seeds[rand(seeds.length)];
  const bytes = Buffer.from(src.bytes);
  const nMut = 8 + rand(17);
  for (let k = 0; k < nMut; k++) {
    const pos = rand(bytes.length);
    bytes[pos] ^= 1 << rand(8);
  }
  const r = await runChild(bytes);
  if (r.outcome === "ok") ok++;
  else if (r.outcome === "typed-error") typedError++;
  else if (r.outcome === "timeout") {
    timeout++;
    console.warn(`fuzz: parser timeout at iteration ${i} (seed ${src.name}) — bounded by harness kill`);
  } else if (r.outcome === "startup-timeout") {
    startupTimeout++;
    console.warn(`fuzz: startup timeout at iteration ${i} (seed ${src.name}) — WASM initialization exceeded its separate budget`);
  } else containedCrash++;

  if (["timeout", "startup-timeout", "contained-crash"].includes(r.outcome)) {
    const failure = { iteration: i, seed: src.name, outcome: r.outcome, code: r.code ?? null, signal: r.signal ?? null };
    failures.push(failure);
    if (ARTIFACT_DIR) writeFileSync(join(ARTIFACT_DIR, `failure-${String(i).padStart(4, "0")}.ifc`), bytes);
  }
}

rmSync(tmp, { recursive: true, force: true });

const total = ok + typedError + containedCrash + timeout + startupTimeout;
if (ARTIFACT_DIR) {
  writeFileSync(join(ARTIFACT_DIR, "summary.json"), JSON.stringify({
    seed: SEED, iterations: ITER, total, ok, typedError, containedCrash, timeout, startupTimeout, failures,
  }, null, 2) + "\n");
}
console.log(`fuzz: ${ITER} mutations over ${seeds.length} seeds — ok: ${ok}, typed-error: ${typedError}, parser-timeout: ${timeout}, startup-timeout: ${startupTimeout}, contained-crash: ${containedCrash}`);

let failed = false;
if (total === 0) {
  console.error("fuzz: no outcomes recorded — corpus or parser broken");
  failed = true;
}
const crashRate = containedCrash / Math.max(1, total);
const timeoutRate = timeout / Math.max(1, total);
const startupTimeoutRate = startupTimeout / Math.max(1, total);
if (crashRate > CRASH_RATE_MAX) {
  console.error(`fuzz: contained-crash rate ${(crashRate * 100).toFixed(0)}% exceeds the ${(CRASH_RATE_MAX * 100).toFixed(0)}% baseline — parser robustness regressed`);
  failed = true;
}
if (timeoutRate > TIMEOUT_RATE_MAX) {
  console.error(`fuzz: parser timeout rate ${(timeoutRate * 100).toFixed(0)}% exceeds ${(TIMEOUT_RATE_MAX * 100).toFixed(0)}% — pathological grind on adversarial input`);
  failed = true;
}
if (startupTimeoutRate > STARTUP_TIMEOUT_RATE_MAX) {
  console.error(`fuzz: startup timeout rate ${(startupTimeoutRate * 100).toFixed(0)}% exceeds ${(STARTUP_TIMEOUT_RATE_MAX * 100).toFixed(0)}% — Node/WASM initialization is unstable`);
  failed = true;
}
process.exit(failed ? 1 : 0);
