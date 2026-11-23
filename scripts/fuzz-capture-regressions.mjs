#!/usr/bin/env node
/**
 * Fuzz regression capture: turn a reproducible fuzz crash into a committed
 * regression fixture.
 *
 * Reads one or more fuzz artifact dirs (each holding summary.json +
 * failure-NNNN.<ext> files, as written by scripts/fuzz-*-corpus.mjs), replays
 * every recorded failure once through the same isolated parser child, and
 * promotes only failures that reproduce into the fixture tree:
 *
 *   tests/fixtures/fuzz-regressions/<format>/<sha256>.<ext>
 *   tests/fixtures/fuzz-regressions/<format>/manifest.json
 *   tests/fixtures/fuzz-regressions/<format>/capture-report.json
 *
 * A manifest entry records the seed, mutation kind, iteration, input hash,
 * observed failure and replayed outcome, so the fixture is traceable to the
 * exact fuzz run that found it. Inputs are named by content hash, so the
 * same crashing input found by two runs (or two campaigns) promotes once
 * and its lastSeen is refreshed instead of duplicating the file.
 *
 * A failure that does NOT reproduce on replay is reported and NOT promoted
 * (it was load/timing noise, not a parser defect). The exit code stays 0:
 * "nothing reproduced" is a normal outcome, not an error.
 *
 * Usage:
 *   node scripts/fuzz-capture-regressions.mjs --format dxf \
 *     --artifact-dir fuzz-artifacts-dxf [--artifact-dir ...] \
 *     [--fixtures-root tests/fixtures/fuzz-regressions]
 *
 * Env (replay budgets, same knobs as the corpus fuzzers):
 *   FUZZ_INIT_TIMEOUT_MS (default 30000), FUZZ_CHILD_TIMEOUT_MS (default 8000).
 *
 * OUT OF SCOPE — auto-creating GitHub issues: this script only stages
 * fixtures + manifest for a human (or a later PR) to commit. The nightly
 * workflow runs with `contents: read` and this session has no write access
 * to the repo's issue tracker, so no issue is filed here. The hook point for
 * that is the `fuzz-regression-fixtures` artifact the workflow uploads
 * (fixtures dir + capture report): a follow-up job with `contents: write`
 * could open an issue — or a PR adding the fixture — from it.
 */
import { spawn, execSync } from "child_process";
import ts from "typescript";
import { createHash } from "crypto";
import {
  readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, mkdirSync,
  symlinkSync, existsSync, copyFileSync,
} from "fs";
import { join, dirname, resolve, basename } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const root = dirname(fileURLToPath(import.meta.url));
const REPO = join(root, "..");
const INIT_TIMEOUT_MS = Math.max(1, Number(process.env.FUZZ_INIT_TIMEOUT_MS) || 30000);
const CHILD_TIMEOUT_MS = Math.max(1, Number(process.env.FUZZ_CHILD_TIMEOUT_MS) || 8000);
const FAILING = new Set(["timeout", "startup-timeout", "contained-crash", "bad-output"]);
const EXT = { ifc: "ifc", dxf: "dxf", bcf: "bcf" };

function usage(msg) {
  console.error(`fuzz-capture: ${msg}\nusage: node scripts/fuzz-capture-regressions.mjs --format <ifc|dxf|bcf> --artifact-dir <dir> [--artifact-dir <dir>...] [--fixtures-root <dir>]`);
  process.exit(2);
}

const args = process.argv.slice(2);
let format = null;
let fixturesRoot = join(REPO, "tests/fixtures/fuzz-regressions");
const artifactDirs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--format") format = args[++i];
  else if (args[i] === "--artifact-dir") artifactDirs.push(resolve(process.cwd(), args[++i]));
  else if (args[i] === "--fixtures-root") fixturesRoot = resolve(process.cwd(), args[++i]);
  else usage(`unknown argument ${args[i]}`);
}
if (!format || !EXT[format]) usage("--format must be ifc, dxf or bcf");
if (!artifactDirs.length) usage("at least one --artifact-dir is required");

