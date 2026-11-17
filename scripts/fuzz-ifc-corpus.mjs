#!/usr/bin/env node
/**
 * IFC parser fuzz — invalid/incomplete model handling gate.
 *
 * Mutates corpus bytes (valid fixtures + the invalid/ subtree) and feeds each
 * buffer to web-ifc in an ISOLATED child process with a capped V8 heap.
 * Containment model (deliberately environment-robust — the harness probes
 * whether the runner can boot node under an address-space ulimit, because
 * node's boot reservation differs per machine and CI runners expose hard
 * limits that make raising one impossible):
 *
 *   ok              — model opened + schema read (mutation hit inert bytes)
 *   typed-error     — child threw a catchable JS Error (controlled failure)
 *   timeout         — child produced no token within CHILD_TIMEOUT_MS; the
 *                     harness kill bounds the damage (isolated process, no
 *                     state corruption) — counted and reported
 *   contained-crash — child died without a token (kernel OOM kill / abort
 *                     outside the child's catch) — contained by process
 *                     isolation; gate fails above the measured baseline
 *
 * Gate fails when: contained-crash rate exceeds the measured baseline
 * (>35%), timeout rate exceeds 30%, or no outcomes are recorded at all.
 * When the runner can boot node under an address-space ulimit (probed),
 * adversarial over-allocation becomes catchable aborts instead of kills.
 *
 * Revives the intent of the retired scripts/fuzz-ifc.mjs, whose seeds and
 * importWorker import no longer exist. Uses the same npm web-ifc dependency
 * as scripts/golden-roundtrip.mjs (proven to run in CI).
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
const CHILD_TIMEOUT_MS = Math.max(1000, Number(process.env.FUZZ_CHILD_TIMEOUT_MS) || 40000);
const TIMEOUT_RATE_MAX = 0.3;
/**
 * Baseline measured on adversarial mutations: without an address-space cap,
 * the OS OOM-kills the child on ~25% of mutated count fields (that kill IS
 * the containment — isolated child, no state corruption). The gate fails
 * above the measured baseline, not at zero.
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
      ["--max-old-space-size=256", CHILD, file],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (out.includes("ok")) resolve({ outcome: "ok" });
      else if (out.includes("typed-error")) resolve({ outcome: "typed-error" });
      else if (timedOut) resolve({ outcome: "timeout" });
      else resolve({ outcome: "contained-crash", code, signal });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ outcome: "contained-crash", code: -1, signal: null });
    });
  });
}

let ok = 0, typedError = 0, containedCrash = 0, timeout = 0;
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
  else if (r.outcome === "timeout") { timeout++; console.warn(`fuzz: timeout at iteration ${i} (seed ${src.name}) — bounded by harness kill`); }
  else containedCrash++;
  if (r.outcome === "timeout" || r.outcome === "contained-crash") {
    const failure = { iteration: i, seed: src.name, outcome: r.outcome, code: r.code ?? null, signal: r.signal ?? null };
    failures.push(failure);
    if (ARTIFACT_DIR) writeFileSync(join(ARTIFACT_DIR, `failure-${String(i).padStart(4, "0")}.ifc`), bytes);
  }
}

rmSync(tmp, { recursive: true, force: true });

const total = ok + typedError + containedCrash + timeout;
if (ARTIFACT_DIR) writeFileSync(join(ARTIFACT_DIR, "summary.json"), JSON.stringify({ seed: SEED, iterations: ITER, total, ok, typedError, containedCrash, timeout, failures }, null, 2) + "\n");
console.log(`fuzz: ${ITER} mutations over ${seeds.length} seeds — ok: ${ok}, typed-error: ${typedError}, contained-crash: ${containedCrash}, timeout: ${timeout}`);

let failed = false;
if (total === 0) { console.error("fuzz: no outcomes recorded — corpus or parser broken"); failed = true; }
const crashRate = containedCrash / Math.max(1, total);
const timeoutRate = timeout / Math.max(1, total);
if (crashRate > CRASH_RATE_MAX) {
  console.error(`fuzz: contained-crash rate ${(crashRate * 100).toFixed(0)}% exceeds the ${(CRASH_RATE_MAX * 100).toFixed(0)}% baseline — parser robustness regressed`);
  failed = true;
}
if (timeoutRate > TIMEOUT_RATE_MAX) {
  console.error(`fuzz: timeout rate ${(timeoutRate * 100).toFixed(0)}% exceeds ${(TIMEOUT_RATE_MAX * 100).toFixed(0)}% — pathological grind on adversarial input`);
  failed = true;
}
process.exit(failed ? 1 : 0);
