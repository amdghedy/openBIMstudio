/* Fuzz regression capture: reproducible failures become committed fixtures.
 *
 * This test exercises scripts/fuzz-capture-regressions.mjs end to end with
 * REAL parser behavior, not stubs:
 *   1. A genuine timeout probe — a 200k-entity DXF flood that really does
 *      take ~700 ms to parse, replayed under a 100 ms budget, so the child
 *      is killed by the harness timeout. The probe input is synthetic and
 *      its summary says so (kind "synthetic-timeout-probe"); it exercises
 *      the capture path, it is not a claim of a parser defect.
 *   2. A non-reproducing failure — a benign seed file recorded as a
 *      "timeout" in the summary. Replay says ok, so it must NOT be promoted.
 *   3. A no-failures artifact dir — nothing is promoted, exit stays 0.
 *   4. A second capture of the same artifact dir — the fixture is not
 *      duplicated, only lastSeen is refreshed.
 *
 * All fixtures land in a temp fixtures root, never in the real tree.
 * Run: `node tests/fuzz-capture.test.cjs`
 */
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const CAPTURE = path.join(ROOT, "scripts", "fuzz-capture-regressions.mjs");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "obs-fuzz-capture-test-"));
const artifactDir = path.join(work, "artifacts");
const fixturesRoot = path.join(work, "fixtures");
fs.mkdirSync(artifactDir, { recursive: true });

// 200k LINE entities: ~6 MB, parses in ~700 ms on this VM — a genuine
// timeout under the 100 ms replay budget below.
let flood = "0\nSECTION\n2\nENTITIES\n";
for (let i = 0; i < 200000; i++) flood += "0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n1\n";
flood += "0\nENDSEC\n0\nEOF\n";
fs.writeFileSync(path.join(artifactDir, "failure-0000.dxf"), flood);
const benign = fs.readFileSync(path.join(ROOT, "tests/fixtures/dxf-corpus/entities_rich.dxf"));
fs.writeFileSync(path.join(artifactDir, "failure-0001.dxf"), benign);
fs.writeFileSync(path.join(artifactDir, "summary.json"), JSON.stringify({
  format: "dxf", seed: null, iterations: 2, kind: "synthetic-timeout-probe", total: 2,
  ok: 0, typedError: 0, badOutput: 0, containedCrash: 0, timeout: 2, startupTimeout: 0,
  timeoutsByOp: {}, timeoutsBySeed: {}, byKind: {},
  failures: [
    { iteration: 0, seed: "synthetic-timeout-probe", kind: "synthetic-timeout-probe", outcome: "timeout", detail: null, code: null, signal: "SIGKILL" },
    { iteration: 1, seed: "entities_rich.dxf", kind: "synthetic-timeout-probe", outcome: "timeout", detail: null, code: null, signal: "SIGKILL" },
  ],
}, null, 2) + "\n");

const env = { ...process.env, FUZZ_INIT_TIMEOUT_MS: "30000", FUZZ_CHILD_TIMEOUT_MS: "100" };
const runCapture = () => execFileSync(process.execPath, [CAPTURE, "--format", "dxf", "--artifact-dir", artifactDir, "--fixtures-root", fixturesRoot], { cwd: ROOT, env, stdio: "pipe", encoding: "utf8" });

let out = runCapture();
console.log(out);
const manifestPath = path.join(fixturesRoot, "dxf", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.strictEqual(manifest.format, "dxf");
assert.strictEqual(manifest.entries.length, 1, "only the reproducing timeout is promoted");
const entry = manifest.entries[0];
assert.strictEqual(entry.reproduced, true);
assert.strictEqual(entry.outcome, "timeout");
assert.strictEqual(entry.replayedOutcome, "timeout");
assert.strictEqual(entry.kind, "synthetic-timeout-probe");
const floodHash = crypto.createHash("sha256").update(flood).digest("hex");
assert.strictEqual(entry.sha256, floodHash);
assert.strictEqual(entry.file, `${floodHash}.dxf`);
assert.ok(fs.existsSync(path.join(fixturesRoot, "dxf", `${floodHash}.dxf`)), "fixture file lands");
assert.strictEqual(fs.readFileSync(path.join(fixturesRoot, "dxf", `${floodHash}.dxf`), "utf8"), flood);
const benignHash = crypto.createHash("sha256").update(benign).digest("hex");
assert.ok(!fs.existsSync(path.join(fixturesRoot, "dxf", `${benignHash}.dxf`)), "non-reproducing failure is NOT promoted");
const report = JSON.parse(fs.readFileSync(path.join(fixturesRoot, "dxf", "capture-report.json"), "utf8"));
assert.strictEqual(report.examined, 2);
assert.strictEqual(report.reproduced, 1);
assert.strictEqual(report.promoted, 1);
assert.strictEqual(report.skippedNotReproduced.length, 1);
assert.strictEqual(report.skippedNotReproduced[0].replayed, "ok");

// Second capture: no duplicate, lastSeen refreshed.
const firstSeen = entry.firstSeen;
out = runCapture();
const manifest2 = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.strictEqual(manifest2.entries.length, 1, "second capture does not duplicate");
assert.strictEqual(manifest2.entries[0].sha256, floodHash);
assert.ok(manifest2.entries[0].lastSeen >= firstSeen, "lastSeen refreshed");

// No-failures artifact dir: nothing promoted, exit 0.
const emptyDir = path.join(work, "empty-artifacts");
fs.mkdirSync(emptyDir, { recursive: true });
fs.writeFileSync(path.join(emptyDir, "summary.json"), JSON.stringify({
  format: "dxf", seed: 42, iterations: 10, kind: "mixed", total: 10,
  ok: 10, typedError: 0, badOutput: 0, containedCrash: 0, timeout: 0, startupTimeout: 0,
  timeoutsByOp: {}, timeoutsBySeed: {}, byKind: {}, failures: [],
}, null, 2) + "\n");
const emptyOut = execFileSync(process.execPath, [CAPTURE, "--format", "dxf", "--artifact-dir", emptyDir, "--fixtures-root", fixturesRoot], { cwd: ROOT, env, stdio: "pipe", encoding: "utf8" });
assert.match(emptyOut, /examined 0 failure/);
assert.strictEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")).entries.length, 1);

fs.rmSync(work, { recursive: true, force: true });
console.log("=== fuzz capture: reproducing timeout promoted, non-reproducing failure skipped, re-capture deduped, empty run clean ===");
