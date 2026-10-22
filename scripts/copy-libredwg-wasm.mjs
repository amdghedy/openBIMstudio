// Copies the libredwg WASM next to the app (public/libredwg/) so the DWG reader
// can load it from "/libredwg/" regardless of how the bundler rewrites asset URLs.
// Never fails the install/build: the reader also tries its own default location.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = path.join(root, "node_modules", "@mlightcad", "libredwg-web");
const dest = path.join(root, "public", "libredwg");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.wasm$/i.test(e.name)) out.push(p);
  }
  return out;
}

try {
  if (!fs.existsSync(pkg)) {
    console.warn("[copy-libredwg-wasm] @mlightcad/libredwg-web not installed - run npm install");
  } else {
    const files = walk(pkg);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) fs.copyFileSync(f, path.join(dest, path.basename(f)));
    console.log(`[copy-libredwg-wasm] copied ${files.length} wasm file(s) to public/libredwg`);
  }
} catch (e) {
  console.warn("[copy-libredwg-wasm] skipped:", e.message);
}
