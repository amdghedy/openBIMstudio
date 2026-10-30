#!/usr/bin/env node
/**
 * Keep the browser-served web-ifc assets byte-for-byte identical to the
 * installed npm package. This prevents JS/WASM ABI drift after npm install.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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
mkdirSync(targetDir, { recursive: true });
for (const name of assets) {
  const source = path.join(sourceDir, name);
  const target = path.join(targetDir, name);
  if (!existsSync(source)) {
    console.error(`Missing installed web-ifc asset: ${name}`);
    process.exit(1);
  }
  copyFileSync(source, target);
}
console.log(`Synced ${assets.length} web-ifc assets from node_modules/web-ifc.`);
