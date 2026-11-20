/* FUZZ_KIND selector for the IFC corpus fuzz gate (issue #231).
 * "mixed" is the default nightly campaign; "bitflip" reproduces the exact
 * mutation distribution of the 2026-11-19 run that reported 165/500 parser
 * timeouts, so the pre-flight fix can be retested against the original
 * failing cases; "structural" forces structure-preserving mutations only.
 * Runs the real harness with 2 iterations per kind (fast) and checks the
 * recorded summary; an unknown kind must fail fast with exit code 2. */
const { spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-fuzz-kind-"));

function runHarness(kind) {
  const dir = path.join(tmp, `artifacts-${kind || "invalid"}`);
  const env = { ...process.env, FUZZ_ITER: "2", FUZZ_SEED: "42", FUZZ_ARTIFACT_DIR: dir };
  if (kind) env.FUZZ_KIND = kind;
  const r = spawnSync(process.execPath, ["scripts/fuzz-ifc-corpus.mjs"], {
    cwd: root, env, timeout: 180000, encoding: "utf8",
  });
  return { ...r, dir };
}

for (const kind of ["mixed", "bitflip", "structural"]) {
  t(`FUZZ_KIND=${kind} runs 2 iterations and records kind in summary.json`, () => {
    const r = runHarness(kind);
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}\n${r.stdout}`);
    const summary = JSON.parse(fs.readFileSync(path.join(r.dir, "summary.json"), "utf8"));
    assert.strictEqual(summary.kind, kind);
    assert.strictEqual(summary.seed, 42);
    assert.strictEqual(summary.iterations, 2);
    assert.strictEqual(summary.total, 2);
  });
}

t("FUZZ_KIND=bogus fails fast with exit code 2", () => {
  const r = runHarness("bogus");
  assert.strictEqual(r.status, 2, `exit ${r.status}: ${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /FUZZ_KIND must be mixed, bitflip or structural/);
});

console.log(`fuzz-kind: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
