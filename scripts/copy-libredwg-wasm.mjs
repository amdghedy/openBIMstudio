/**
 * Copy LibreDWG web assets into public/ so the DWG fallback reader can load them.
 *
 * Paths (both kept for compatibility with older and newer loaders):
 *   public/plugins/libredwg/   ← primary (dwg-parse-core OPTIONAL_READER_URL)
 *   public/libredwg/           ← secondary
 *
 * OPT-IN ONLY: set OBS_BUNDLE_LIBREDWG=1. LibreDWG is GPL-3.0, so the default product build must not ship it
 * (docs/COMMERCIAL-READINESS.md, tests/no-gpl-shipped.test.cjs). The acadrust engine is the shipped DWG reader.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// OPT-IN ONLY (OBS_BUNDLE_LIBREDWG=1). LibreDWG is GPL-3.0; the product owner requires a build with no licence
// restrictions for commercial / mass distribution, enforced by tests/no-gpl-shipped.test.cjs. Do NOT flip this default
// without an explicit decision from the owner (docs/COMMERCIAL-READINESS.md, L1).
if (process.env.OBS_BUNDLE_LIBREDWG !== "1") {
  console.log("[libredwg] not bundled (GPL-3.0; opt in with OBS_BUNDLE_LIBREDWG=1)");
  process.exit(0);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = path.join(root, "node_modules", "@mlightcad", "libredwg-web");
const dests = [
  path.join(root, "public", "plugins", "libredwg"),
  path.join(root, "public", "libredwg"),
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(p, out);
    } else if (/\.(wasm|js|mjs|cjs|json|data)$/i.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function copyTree() {
  if (!fs.existsSync(pkg)) {
    console.warn("[libredwg] @mlightcad/libredwg-web not installed — npm install, then rebuild");
    return;
  }
  const files = walk(pkg);
  // Prefer dist/ or build/ entry points
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
  const entryHints = [pkgJson.module, pkgJson.main, pkgJson.browser, pkgJson.exports?.["."]?.import, pkgJson.exports?.["."]?.default]
    .filter(Boolean)
    .map((s) => String(s).replace(/^\.\//, ""));

  for (const dest of dests) {
    fs.mkdirSync(dest, { recursive: true });
    let n = 0;
    for (const f of files) {
      const rel = path.relative(pkg, f);
      // Flatten wasm to dest root; keep structure for js under dist/
      const base = path.basename(f);
      if (/\.wasm$/i.test(base)) {
        fs.copyFileSync(f, path.join(dest, base));
        n++;
      } else if (/\.(js|mjs|cjs)$/i.test(base) && /libredwg|index|main|web/i.test(base)) {
        fs.copyFileSync(f, path.join(dest, base));
        n++;
      }
    }
    // Always try to materialize libredwg-web.js from package entry
    for (const hint of entryHints) {
      const src = path.join(pkg, hint);
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(dest, "libredwg-web.js"));
        // also copy sibling wasm next to entry
        const dir = path.dirname(src);
        for (const e of fs.readdirSync(dir)) {
          if (/\.wasm$/i.test(e)) fs.copyFileSync(path.join(dir, e), path.join(dest, e));
        }
        n++;
        break;
      }
    }
    console.log(`[libredwg] copied assets → ${path.relative(root, dest)} (${n} files)`);
  }
}

try {
  copyTree();
} catch (e) {
  console.warn("[libredwg] copy failed:", e?.message || e);
}
