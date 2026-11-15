#!/usr/bin/env node
/**
 * IFC parser fuzz — invalid/incomplete model handling gate.
 *
 * Mutates corpus bytes (valid fixtures + the invalid/ subtree) and feeds each
 * buffer to web-ifc in an ISOLATED child process with a capped heap
 * (--max-old-space-size=512). Parser over-allocation on adversarial bytes
 * kills only the child (contained crash), never the gate or the machine.
 *
 * Outcome taxonomy:
 *   ok              — model opened + schema read (mutation hit inert bytes)
 *   typed-error     — child threw a catchable JS Error (controlled failure)
 *   contained-crash — child OOM-killed / aborted in its own process
 *                     (contained; gate fails only above CRASH_RATE_MAX)
 *   hang            — child produced nothing within CHILD_TIMEOUT → release blocker
 *
 * Revives the intent of the retired scripts/fuzz-ifc.mjs, whose seeds and
 * importWorker import no longer exist. Uses the same npm web-ifc dependency
 * as scripts/golden-roundtrip.mjs (proven to run in CI).
 *
 * Env: FUZZ_ITER (default 60), FUZZ_SEED (default 42).
 */
import { spawn } from "child_process";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const root = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(root, "..", "tests/fixtures/ifc-corpus");
const CHILD = join(root, "fuzz-child.mjs");
const ITER = Math.max(1, Number(process.env.FUZZ_ITER) || 60);
const SEED = Number(process.env.FUZZ_SEED) || 42;
const CHILD_TIMEOUT_MS = 25000; // worst observed controlled abort ≈ 21s (allocation-failure grinding under ulimit)
const CRASH_RATE_MAX = 0.2; // >20% contained crashes = brittle parser gate failure

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

function runChild(bytes, cap) {
  return new Promise((resolve) => {
    const file = join(tmp, "buf.ifc");
    writeFileSync(file, bytes);
    // ulimit -v caps TOTAL address space (including the wasm heap that
    // --max-old-space-size cannot reach), turning adversarial over-allocation
    // into a catchable emscripten abort instead of a kernel OOM kill. The cap
    // is selected by a boot PROBE (see below) because node's own startup
    // reservation differs per machine/runner — a too-small cap kills the
    // child before it prints any outcome token (seen on CI with 2 GB).
    const cmd = cap
      ? `ulimit -v ${cap}; exec "$0" --max-old-space-size=256 "$1" "$2"`
      : `exec "$0" --max-old-space-size=256 "$1" "$2"`;
    const child = spawn(
      "bash",
      ["-c", cmd, process.execPath, CHILD, file],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ outcome: "hang" });
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (out.includes("ok")) resolve({ outcome: "ok" });
      else if (out.includes("typed-error")) resolve({ outcome: "typed-error" });
      else if (signal === "SIGKILL") resolve({ outcome: "hang" }); // killed by our timer
      else resolve({ outcome: "contained-crash", code, signal });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ outcome: "contained-crash", code: -1, signal: null });
    });
  });
}

/**
 * Pick the smallest address-space cap the runner can actually boot node
 * under: probe an UNMUTATED corpus file (which must parse ok) with candidate
 * caps; fall back to no ulimit when none boots. Deterministic per runner.
 */
async function pickCap() {
  const probeBytes = seeds[0].bytes;
  for (const cap of [2097152, 4194304, 8388608, null]) {
    const r = await runChild(probeBytes, cap);
    if (r.outcome === "ok") {
      console.log(`fuzz: child cap probe — using ${cap ? `${(cap / 1024 / 1024).toFixed(0)} GB ulimit` : "no ulimit"}`);
      return cap;
    }
    console.log(`fuzz: child cap probe — ${(cap ? `${(cap / 1024 / 1024).toFixed(0)} GB` : "no ulimit")} not bootable (${r.outcome})`);
  }
  return null;
}

let ok = 0, typedError = 0, containedCrash = 0, hang = 0;

const CAP = await pickCap();

for (let i = 0; i < ITER; i++) {
  const src = seeds[rand(seeds.length)];
  const bytes = Buffer.from(src.bytes);
  const nMut = 8 + rand(17);
  for (let k = 0; k < nMut; k++) {
    const pos = rand(bytes.length);
    bytes[pos] ^= 1 << rand(8);
  }
  const r = await runChild(bytes, CAP);
  if (r.outcome === "ok") ok++;
  else if (r.outcome === "typed-error") typedError++;
  else if (r.outcome === "hang") { hang++; console.error(`fuzz: HANG at iteration ${i} (seed ${src.name}) — release blocker`); break; }
  else containedCrash++;
}

rmSync(tmp, { recursive: true, force: true });

console.log(`fuzz: ${ITER} mutations over ${seeds.length} seeds — ok: ${ok}, typed-error: ${typedError}, contained-crash: ${containedCrash}, hang: ${hang}`);

let failed = false;
if (hang > 0) failed = true;
if (ok + typedError + containedCrash === 0) { console.error("fuzz: no outcomes recorded — corpus or parser broken"); failed = true; }
const crashRate = containedCrash / Math.max(1, ok + typedError + containedCrash);
if (crashRate > CRASH_RATE_MAX) {
  console.error(`fuzz: contained-crash rate ${(crashRate * 100).toFixed(0)}% exceeds ${(CRASH_RATE_MAX * 100).toFixed(0)}% — parser too brittle`);
  failed = true;
}
process.exit(failed ? 1 : 0);
