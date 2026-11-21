#!/usr/bin/env node
// Adds MISSING registered commands to documentation/tool-catalog.json as status "unverified" (never promotes anything).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSource } from "./tool-catalog-lib.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(root, "documentation/tool-catalog.json");
const cat = JSON.parse(readFileSync(p, "utf8"));
const have = new Set(cat.tools.map((t) => t.id));
let added = 0;
for (const c of scanSource(root).commands) {
  if (have.has(c.id)) continue;
  have.add(c.id); added++;
  cat.tools.push({ id: c.id, name: c.label || c.id, discipline: c.category || "General", module: c.file, status: "unverified", tests: [], verifiedScenarios: [] });
}
cat.tools.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(p, JSON.stringify(cat, null, 2) + "\n");
console.log(`added ${added} entries (all "unverified"); total ${cat.tools.length}`);
