// Report-only hardening lint (item 17).
//
// Runs the warn-level freeze rules in eslint.config.mjs over src/ and prints
// the per-rule violation counts. It NEVER fails on findings: the counts are
// the baseline (727 __obs globals, ~2,722 explicit `any`s on 2026-11-21),
// and a future item ratchets them down. It exits non-zero only when ESLint
// itself cannot run (missing install, broken config), so a red run means the
// tooling broke, not that a count moved.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eslintBin = path.join(root, "node_modules", "eslint", "bin", "eslint.js");

const result = spawnSync(
  process.execPath,
  [eslintBin, "src", "--format", "json"],
  { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
);
if (result.error) {
  console.error(`lint:hardening: cannot run ESLint: ${result.error.message}`);
  process.exit(1);
}
let reports;
try {
  reports = JSON.parse(result.stdout);
} catch {
  console.error("lint:hardening: ESLint did not return JSON output.");
  if (result.stdout) console.error(result.stdout.slice(0, 2000));
  if (result.stderr) console.error(result.stderr.slice(0, 2000));
  process.exit(1);
}

const byRule = new Map();
let warnings = 0;
let errors = 0;
let filesWithFindings = 0;
for (const file of reports) {
  if (file.messages.length) filesWithFindings += 1;
  for (const message of file.messages) {
    if (message.severity === 2) errors += 1;
    else warnings += 1;
    const key = message.ruleId ?? "(no rule)";
    byRule.set(key, (byRule.get(key) ?? 0) + 1);
  }
}
console.log("=== lint:hardening (report-only; findings never fail this step) ===");
console.log(`files scanned: ${reports.length}, files with findings: ${filesWithFindings}`);
console.log(`warnings: ${warnings}, errors: ${errors}`);
for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule}: ${count}`);
}
console.log("baseline 2026-11-21: __obs freeze + explicit-any counts above;");
console.log("ratchet them down before flipping any rule from warn to error.");
