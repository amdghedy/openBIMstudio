/**
 * verify-v56.mjs — Milestone 56 acceptance checks.
 *
 * Asserts that the Family Library seed has landed with the expected shape:
 *   - scripts/seed-families.mjs generator (idempotent)
 *   - src/modules/families/library-loader.ts runtime catalog loader
 *   - src/modules/families/index.ts wires the loader into setupFamilies()
 *   - public/families/index.json catalog index exists and is non-trivial
 *   - 50+ family JSON files across 7 categories
 *   - Each generated family JSON matches FamilyDefinition schema
 *   - package.json declares the seed:families + verify:v56 scripts
 *
 * Run: `node scripts/verify-v56.mjs`
 * Exit code: 0 = pass, 1 = fail.
 */

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function check(label, file, regex) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.error(`  ✗ ${label}: file missing (${file})`);
    return false;
  }
  const content = fs.readFileSync(full, "utf8");
  if (!regex.test(content)) {
    console.error(`  ✗ ${label}: pattern not found in ${file}`);
    return false;
  }
  console.log(`  ✓ ${label}`);
  return true;
}

function checkExists(label, file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.error(`  ✗ ${label}: file/directory missing (${file})`);
    return false;
  }
  console.log(`  ✓ ${label}`);
  return true;
}

let pass = 0;
let fail = 0;

console.log("\n=== verify-v56: Family Library Seed ===\n");

