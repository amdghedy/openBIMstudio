// Non-blocking structural report (hardening item 17, 2026-11-21).
//
// Reports, never fails: file sizes (excluding generated `.gen.ts`),
// `__obs` globals by the ui-honesty test's measure, the static import
// graph's strongly-connected components (cycles), and the dead-file scan.
// Run with `npm run report:structural`; wired into CI as a
// `continue-on-error` step in .github/workflows/unit-tests.yml.
//
// Methods (same as the 2026-11-20 structural-debt dive, re-run fresh on
// live main for item 17):
//  - sizes: line counts over src/**/*.ts(x), `.gen.ts` excluded.
//  - __obs: occurrences of `__obs[A-Za-z0-9]+` over src/**/*.ts, excluding
//    form-modal.ts and core/notify.ts — exactly what
//    tests/ui-honesty.test.cjs counts (ratchet baseline 727; 726 after
//    the item-17 deletions).
//  - cycles/dead files: static import graph over src/**/*.ts(x) —
//    `import ... from` and `export ... from` with literal specifiers,
//    comments stripped first; SCC via Tarjan. Dynamic `import()` is NOT
//    a graph edge: files reached only dynamically show up as
//    never-statically-imported and are then checked for a
//    quote-terminated literal path reference (the specifier as written)
//    across src/, scripts/, tests/, server/, index.html, package.json.
//    "No references" means no static importer AND no such literal ref.
//    A dynamically *constructed* import string can hide a use; the scan
//    is a signal, not a proof — verify with a build before deleting.
//
// The strict-tsc count is deliberately NOT part of this script: it takes
// minutes and is recorded separately (`npm run typecheck:strict`,
// baseline 6,353 errors on 2026-11-21, see docs/engineering/ISSUES.md
// P1-02). The lint counts are in `npm run lint:hardening`.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

