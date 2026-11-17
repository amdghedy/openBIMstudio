#!/usr/bin/env node
// Every command in the canonical command directory must be catalogued; every
// status claim must have real test files.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fromRoot = (file) => path.join(root, file);
const catalog = JSON.parse(readFileSync(fromRoot("documentation/tool-catalog.json"), "utf8"));

function scanCommandRegistry(relativeDir) {
  const absoluteDir = fromRoot(relativeDir);
  if (!existsSync(absoluteDir)) return [];
  const ids = new Set();
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/registerCommand\s*\(\s*\{\s*id\s*:\s*["']([^"']+)["']/g)) {
          ids.add(match[1]);
        }
      }
    }
  }
  visit(absoluteDir);
  return [...ids].sort();
}

const catalogTools = Array.isArray(catalog.tools) ? catalog.tools : [];
const commandIds = scanCommandRegistry("src/commands");
const catalogIds = new Set(catalogTools.map((tool) => tool.id));
const errors = [];
for (const id of commandIds) {
  if (!catalogIds.has(id)) errors.push(`UI command not in catalog: ${id}`);
}
for (const tool of catalogTools) {
  if (["tested", "runtime-verified"].includes(tool.status)) {
    for (const test of tool.tests ?? []) {
      if (!existsSync(fromRoot(test))) errors.push(`${tool.id} claims ${tool.status} but missing test: ${test}`);
    }
  }
  if (tool.status === "partial" && !tool.knownLimitation) {
    errors.push(`${tool.id} is partial but has no knownLimitation text`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`tool catalog consistent: ${commandIds.length} canonical commands checked, ${catalogTools.length} catalog entries verified`);
