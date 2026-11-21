#!/usr/bin/env node
// Tool-catalog gate (#102). Fails on:
//  - a literal-id registered command that is not in documentation/tool-catalog.json   (undocumented tool)
//  - a catalog entry whose id is neither a registered command nor flagged `"dynamic": true` with a `module`   (dead entry)
//  - duplicate ids in the catalog or duplicate literal registrations across src (silent overwrite at runtime)
//  - status outside the allowed set; tested/runtime-verified without existing test files;
//    partial/experimental without a knownLimitation; missing name/module/discipline
// Dynamic (non-literal-id) registrations are listed as a count, never silently ignored.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSource } from "./tool-catalog-lib.mjs";

const root = process.env.OBS_CATALOG_ROOT ? path.resolve(process.env.OBS_CATALOG_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATUSES = new Set(["unverified", "experimental", "partial", "tested", "runtime-verified"]);
const errors = [];
let catalog;
try { catalog = JSON.parse(readFileSync(path.join(root, "documentation/tool-catalog.json"), "utf8")); }
catch (e) { console.error("tool catalog unreadable/malformed:", e.message); process.exit(1); }
const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
const { commands, dynamicSites } = scanSource(root);

const seen = new Map();
for (const t of tools) { if (seen.has(t.id)) errors.push(`duplicate catalog id: ${t.id}`); seen.set(t.id, t); }
const byId = new Map();
for (const c of commands) { (byId.get(c.id) ?? byId.set(c.id, []).get(c.id)).push(c.file); }
for (const [id, files] of byId) if (files.length > 1) errors.push(`command id registered ${files.length}× (later registration silently overwrites): ${id} in ${files.join(", ")}`);
for (const id of byId.keys()) if (!seen.has(id)) errors.push(`registered command not in catalog: ${id} (${byId.get(id)[0]}) — run: node scripts/sync-tool-catalog.mjs`);
for (const t of tools) {
  const where = `catalog ${t.id}`;
  if (!t.name) errors.push(`${where}: missing name`);
  if (!t.discipline) errors.push(`${where}: missing discipline`);
  if (!t.module) errors.push(`${where}: missing module`);
  else if (!existsSync(path.join(root, t.module))) errors.push(`${where}: module file does not exist: ${t.module}`);
  if (!STATUSES.has(t.status)) errors.push(`${where}: invalid status "${t.status}"`);
  if (!byId.has(t.id) && !t.dynamic) errors.push(`${where}: dead entry — no registerCommand uses this id (set "dynamic": true only if registered via a table/loop)`);
  if (["tested", "runtime-verified"].includes(t.status)) {
    if (!(t.tests ?? []).length) errors.push(`${where}: claims ${t.status} but lists no tests`);
    for (const f of t.tests ?? []) if (!existsSync(path.join(root, f))) errors.push(`${where}: claims ${t.status} but missing test: ${f}`);
  }
  if (["partial", "experimental"].includes(t.status) && !t.knownLimitation) errors.push(`${where}: ${t.status} requires knownLimitation text`);
}
if (errors.length) { console.error(errors.join("\n")); console.error(`=== tool catalog: ${errors.length} problem(s) ===`); process.exit(1); }
console.log(`tool catalog consistent: ${byId.size} registered commands, ${tools.length} catalog entries, ${dynamicSites.length} dynamic registration site(s) not statically checkable`);