function stripComments(code) {
  let out = "";
  let i = 0;
  let str = null;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (str) {
      out += c;
      if (c === "\\") { out += n || ""; i += 2; continue; }
      if (c === str) str = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { str = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < code.length && code[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Static import/from + export-from with a literal specifier. Dynamic
// import() and require() are intentionally excluded (see header).
const IMPORT_RE = /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+(?:[^'"]*?\s+from\s+)?)['"]([^'"]+)['"]/g;

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const files = walk(SRC);
const importedBy = new Map();
const edges = new Map();
for (const f of files) {
  const code = stripComments(readFileSync(f, "utf8"));
  const targets = new Set();
  let m;
  while ((m = IMPORT_RE.exec(code))) {
    const t = resolveImport(f, m[1]);
    if (t) targets.add(t);
  }
  edges.set(f, targets);
  for (const t of targets) {
    if (!importedBy.has(t)) importedBy.set(t, new Set());
    importedBy.get(t).add(f);
  }
}
let edgeCount = 0;
for (const t of edges.values()) edgeCount += t.size;

// Tarjan SCC (size > 1 or self-loop = a cycle).
const index = new Map();
const lowlink = new Map();
const onStack = new Set();
const stack = [];
let counter = 0;
const sccs = [];
function strongconnect(v) {
  index.set(v, counter); lowlink.set(v, counter); counter++;
  stack.push(v); onStack.add(v);
  for (const w of edges.get(v) || []) {
    if (!index.has(w)) { strongconnect(w); lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w))); }
    else if (onStack.has(w)) lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
  }
  if (lowlink.get(v) === index.get(v)) {
    const comp = [];
    let w;
    do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1 || (edges.get(v) || new Set()).has(v)) sccs.push(comp);
  }
}
for (const f of files) if (!index.has(f)) strongconnect(f);

// Literal-string search for never-imported files (quote-terminated
// specifier: the path as written in an import string, so a sibling file
// does not false-positive on a shared directory prefix).
const SEARCH_ROOTS = ["src", "scripts", "tests", "server", "index.html", "package.json"];
const searchFiles = [];
for (const r of SEARCH_ROOTS) {
  const p = join(ROOT, r);
  if (!existsSync(p)) continue;
  if (statSync(p).isFile()) { searchFiles.push(p); continue; }
  const pending = [p];
  while (pending.length) {
    const d = pending.pop();
    for (const e of readdirSync(d)) {
      const fp = join(d, e);
      const s = statSync(fp);
      if (s.isDirectory()) { if (e !== "node_modules") pending.push(fp); }
      else if (/\.(ts|tsx|js|mjs|cjs|json|html|yml|yaml|md)$/.test(e)) searchFiles.push(fp);
    }
  }
}
const contents = searchFiles.map((f) => ({ f, text: readFileSync(f, "utf8") }));
const GENERIC = new Set(["index", "types", "engine", "registry", "geometry", "store", "utils", "helpers", "constants", "schedule", "panel", "service", "core", "common", "shared", "base", "main", "api", "config", "data", "state", "events", "hooks"]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function literalRefs(file) {
  const base = basename(file).replace(/\.(d\.ts|ts|tsx)$/, "");
  const relPath = rel(file).replace(/^src\//, "").replace(/\.(d\.ts|ts|tsx)$/, "");
  const pathNeedles = [relPath];
  if (base === "index") pathNeedles.push(relPath.replace(/\/index$/, ""));
  const pathRes = pathNeedles.map((n) => new RegExp(`${escapeRe(n)}["']`));
  const baseNeedle = base.length >= 6 && !GENERIC.has(base) ? base : null;
  let pathHits = 0;
  let baseHits = 0;
  for (const { f, text } of contents) {
    if (resolve(f) === resolve(file)) continue;
    if (pathRes.some((re) => re.test(text))) pathHits++;
    else if (baseNeedle && text.includes(baseNeedle)) baseHits++;
  }
  return { pathHits, baseHits };
}

const neverImported = files.filter((f) => !importedBy.has(f));
const noRefs = [];
const baseOnly = [];
for (const f of neverImported) {
  const { pathHits, baseHits } = literalRefs(f);
  if (pathHits === 0 && baseHits === 0) noRefs.push(f);
  else if (pathHits === 0) baseOnly.push(f);
}

// __obs by the ui-honesty measure + explicit `any` by the grep measure.
const OBS_RE = /__obs[A-Za-z0-9]+/g;
const ANY_RE = /: any|as any|<any>/g;
let obsCount = 0;
let anyCount = 0;
for (const f of files) {
  // Same exclusions as the ui-honesty ratchet: dialog owners, and the
  // generated i18n dictionaries whose matches are translated strings.
  if (/form-modal\.ts$|core\/notify\.ts$|core\/i18n-catalogs\//.test(f)) continue;
  const text = readFileSync(f, "utf8");
  obsCount += (text.match(OBS_RE) || []).length;
  anyCount += (text.match(ANY_RE) || []).length;
}

// File sizes, generated `.gen.ts` excluded.
const sizes = [];
for (const f of files) {
  if (f.endsWith(".gen.ts")) continue;
  sizes.push([readFileSync(f, "utf8").split("\n").length, rel(f)]);
}
sizes.sort((a, b) => b[0] - a[0]);

console.log("=== structural report (non-blocking; report-only) ===");
console.log(`src files: ${files.length} (.ts/.tsx), static edges: ${edgeCount}`);
console.log("--- file sizes (lines, excluding .gen.ts) ---");
for (const [lines, f] of sizes.slice(0, 15)) console.log(`  ${String(lines).padStart(6)}  ${f}`);
console.log(`  files >1000 lines: ${sizes.filter(([n]) => n > 1000).length}, >3000 lines: ${sizes.filter(([n]) => n > 3000).length}`);
console.log("--- __obs globals (ui-honesty measure; ratchet baseline in tests/ui-honesty.test.cjs) ---");
console.log(`  __obs[A-Za-z0-9]+ occurrences: ${obsCount}`);
console.log(`  explicit 'any' occurrences (grep measure): ${anyCount}`);
console.log("--- import cycles (static graph, SCC size > 1) ---");
console.log(`  cycles: ${sccs.length}`);
for (const c of [...sccs].sort((a, b) => b.length - a.length)) {
  const members = c.map(rel);
  console.log(`  [${c.length}] ${members.slice(0, 8).join(" | ")}${members.length > 8 ? ` | ... (+${members.length - 8} more)` : ""}`);
}
console.log("--- dead-file scan ---");
console.log(`  never statically imported: ${neverImported.length}`);
console.log(`  of those, basename-only references (manual review): ${baseOnly.length}`);
console.log(`  no references at all: ${noRefs.length}`);
for (const f of noRefs.sort()) console.log(`    ${rel(f)}`);
console.log("=== end structural report ===");