/** Spawn one parser child for a single input file; resolve its outcome class. */
function runChildOnce(argv, isReady) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
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
      if (stage === "startup" && isReady(out)) {
        stage = "parse";
        armTimeout(CHILD_TIMEOUT_MS, "parse");
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (out.includes("ok")) resolve({ outcome: "ok" });
      else if (out.includes("preflight-rejected") || out.includes("typed-error")) resolve({ outcome: "typed-error" });
      else if (out.includes("bad-output")) resolve({ outcome: "bad-output", detail: out.match(/bad-output:(\S+)/)?.[1] ?? null });
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

/**
 * Per-format replay setup. Returns { replay(file) } where replay runs the
 * format's isolated parser child on the file and resolves its outcome.
 * The parser is compiled/transpiled once here, not per input.
 */
function makeReplayer(tmp) {
  if (format === "ifc") {
    const preflight = join(tmp, "step-preflight.mjs");
    writeFileSync(preflight, ts.transpileModule(readFileSync(join(REPO, "src/modules/ifc-semantics/step-preflight.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    }).outputText);
    return {
      replay: (file) => runChildOnce(
        ["--max-old-space-size=256", join(root, "fuzz-child.mjs"), file, preflight],
        (out) => out.includes("ready"),
      ),
    };
  }
  if (format === "dxf") {
    symlinkSync(join(REPO, "node_modules"), join(tmp, "node_modules"), "junction");
    execSync(
      `npx tsc src/modules/drawings/dxf-reader.ts --outDir ${tmp} --module commonjs --target es2020 --skipLibCheck`,
      { stdio: "pipe", cwd: REPO },
    );
    const reader = ["modules/drawings/dxf-reader.js", "dxf-reader.js"]
      .map((p) => join(tmp, p)).find((p) => existsSync(p));
    if (!reader) throw new Error("fuzz-capture: compiled dxf-reader.js not found");
    return {
      replay: (file) => runChildOnce(
        ["--max-old-space-size=256", join(root, "fuzz-dxf-child.mjs"), reader, file],
        (out) => out.includes("ready"),
      ),
    };
  }
  // bcf
  symlinkSync(join(REPO, "node_modules"), join(tmp, "node_modules"), "junction");
  execSync(
    `npx tsc src/modules/issues/bcf-markup.ts --outDir ${tmp} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`,
    { stdio: "pipe", cwd: REPO },
  );
  const markup = ["modules/issues/bcf-markup.js", "bcf-markup.js"]
    .map((p) => join(tmp, p)).find((p) => existsSync(p));
  if (!markup) throw new Error("fuzz-capture: compiled bcf-markup.js not found");
  return {
    replay: (file) => runChildOnce(
      ["--max-old-space-size=256", join(root, "fuzz-bcf-child.cjs"), markup, file],
      (out) => out.includes("ready"),
    ),
  };
}

const tmp = mkdtempSync(join(tmpdir(), "obs-fuzz-capture-"));
const replayer = makeReplayer(tmp);
const formatDir = join(fixturesRoot, format);
mkdirSync(formatDir, { recursive: true });

const manifestPath = join(formatDir, "manifest.json");
let manifest = { format, entries: [] };
try {
  const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (existing && Array.isArray(existing.entries)) manifest = existing;
} catch { /* no manifest yet — start empty */ }
const byHash = new Map(manifest.entries.map((e) => [e.sha256, e]));

const report = {
  format,
  capturedAt: new Date().toISOString(),
  artifactDirs: artifactDirs.map((d) => basename(d)),
  examined: 0,
  reproduced: 0,
  promoted: 0,
  skippedNotReproduced: [],
  promotedEntries: [],
};

for (const dir of artifactDirs) {
  const summaryPath = join(dir, "summary.json");
  if (!existsSync(summaryPath)) {
    console.warn(`fuzz-capture: ${dir} has no summary.json — skipping`);
    continue;
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (summary.format && summary.format !== format) {
    console.warn(`fuzz-capture: ${dir} summary is format ${summary.format}, expected ${format} — skipping`);
    continue;
  }
  const failures = Array.isArray(summary.failures) ? summary.failures : [];
  for (const f of failures) {
    const fileName = `failure-${String(f.iteration).padStart(4, "0")}.${EXT[format]}`;
    const file = join(dir, fileName);
    if (!existsSync(file)) {
      console.warn(`fuzz-capture: ${fileName} listed in ${basename(dir)} summary but missing on disk — skipping`);
      continue;
    }
    report.examined++;
    const bytes = readFileSync(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const replayed = await replayer.replay(file);
    if (!FAILING.has(replayed.outcome)) {
      console.log(`fuzz-capture: ${fileName} did NOT reproduce (replay: ${replayed.outcome}, was: ${f.outcome}) — not promoted`);
      report.skippedNotReproduced.push({ file: fileName, was: f.outcome, replayed: replayed.outcome });
      continue;
    }
    report.reproduced++;
    const destName = `${sha256}.${EXT[format]}`;
    const now = new Date().toISOString();
    const existing = byHash.get(sha256);
    if (existing) {
      existing.lastSeen = now;
      existing.replayedOutcome = replayed.outcome;
      console.log(`fuzz-capture: ${fileName} reproduced (${replayed.outcome}) — already captured as ${destName}, lastSeen refreshed`);
    } else {
      copyFileSync(file, join(formatDir, destName));
      const entry = {
        sha256,
        file: destName,
        format,
        seed: summary.seed ?? null,
        kind: f.kind ?? summary.kind ?? null,
        iteration: f.iteration,
        outcome: f.outcome,
        replayedOutcome: replayed.outcome,
        detail: f.detail ?? replayed.detail ?? null,
        op: f.op ?? null,
        code: f.code ?? replayed.code ?? null,
        signal: f.signal ?? replayed.signal ?? null,
        source: { artifactDir: basename(dir), summarySeed: summary.seed ?? null, summaryIterations: summary.iterations ?? null, summaryKind: summary.kind ?? null },
        reproduced: true,
        firstSeen: now,
        lastSeen: now,
      };
      manifest.entries.push(entry);
      byHash.set(sha256, entry);
      report.promotedEntries.push(destName);
      console.log(`fuzz-capture: ${fileName} reproduced (${replayed.outcome}) — promoted to ${format}/${destName}`);
    }
    report.promoted++;
  }
}

rmSync(tmp, { recursive: true, force: true });

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(formatDir, "capture-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`fuzz-capture: ${format}: examined ${report.examined} failure(s), ${report.reproduced} reproduced, ${report.promoted} promoted (new: ${report.promotedEntries.length}), ${report.skippedNotReproduced.length} not reproduced — manifest: ${manifest.entries.length} entr(ies)`);
