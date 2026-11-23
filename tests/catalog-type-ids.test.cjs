/**
 * tests/catalog-type-ids.test.cjs
 *
 * Drift gate for the seed family catalog: every family type shipped in
 * public/families/ must carry a stable `id`. Types without ids still WORK —
 * the family migrator assigns a deterministic fallback (t_<familyId>-<i>)
 * and warns per type at runtime — but the console noise on every catalog
 * load is exactly what the warning exists to prevent: the data should be
 * fixed at the source instead (concrete-column-rectangular and steel-beam-i
 * shipped 5 id-less types and fired the warnings on every boot).
 *
 * Run: `node tests/catalog-type-ids.test.cjs`
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; } }

const root = path.join(__dirname, "..");
const famDir = path.join(root, "public", "families");

function walk(dir, into) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, into);
    else if (entry.name.endsWith(".json")) into.push(full);
  }
  return into;
}

t("every seed family type has a stable id", () => {
  const files = walk(famDir, []).filter((f) => !f.endsWith("index.json"));
  assert.ok(files.length >= 50, `expected the full catalog under public/families, found ${files.length} files`);
  const idless = [];
  const seen = new Map();
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    if (!d || typeof d !== "object" || !Array.isArray(d.types)) continue;
    const famId = String(d.id ?? path.basename(f, ".json"));
    d.types.forEach((ty, i) => {
      if (!ty || typeof ty !== "object") return;
      if (typeof ty.id !== "string" || !ty.id.trim()) {
        idless.push(`${path.relative(root, f)} type[${i}] "${ty.name ?? "?"}"`);
        return;
      }
      // Type ids must be unique per family (the migrator throws on collisions).
      const key = `${famId}::${ty.id}`;
      if (seen.has(key)) {
        idless.push(`${path.relative(root, f)} duplicate type id "${ty.id}"`);
      }
      seen.set(key, f);
    });
  }
  assert.deepStrictEqual(idless, [], `id-less / duplicate seed type ids: ${idless.join("; ")}`);
});

t("the migrator's deterministic fallback matches the shipped ids scheme", () => {
  const d = JSON.parse(fs.readFileSync(path.join(famDir, "Structural", "concrete-column-rectangular.json"), "utf8"));
  assert.strictEqual(d.id, "seed-struct-col-001");
  assert.strictEqual(d.types[0].id, "t_seed-struct-col-001-0", "keep the t_<familyId>-<i> scheme the migrator would assign");
});

console.log(`=== catalog-type-ids tests complete: ${passed} passed, ${process.exitCode ? 1 : 0} failed ===`);
if (process.exitCode) process.exit(1);
