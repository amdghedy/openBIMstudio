// Shared static scan of literal `registerCommand({ id: "…", label: "…", category: "…" })` calls across src/.
// Dynamic registrations (loops over tables, template ids) cannot be read statically; they are reported, not ignored.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(f, out); }
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(f);
  }
  return out;
}

/** @returns {{ commands: {id,label,category,file}[], dynamicSites: {file,line}[] }} */
export function scanSource(root) {
  const commands = [], dynamicSites = [];
  const srcDir = path.join(root, "src");
  for (const file of walk(srcDir)) {
    const src = readFileSync(file, "utf8");
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === "src/features/command-palette.ts") { /* definition + literal registrations live here too */ }
    const re = /registerCommand\s*\(\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const body = src.slice(m.index, m.index + 600);
      const id = /^registerCommand\s*\(\s*\{\s*id\s*:\s*["']([^"']+)["']/.exec(body);
      const line = src.slice(0, m.index).split("\n").length;
      if (!id) { dynamicSites.push({ file: rel, line }); continue; }
      const label = /label\s*:\s*["']([^"']*)["']/.exec(body)?.[1] ?? "";
      const category = /category\s*:\s*["']([^"']*)["']/.exec(body)?.[1] ?? "";
      commands.push({ id: id[1], label, category, file: rel });
    }
  }
  return { commands, dynamicSites };
}