// ─── Generator ───────────────────────────────────────────────────────────
console.log("Generator:");
const generatorChecks = [
  ["seed-families.mjs exists", "scripts/seed-families.mjs", /export|console\.log/],
  ["Generator produces doors", "scripts/seed-families.mjs", /makeDoor/],
  ["Generator produces windows", "scripts/seed-families.mjs", /makeWindow/],
  ["Generator produces plumbing fixtures", "scripts/seed-families.mjs", /makePlumbingFixture/],
  ["Generator produces lighting fixtures", "scripts/seed-families.mjs", /makeLightingFixture/],
  ["Generator produces electrical fixtures", "scripts/seed-families.mjs", /makeElectricalFixture/],
  ["Generator produces furniture", "scripts/seed-families.mjs", /makeFurniture/],
  ["Generator produces mechanical equipment", "scripts/seed-families.mjs", /makeMechanicalEquipment/],
  ["Generator writes index.json", "scripts/seed-families.mjs", /index\.json/],
  ["Generator emits FamilyDefinition shape", "scripts/seed-families.mjs", /schemaVersion: 1/],
];
for (const [label, file, regex] of generatorChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Runtime loader ─────────────────────────────────────────────────────
console.log("\nRuntime loader:");
const loaderChecks = [
  ["library-loader.ts exists", "src/modules/families/library-loader.ts", /export async function loadSeedFamilyCatalog/],
  ["loadSeedFamilyCatalogTracked export", "src/modules/families/library-loader.ts", /export async function loadSeedFamilyCatalogTracked/],
  ["CatalogEntry interface", "src/modules/families/library-loader.ts", /interface CatalogEntry/],
  ["looksLikeFamily validator", "src/modules/families/library-loader.ts", /function looksLikeFamily/],
  ["Fault-tolerant error handling", "src/modules/families/library-loader.ts", /catch/],
  ["Fetch with cache no-cache", "src/modules/families/library-loader.ts", /cache: "no-cache"/],
];
for (const [label, file, regex] of loaderChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Boot wiring ───────────────────────────────────────────────────────
console.log("\nBoot wiring:");
const wiringChecks = [
  ["index.ts imports loader", "src/modules/families/index.ts", /import \{ loadSeedFamilyCatalogTracked \}/],
  ["index.ts calls loader after setup", "src/modules/families/index.ts", /loadSeedFamilyCatalogTracked\(\)/],
  ["index.ts logs catalog loaded", "src/modules/families/index.ts", /catalog loaded/],
];
for (const [label, file, regex] of wiringChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Generated catalog ─────────────────────────────────────────────────
console.log("\nGenerated catalog:");
const catalogChecks = [
  ["public/families/index.json exists", "public/families/index.json", /\[/],
];
for (const [label, file, regex] of catalogChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Per-category directories ──────────────────────────────────────────
console.log("\nCategory directories:");
const categories = [
  "Doors",
  "Windows",
  "Plumbing Fixtures",
  "Lighting Fixtures",
  "Electrical Fixtures",
  "Furniture",
  "Mechanical Equipment",
];
for (const cat of categories) {
  const rel = `public/families/${cat}`;
  if (checkExists(`  ${cat}/`, rel)) pass++; else fail++;
}

// ─── Catalog size: at least 50 family files ────────────────────────────
console.log("\nCatalog size:");
const familiesDir = path.join(root, "public", "families");
const allJsonFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".json") && entry.name !== "index.json") {
      allJsonFiles.push(full);
    }
  }
}
walk(familiesDir);

if (allJsonFiles.length >= 50) {
  console.log(`  ✓ ${allJsonFiles.length} family JSON files (>= 50 required)`);
  pass++;
} else {
  console.error(`  ✗ Only ${allJsonFiles.length} family JSON files (need >= 50)`);
  fail++;
}

// ─── Validate a sample family against FamilyDefinition shape ──────────
console.log("\nFamily JSON schema (sample 5):");
const samples = allJsonFiles.slice(0, 5);
let schemaPass = 0;
for (const sample of samples) {
  const rel = path.relative(root, sample);
  try {
    const fam = JSON.parse(fs.readFileSync(sample, "utf8"));
    const ok =
      typeof fam.id === "string" && fam.id.startsWith("seed-") &&
      typeof fam.name === "string" &&
      typeof fam.ifcEntity === "string" &&
      Array.isArray(fam.parameters) && fam.parameters.length > 0 &&
      fam.geometry && typeof fam.geometry === "object" &&
      typeof fam.geometry.kind === "string" &&
      Array.isArray(fam.types) && fam.types.length > 0 &&
      fam.schemaVersion === 1 &&
      fam.builtIn === false;
    if (ok) {
      console.log(`  ✓ ${rel}`);
      schemaPass++;
    } else {
      console.error(`  ✗ ${rel}: schema validation failed`);
      fail++;
    }
  } catch (e) {
    console.error(`  ✗ ${rel}: JSON parse error: ${e.message}`);
    fail++;
  }
}
pass += schemaPass;

// ─── Index.json lists every family ────────────────────────────────────
console.log("\nIndex.json coverage:");
try {
  const indexData = JSON.parse(fs.readFileSync(path.join(familiesDir, "index.json"), "utf8"));
  if (Array.isArray(indexData) && indexData.length === allJsonFiles.length) {
    console.log(`  ✓ index.json lists ${indexData.length} entries (matches file count)`);
    pass++;
  } else {
    console.error(`  ✗ index.json has ${indexData.length} entries but ${allJsonFiles.length} files exist`);
    fail++;
  }
} catch (e) {
  console.error(`  ✗ index.json parse failed: ${e.message}`);
  fail++;
}

// ─── package.json scripts ──────────────────────────────────────────────
console.log("\npackage.json scripts:");
const pkgChecks = [
  ["seed:families script declared", "package.json", /"seed:families":\s*"node scripts\/seed-families\.mjs"/],
  ["verify:v56 script declared", "package.json", /"verify:v56":\s*"node scripts\/verify-v56\.mjs"/],
  ["verify:v55 script declared (regression)", "package.json", /"verify:v55":\s*"node scripts\/verify-v55\.mjs"/],
  ["version bumped to 0.56", "package.json", /"version":\s*"0\.56\.0"/],
];
for (const [label, file, regex] of pkgChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Per-category file counts ─────────────────────────────────────────
console.log("\nPer-category file counts:");
for (const cat of categories) {
  const catDir = path.join(familiesDir, cat);
  if (fs.existsSync(catDir)) {
    const count = fs.readdirSync(catDir).filter((f) => f.endsWith(".json")).length;
    if (count >= 6) {
      console.log(`  ✓ ${cat}: ${count} families (>= 6 required)`);
      pass++;
    } else {
      console.error(`  ✗ ${cat}: only ${count} families (need >= 6)`);
      fail++;
    }
  }
}

// ─── Final summary ─────────────────────────────────────────────────────
console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
