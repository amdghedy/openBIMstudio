/**
 * Copies node_modules/web-ifc/* into public/web-ifc/*
 * so the runtime can fetch them at /web-ifc/<file>.
 * Runs as a postinstall hook and can be called directly:
 *   node scripts/copy-web-ifc.mjs
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const src  = resolve(root, "node_modules", "web-ifc");
const dst  = resolve(root, "public", "web-ifc");

if (!existsSync(src)) {
  console.log("[copy-web-ifc] node_modules/web-ifc not found — skipping.");
  process.exit(0);
}

mkdirSync(dst, { recursive: true });

let n = 0;
for (const f of readdirSync(src)) {
  const s = join(src, f);
  if (!statSync(s).isFile()) continue;
  copyFileSync(s, join(dst, f));
  n++;
}
console.log(`[copy-web-ifc] Copied ${n} file(s) → public/web-ifc/`);