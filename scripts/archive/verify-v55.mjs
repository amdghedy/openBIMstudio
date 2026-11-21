/**
 * verify-v55.mjs — Milestone 55 acceptance checks.
 *
 * Asserts that the Plugin SDK v1.0 has landed with the expected shape:
 *   - Typed manifest + factory contracts in src/plugins/types.ts
 *   - Host-side API bridge in src/plugins/api.ts
 *   - Manifest-based loader in src/plugins/loader.ts
 *   - Boot wiring in src/plugins/boot.ts
 *   - setupPluginSystem() called from main.ts as a boot step
 *   - 6 plugins shipped under public/plugins/<id>/ with plugin.json + index.js
 *   - Plugin SDK documentation in docs/PLUGIN_SDK.md
 *
 * Run: `node scripts/verify-v55.mjs`
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

const checks = [
  // Source: typed contracts
  ["Plugin manifest type", "src/plugins/types.ts", /interface PluginManifest/],
  ["Plugin instance type", "src/plugins/types.ts", /interface PluginInstance/],
  ["Plugin SDK interface", "src/plugins/types.ts", /interface PluginSDK/],
  ["Plugin factory type", "src/plugins/types.ts", /type PluginFactory/],
  ["Capability union", "src/plugins/types.ts", /type PluginCapability/],
  ["Manifest validator", "src/plugins/types.ts", /export function validateManifest/],
  ["Semver helpers", "src/plugins/types.ts", /export function parseSemver/],
  ["__obsRegisterPlugin global", "src/plugins/types.ts", /__obsRegisterPlugin\??: PluginRegisterFn/],

  // Source: host bridge
  ["SDK version constant", "src/plugins/api.ts", /export const SDK_VERSION/],
  ["buildPluginSDK factory", "src/plugins/api.ts", /export function buildPluginSDK/],
  ["buildPluginAPI factory", "src/plugins/api.ts", /export function buildPluginAPI/],
  ["Capability require_ gate", "src/plugins/api.ts", /function require_/],

  // Source: loader
  ["loadPlugins export", "src/plugins/loader.ts", /export async function loadPlugins/],
  ["unloadAllPlugins export", "src/plugins/loader.ts", /export async function unloadAllPlugins/],
  ["Manifest fetch + validate", "src/plugins/loader.ts", /fetchManifest/],
  ["Capability grant function", "src/plugins/loader.ts", /function grantCapabilities/],
  ["Registration bridge installer", "src/plugins/loader.ts", /installRegistrationBridge/],
  ["Fallback plugin allowlist", "src/plugins/loader.ts", /FALLBACK_PLUGIN_IDS/],

  // Source: boot
  ["setupPluginSystem export", "src/plugins/boot.ts", /export async function setupPluginSystem/],
  ["reloadPlugins export", "src/plugins/boot.ts", /export async function reloadPlugins/],
  ["beforeunload teardown", "src/plugins/boot.ts", /beforeunload/],

  // Boot wiring in main.ts
  ["main.ts imports plugin boot", "src/main.ts", /import \{ setupPluginSystem \} from "\.\/plugins\/boot"/],
  ["main.ts calls setupPluginSystem", "src/main.ts", /setupPluginSystem\(\)/],
  ["main.ts plugins step", "src/main.ts", /await step\("plugins"/],

  // Plugin manifests
  ["ifc-validator manifest", "public/plugins/ifc-validator/plugin.json", /"id":\s*"ifc-validator"/],
  ["csv-takeoff manifest", "public/plugins/csv-takeoff/plugin.json", /"id":\s*"csv-takeoff"/],
  ["family-from-csv manifest", "public/plugins/family-from-csv/plugin.json", /"id":\s*"family-from-csv"/],
  ["clash-rule-pack manifest", "public/plugins/clash-rule-pack/plugin.json", /"id":\s*"clash-rule-pack"/],
  ["element-counter manifest", "public/plugins/element-counter/plugin.json", /"id":\s*"element-counter"/],
  ["hello manifest", "public/plugins/hello/plugin.json", /"id":\s*"hello"/],

  // Plugin scripts
  ["ifc-validator index.js", "public/plugins/ifc-validator/index.js", /__obsRegisterPlugin/],
  ["csv-takeoff index.js", "public/plugins/csv-takeoff/index.js", /__obsRegisterPlugin/],
  ["family-from-csv index.js", "public/plugins/family-from-csv/index.js", /__obsRegisterPlugin/],
  ["clash-rule-pack index.js", "public/plugins/clash-rule-pack/index.js", /__obsRegisterPlugin/],
  ["element-counter index.js", "public/plugins/element-counter/index.js", /__obsRegisterPlugin/],
  ["hello index.js", "public/plugins/hello/index.js", /__obsRegisterPlugin/],

  // Plugin index
  ["plugins index.json", "public/plugins/index.json", /ifc-validator/],

  // Documentation
  ["Plugin SDK docs", "docs/PLUGIN_SDK.md", /openBIMstudio Plugin SDK/],
  ["Plugin SDK quick start", "docs/PLUGIN_SDK.md", /Quick Start/],
  ["Plugin SDK capabilities table", "docs/PLUGIN_SDK.md", /Capabilities/],
  ["Plugin SDK lifecycle diagram", "docs/PLUGIN_SDK.md", /Plugin Lifecycle/],
];

const existenceChecks = [
  ["types.ts exists", "src/plugins/types.ts"],
  ["api.ts exists", "src/plugins/api.ts"],
  ["loader.ts exists", "src/plugins/loader.ts"],
  ["boot.ts exists", "src/plugins/boot.ts"],
  ["ifc-validator dir", "public/plugins/ifc-validator"],
  ["csv-takeoff dir", "public/plugins/csv-takeoff"],
  ["family-from-csv dir", "public/plugins/family-from-csv"],
  ["clash-rule-pack dir", "public/plugins/clash-rule-pack"],
  ["element-counter dir", "public/plugins/element-counter"],
  ["hello dir", "public/plugins/hello"],
  ["PLUGIN_SDK.md exists", "docs/PLUGIN_SDK.md"],
];

let pass = 0;
let fail = 0;

console.log("\n=== verify-v55: Plugin SDK v1.0 ===\n");

console.log("Existence checks:");
for (const [label, file] of existenceChecks) {
  if (checkExists(label, file)) pass++; else fail++;
}

console.log("\nContent checks:");
for (const [label, file, regex] of checks) {
  if (check(label, file, regex)) pass++; else fail++;
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
