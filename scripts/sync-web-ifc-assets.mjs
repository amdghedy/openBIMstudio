#!/usr/bin/env node
/**
 * Keep the browser-served web-ifc assets byte-for-byte identical to the
 * installed npm package. This prevents JS/WASM ABI drift after npm install.
 *
 * Two copies are maintained:
 *  1. public/web-ifc/*            — the long-standing root URLs. Older deployed
 *     builds (and their PWA service-worker precaches) still request these, and
 *     they stay valid because a given app build bundles exactly one web-ifc JS.
 *  2. public/web-ifc/<version>/*  — versioned URLs used by the CURRENT build
 *     (see __WEB_IFC_VERSION__ in vite.config.ts / wasmPath() in
 *     src/features/importer.ts). Because the URL changes whenever the pinned
 *     web-ifc version changes, a new build can never be handed stale WASM
 *     bytes from a browser cache, an edge cache, or a stale service-worker
 *     precache — the exact failure mode of "StreamMeshes called with N
 *     arguments, expected M" BindingErrors.
 *
 * The versioned folder is generated (git-ignored); the root copies stay
 * tracked so fresh clones of older branches keep serving a complete set.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "node_modules", "web-ifc");
const targetDir = path.join(root, "public", "web-ifc");
const assets = ["web-ifc-api.js", "web-ifc.wasm", "web-ifc-mt.wasm", "web-ifc-node.wasm"];

if (!existsSync(sourceDir)) {
  console.error("web-ifc is not installed. Run npm install first.");
  process.exit(1);
}

let version = "";
try {
  version = JSON.parse(readFileSync(path.join(sourceDir, "package.json"), "utf8")).version || "";
} catch { /* fall back to root-only sync */ }

mkdirSync(targetDir, { recursive: true });
for (const name of assets) {
  const source = path.join(sourceDir, name);
  if (!existsSync(source)) {
    console.error(`Missing installed web-ifc asset: ${name}`);
    process.exit(1);
  }
  copyFileSync(source, path.join(targetDir, name));
}

let versionedNote = "root only";
if (version) {
  const versionedDir = path.join(targetDir, version);
  mkdirSync(versionedDir, { recursive: true });
  for (const name of assets) {
    copyFileSync(path.join(sourceDir, name), path.join(versionedDir, name));
  }
  versionedNote = `root + /web-ifc/${version}/`;
}
console.log(`Synced ${assets.length} web-ifc assets from node_modules/web-ifc (${versionedNote}).`);
