#!/usr/bin/env node
// Tool-catalog gate (#102). Fails on:
//  - a registered command (literal OR dynamically resolved: table loops,
//    template ids fed by literal tables, method/alias calls, the
//    bim-experience BimCommand indirection) that is not in
//    documentation/tool-catalog.json   (undocumented tool)
//  - a catalog entry whose id is neither a registered command nor a pattern
//    entry (id ending in `.*` with `"dynamic": true`)   (dead entry)
//  - a dynamic template in source (ids from runtime data: clash scenarios,
//    saved schedules, per-level switches) with no covering pattern entry
//  - a pattern entry that covers no template in source   (dead pattern)
//  - a `"dynamic": true` entry whose id is not a pattern   (dynamic:true is
//    only meaningful on pattern ids; a concrete dynamic command must be
//    enumerated by the scanner, not hand-exempted)
//  - an unresolved dynamic registration site (a registerCommand call the
//    scanner cannot explain) — never silently ignored
//  - duplicate ids in the catalog or duplicate registrations across src
//    (silent overwrite at runtime), literal and dynamic alike
//  - status outside the allowed set; tested/runtime-verified without existing test files;
//    partial/experimental without a knownLimitation; missing name/module/discipline
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
const { commands, dynamicSites, patterns } = scanSource(root);

const isPatternEntry = (t) => typeof t.id === "string" && t.id.endsWith(".*");

for (const s of dynamicSites) {
  errors.push(`unresolved dynamic registration site: ${s.file}:${s.line} — ${s.reason}`);
}

const seen = new Map();
for (const t of tools) { if (seen.has(t.id)) errors.push(`duplicate catalog id: ${t.id}`); seen.set(t.id, t); }
const byId = new Map();
for (const c of commands) { (byId.get(c.id) ?? byId.set(c.id, []).get(c.id)).push(`${c.file} [${c.origin}]`); }
for (const [id, files] of byId) if (files.length > 1) errors.push(`command id registered ${files.length}× (later registration silently overwrites): ${id} in ${files.join(", ")}`);
for (const id of byId.keys()) if (!seen.has(id)) errors.push(`registered command not in catalog: ${id} (${byId.get(id)[0]}) — run: node scripts/sync-tool-catalog.mjs`);

// Pattern entries cover data-driven templates: one catalog entry per
// literal id prefix, e.g. `clash.scenario.*` covers every scenario id the
// clash service creates at runtime.
const patternEntries = tools.filter((t) => isPatternEntry(t));
for (const p of patterns) {
  const covering = patternEntries.find((t) => t.dynamic === true && p.prefix === t.id.slice(0, -1));
  if (!covering) errors.push(`dynamic template has no catalog pattern entry: ${p.prefix}* (${p.file}:${p.line}) — add a "dynamic": true entry with id "${p.prefix}*"`);
}
for (const t of patternEntries) {
  const prefix = t.id.slice(0, -1);
  if (t.dynamic !== true) errors.push(`catalog ${t.id}: pattern entries must set "dynamic": true`);
  if (!patterns.some((p) => p.prefix === prefix)) errors.push(`catalog ${t.id}: dead pattern — no dynamic template with this prefix in src`);
}
for (const t of tools) {
  const where = `catalog ${t.id}`;
  if (!t.name) errors.push(`${where}: missing name`);
  if (!t.discipline) errors.push(`${where}: missing discipline`);
  if (!t.module) errors.push(`${where}: missing module`);
  else if (!existsSync(path.join(root, t.module))) errors.push(`${where}: module file does not exist: ${t.module}`);
  if (!STATUSES.has(t.status)) errors.push(`${where}: invalid status "${t.status}"`);
  if (!byId.has(t.id) && !isPatternEntry(t)) {
    if (t.dynamic === true) errors.push(`${where}: "dynamic": true on a concrete id with no registration — dynamic ids must be enumerated by the scanner (remove the flag or register the command)`);
    else errors.push(`${where}: dead entry — no registerCommand uses this id`);
  }
  if (["tested", "runtime-verified"].includes(t.status)) {
    if (!(t.tests ?? []).length) errors.push(`${where}: claims ${t.status} but lists no tests`);
    for (const f of t.tests ?? []) if (!existsSync(path.join(root, f))) errors.push(`${where}: claims ${t.status} but missing test: ${f}`);
  }
  if (["partial", "experimental"].includes(t.status) && !t.knownLimitation) errors.push(`${where}: ${t.status} requires knownLimitation text`);
}
if (errors.length) { console.error(errors.join("\n")); console.error(`=== tool catalog: ${errors.length} problem(s) ===`); process.exit(1); }
const literalCount = commands.filter((c) => c.origin === "literal" || c.origin.startsWith("literal:")).length;
const dynamicCount = commands.length - literalCount;
console.log(`tool catalog consistent: ${commands.length} registered commands (${literalCount} literal + ${dynamicCount} dynamic), ${tools.length} catalog entries (${patternEntries.length} pattern), ${dynamicSites.length} unresolved dynamic site(s)`);
