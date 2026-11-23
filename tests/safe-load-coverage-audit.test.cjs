/* Regression suite for scripts/check-safe-load-coverage.mjs (issue #90).
 *
 * The audit used to miss `.then()`-chain parses: the `.markups.json` loader
 * in src/features/cad-viewer.ts called JSON.parse inside `f.text().then(...)`
 * with no size limit, schema or depth guard, and neither the direct-call nor
 * the assigned-value check ever saw it. These tests prove the scanner flags
 * the old pattern (verbatim from main @ d19735f) and passes on the fixed one,
 * plus the neighbouring shapes the audit must and must not flag.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
let pass = 0;
function t(name, fn) { fn(); pass++; console.log("  PASS " + name); }

// Verbatim pre-fix loader from src/features/cad-viewer.ts @ d19735f:13212-13224.
const OLD_MARKUPS_LOADER = `
        void f.text().then((txt) => {
          try {
            const data = JSON.parse(txt) as { markups?: Markup[] };
            if (Array.isArray(data.markups)) {
              markups = data.markups;
              draw();
              logCmd("Loaded " + markups.length + " markup(s) from " + f.name);
            }
          } catch (e) {
            logCmd("Failed to load markups: " + (e as Error).message);
          }
        });
`;

(async () => {
  const audit = await import(pathToFileURL(path.join(root, "scripts/check-safe-load-coverage.mjs")).href);
  assert.strictEqual(typeof audit.scanSource, "function", "audit must export scanSource for testing");

  t("audit flags the old .markups.json .then()-chain parse", () => {
    const failures = audit.scanSource(OLD_MARKUPS_LOADER, "src/features/cad-viewer.ts");
    assert.strictEqual(failures.length, 1, "expected exactly one failure, got: " + failures.join("; "));
    assert.match(failures[0], /\.then\(\)/);
    assert.match(failures[0], /txt/);
    assert.match(failures[0], /without safeLoad/);
  });
  t("audit passes on the fixed markups loader (real file, not a copy)", () => {
    const viewer = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
    assert.deepStrictEqual(audit.scanSource(viewer, "src/features/cad-viewer.ts"), []);
  });
  t("audit flags JSON.parse passed bare as the .then() callback", () => {
    const failures = audit.scanSource("void f.text().then(JSON.parse);", "x.ts");
    assert.strictEqual(failures.length, 1);
    assert.match(failures[0], /\.then\(JSON\.parse\)/);
  });
  t("audit flags single-expression, async and function-form .then() parses", () => {
    for (const src of [
      "void f.text().then((txt) => JSON.parse(txt));",
      "void f.text().then(async (txt) => { const d = JSON.parse(txt); });",
      "void f.text().then(function (txt) { JSON.parse(txt); });",
      "void file.text().then(txt => { return JSON.parse(txt); });",
    ]) {
      const failures = audit.scanSource(src, "x.ts");
      assert.strictEqual(failures.length, 1, src + " -> " + failures.join("; "));
      assert.match(failures[0], /\.then\(\)/);
    }
  });
  t("audit still flags direct and assigned File.text() parses (shapes 1–2)", () => {
    assert.strictEqual(audit.scanSource("const d = JSON.parse(await file.text());", "x.ts").length, 1);
    assert.strictEqual(audit.scanSource("const txt = await f.text();\nconst d = JSON.parse(txt);", "x.ts").length, 1);
  });
  t("audit passes when safeLoad guards the value before the parse", () => {
    assert.deepStrictEqual(audit.scanSource(
      "const txt = await f.text();\nconst loaded = safeLoad(f.name, txt, S);\nconst d = JSON.parse(txt);", "x.ts"), []);
    assert.deepStrictEqual(audit.scanSource(
      "void f.text().then((txt) => { const loaded = safeLoad(f.name, txt, S); const d = JSON.parse(txt); });", "x.ts"), []);
  });
  t("audit passes on in-memory clones and local-preference parses", () => {
    assert.deepStrictEqual(audit.scanSource("const copy = JSON.parse(JSON.stringify(x));", "x.ts"), []);
    assert.deepStrictEqual(audit.scanSource("const p = JSON.parse(localStorage.getItem('k') || '{}');", "x.ts"), []);
  });
  t("audit script exits 0 on the current tree (all 17 required boundaries wired)", () => {
    const run = spawnSync(process.execPath, [path.join(root, "scripts/check-safe-load-coverage.mjs")], { encoding: "utf8" });
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /17 required boundaries/);
    assert.match(run.stdout, /cad-viewer\.ts: validated boundary wired/);
    // PE-20: the new DXF / IFC / BCF / formula boundaries are enforced too.
    assert.match(run.stdout, /dxf-reader\.ts: validated boundary wired/);
    assert.match(run.stdout, /step-preflight\.ts: validated boundary wired/);
    assert.match(run.stdout, /bcf\.ts: validated boundary wired/);
    assert.match(run.stdout, /formula-engine\.ts: validated boundary wired/);
    assert.match(run.stdout, /schema ProjectElementSchema defined/);
  });

  console.log(`=== Result: ${pass} passed, 0 failed ===`);
})().catch((e) => { console.error(e); process.exit(1); });
