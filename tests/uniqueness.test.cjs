/**
 * Uniqueness gate — one authoritative implementation per feature.
 *
 * Scans src/ for the four classic duplication shapes:
 *   1. two registerCommand() calls with the same id (second silently wins,
 *      saved shortcuts point at the wrong action)
 *   2. two modules assigning the same ctx.features.<name> literal (two
 *      "authoritative" implementations of one feature)
 *   3. two files creating the same root element id="obs-…" (panels fight
 *      over one DOM node)
 *   4. two command-palette panel entries with the same key (panel.X.toggle)
 *
 * A violation must be fixed by deleting the loser, renaming with an explicit
 * versioned id, or (rare, justified) adding to ALLOW with a reason comment.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const files = walk(path.join(ROOT, "src")).filter((f) => f.endsWith(".ts"));
const read = (f) => fs.readFileSync(f, "utf8");
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");

/** Global allowlist: pairs intentionally duplicated (back-compat shims). */
const ALLOW = new Set([
  // e.g. "commandId|src/a.ts|src/b.ts"
]);

function collect(re, group = 1) {
  const hits = new Map(); // value -> [file,...]
  for (const f of files) {
    const t = read(f);
    for (const m of t.matchAll(re)) {
      const v = m[group];
      if (!v) continue;
      const list = hits.get(v) ?? [];
      list.push(rel(f));
      hits.set(v, list);
    }
  }
  return hits;
}

function duplicates(hits) {
  const out = [];
  for (const [v, fl] of hits) {
    const uniq = [...new Set(fl)];
    if (uniq.length > 1) {
      const key = `${v}|${uniq.sort().join("|")}`;
      if (!ALLOW.has(key)) out.push({ v, files: uniq });
    }
  }
  return out;
}

// 1. duplicate command ids across registerCommand call sites
{
  const dup = duplicates(collect(/registerCommand\(\s*\{\s*id:\s*["']([^"']+)["']/g));
  ok(
    dup.length === 0,
    "duplicate command ids (second registration silently wins):\n" +
      dup.map((d) => `  ${d.v}  ←  ${d.files.join(", ")}`).join("\n"),
  );
}

// 2. duplicate literal ctx.features.<name> assignments in different files
{
  const dup = duplicates(collect(/features\??\.([A-Za-z_$][\w$]*)\s*=\s*[^=]/g));
  ok(
    dup.length === 0,
    "same ctx.features.<name> assigned in multiple files (two authoritative implementations):\n" +
      dup.map((d) => `  features.${d.v}  ←  ${d.files.join(", ")}`).join("\n"),
  );
}

// 3. duplicate root element ids: .id = "obs-…" in different files
{
  const dup = duplicates(collect(/\.id\s*=\s*["'](obs-[A-Za-z0-9_-]+)["']/g));
  ok(
    dup.length === 0,
    'same DOM id "obs-…" created in multiple files (nodes fight over one element):\n' +
      dup.map((d) => `  #${d.v}  ←  ${d.files.join(", ")}`).join("\n"),
  );
}

// 4. duplicate command-palette panel keys (within the canonical panels array)
{
  const palette = read(path.join(ROOT, "src/features/command-palette.ts"));
  const arrMatch = palette.match(/const panels[^=]*=\s*\[([\s\S]*?)\n\s*\];/);
  ok(arrMatch, "command-palette panels array found");
  const keys = [];
  if (arrMatch) {
    for (const m of arrMatch[1].matchAll(/\[\s*["']([A-Za-z_$][\w$]*)["']/g)) keys.push(m[1]);
  }
  const seen = new Set();
  const dup = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  ok(
    dup.length === 0,
    `duplicate panel registry keys (${keys.length} entries scanned): ${dup.join(", ")}`,
  );
}

console.log(`uniqueness: ${n} checks passed (${files.length} files scanned)`);
