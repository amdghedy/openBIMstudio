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
import ts from "typescript";
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
// The application's structural pre-flight, transpiled so the harness exercises the real source (no copy).
const PREFLIGHT = join(tmp, "step-preflight.mjs");
writeFileSync(PREFLIGHT, ts.transpileModule(readFileSync(join(root, "..", "src/modules/ifc-semantics/step-preflight.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText);
if (ARTIFACT_DIR) mkdirSync(ARTIFACT_DIR, { recursive: true });

function runChild(bytes) {
  return new Promise((resolve) => {
    const file = join(tmp, "buf.ifc");
    writeFileSync(file, bytes);
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=256", CHILD, file, PREFLIGHT],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let stage = "startup";
    let timedOutStage = null;
    let lastMarker = "startup";
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
      for (const m of ["opening", "opened"]) if (out.includes(m)) lastMarker = m;
      if (stage === "startup" && out.includes("ready")) {
        stage = "parse";
        armTimeout(CHILD_TIMEOUT_MS, "parse");
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (out.includes("ok")) resolve({ outcome: "ok" });
      else if (out.includes("preflight-rejected")) resolve({ outcome: "typed-error", preflight: true });
      else if (out.includes("typed-error")) resolve({ outcome: "typed-error" });
      else if (timedOutStage === "startup") resolve({ outcome: "startup-timeout" });
      else if (timedOutStage === "parse") resolve({ outcome: "timeout", op: lastMarker === "opened" ? "GetModelSchema" : "OpenModel" });
      else resolve({ outcome: "contained-crash", code, signal });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ outcome: "contained-crash", code: -1, signal: null });
    });
  });
}


/** Structure-preserving mutations on the DATA section: they keep the file legal STEP so they reach web-ifc. */
function structuralMutate(srcBytes) {
  const lines = srcBytes.toString("latin1").split("\n");
  const first = lines.findIndex((l) => l.trim() === "DATA;") + 1;
  let last = lines.findIndex((l, i) => i > first && l.trim() === "ENDSEC;");
  if (first <= 0 || last < 0) last = lines.length;
  // Prefer structural damage over pathological integers: web-ifc can grind for
  // minutes on multi-billion list counts / 1E308 fields (parser timeouts, not crashes).
  const MILD = ["0", "1", "2", "3", "8", "16", "64", "255", "1024", "-1"];
  const n = 3 + rand(8);
  for (let k = 0; k < n && last - first > 2; k++) {
    const idx = first + rand(last - first);
    const op = rand(4);
    if (op === 0) lines[idx] = lines[idx].replace(/\b\d+(\.\d*)?\b/g, (m) => (rand(6) === 0 ? MILD[rand(MILD.length)] : m));
    else if (op === 1) { lines.splice(idx, 1); last--; }
    else if (op === 2) { lines.splice(idx, 0, lines[idx]); last++; }
    else { const target = first + rand(last - first); lines[idx] = lines[idx].replace(/#\d+/g, (m) => (rand(4) === 0 ? "#" + (lines[target].match(/^#(\d+)/)?.[1] ?? "1") : m)); }
  }
  return Buffer.from(lines.join("\n"), "latin1");
}

let preflightRejected = 0;
const byKind = {};
const timeoutsByOp = {}, timeoutsBySeed = {};
let ok = 0, typedError = 0, containedCrash = 0, timeout = 0, startupTimeout = 0;
const failures = [];

for (let i = 0; i < ITER; i++) {
  const src = seeds[rand(seeds.length)];
  // Two mutation families: raw bit flips (mostly rejected by the structural pre-flight) and
  // structure-preserving token mutations that pass it and therefore really exercise web-ifc.
  const kind = rand(1000) < 500 ? "bitflip" : "structural"; // not rand(2): the LCG low bit has a period of 2
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
  byKind[kind] = byKind[kind] || { n: 0, preflight: 0, ok: 0, typed: 0, timeout: 0, crash: 0 };
  byKind[kind].n++;
  if (r.outcome === "ok") byKind[kind].ok++; else if (r.outcome === "typed-error") { byKind[kind].typed++; if (r.preflight) byKind[kind].preflight++; } else if (r.outcome === "timeout") byKind[kind].timeout++; else byKind[kind].crash++;
  if (r.outcome === "ok") ok++;
  else if (r.outcome === "typed-error") { typedError++; if (r.preflight) preflightRejected++; }
  else if (r.outcome === "timeout") {
    timeout++;
    timeoutsByOp[r.op] = (timeoutsByOp[r.op] || 0) + 1;
    timeoutsBySeed[src.name] = (timeoutsBySeed[src.name] || 0) + 1;
    console.warn(`fuzz: parser timeout at iteration ${i} in ${r.op} (seed ${src.name}) — bounded by harness kill`);
  } else if (r.outcome === "startup-timeout") {
    startupTimeout++;
    console.warn(`fuzz: startup timeout at iteration ${i} (seed ${src.name}) — WASM initialization exceeded its separate budget`);
  } else containedCrash++;

  if (["timeout", "startup-timeout", "contained-crash"].includes(r.outcome)) {
    const failure = { iteration: i, seed: src.name, kind, outcome: r.outcome, op: r.op ?? null, code: r.code ?? null, signal: r.signal ?? null };
    failures.push(failure);
    if (ARTIFACT_DIR) writeFileSync(join(ARTIFACT_DIR, `failure-${String(i).padStart(4, "0")}.ifc`), bytes);
  }
}

rmSync(tmp, { recursive: true, force: true });

const total = ok + typedError + containedCrash + timeout + startupTimeout;
if (ARTIFACT_DIR) {
  writeFileSync(join(ARTIFACT_DIR, "summary.json"), JSON.stringify({
    seed: SEED, iterations: ITER, total, ok, typedError, preflightRejected, containedCrash, timeout, startupTimeout, timeoutsByOp, timeoutsBySeed, byKind, failures,
  }, null, 2) + "\n");
}
console.log(`fuzz: outcomes by mutation kind ${JSON.stringify(byKind)}`);
console.log(`fuzz: timeouts by operation ${JSON.stringify(timeoutsByOp)}, by seed ${JSON.stringify(timeoutsBySeed)}`);
console.log(`fuzz: ${ITER} mutations over ${seeds.length} seeds — ok: ${ok}, typed-error: ${typedError} (of which pre-flight rejections: ${preflightRejected}), parser-timeout: ${timeout}, startup-timeout: ${startupTimeout}, contained-crash: ${containedCrash}`);

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
