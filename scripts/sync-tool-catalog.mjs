#!/usr/bin/env node
// Adds MISSING registered commands to documentation/tool-catalog.json as status "unverified" (never promotes anything).
// Covers literal and dynamically resolved commands alike, plus a pattern
// entry (`<prefix>*`, `"dynamic": true`) for each data-driven template
// (clash scenarios, saved schedules, per-level switches) that has none.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSource } from "./tool-catalog-lib.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(root, "documentation/tool-catalog.json");
const cat = JSON.parse(readFileSync(p, "utf8"));
const have = new Set(cat.tools.map((t) => t.id));
let added = 0;
const { commands, patterns } = scanSource(root);
for (const c of commands) {
  if (have.has(c.id)) continue;
  have.add(c.id); added++;
  cat.tools.push({ id: c.id, name: c.label || c.id, discipline: c.category || "General", module: c.file, status: "unverified", tests: [], verifiedScenarios: [] });
}
for (const pat of patterns) {
  const id = `${pat.prefix}*`;
  if (have.has(id)) continue;
  have.add(id); added++;
  cat.tools.push({ id, name: `Dynamic commands (${pat.prefix}*)`, discipline: pat.category || "General", module: pat.file, status: "unverified", dynamic: true, tests: [], verifiedScenarios: [] });
}
cat.tools.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(p, JSON.stringify(cat, null, 2) + "\n");
console.log(`added ${added} entries (all "unverified"); total ${cat.tools.length}`);
