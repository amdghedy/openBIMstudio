#!/usr/bin/env node
/**
 * One-time setup for the cumulative visit counter.
 *
 *   1. Creates the Cloudflare KV namespace:  wrangler kv namespace create VISITS
 *   2. Writes its id into wrangler.jsonc (replaces PASTE_KV_NAMESPACE_ID_HERE)
 *
 * Requires wrangler to be authenticated (run `npx wrangler login` once, or set
 * CLOUDFLARE_API_TOKEN). After this script completes, deploy with:
 *
 *   npm run deploy
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "wrangler.jsonc");
const PLACEHOLDER = "PASTE_KV_NAMESPACE_ID_HERE";

function die(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function hex32(text) {
  const match = text.match(/"id"\s*:\s*"([0-9a-f]{32})"/i) || text.match(/\b([0-9a-f]{32})\b/);
  return match ? match[1] : null;
}

function run(command) {
  return execSync(command, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
}

// 1. Already configured?
const config = readFileSync(CONFIG_PATH, "utf8");
if (!config.includes(PLACEHOLDER)) {
  console.log("✔ wrangler.jsonc already has a KV namespace id — nothing to do.");
  console.log("  Deploy with:  npm run deploy");
  process.exit(0);
}

// 2. Create the namespace (or reuse one that already exists).
console.log("· Creating Cloudflare KV namespace VISITS (needs wrangler auth)…");
let namespaceId = null;
try {
  namespaceId = hex32(run("npx wrangler kv namespace create VISITS"));
} catch {
  // Common case: the namespace already exists — wrangler exits non-zero.
  console.log("· Create failed (namespace may already exist) — looking it up…");
}

if (!namespaceId) {
  try {
    const list = run("npx wrangler kv namespace list");
    const namespaces = JSON.parse(list);
    const found = Array.isArray(namespaces)
      ? namespaces.find((ns) => typeof ns?.title === "string" && ns.title.includes("VISITS"))
      : null;
    if (found?.id) namespaceId = found.id;
  } catch {
    /* handled below */
  }
}

if (!namespaceId) {
  die(
    "Could not determine the KV namespace id.\n" +
      "  1. Run:  npx wrangler login   (or set CLOUDFLARE_API_TOKEN)\n" +
      "  2. Run:  npx wrangler kv namespace create VISITS\n" +
      '  3. Paste the printed id into wrangler.jsonc → kv_namespaces[0].id'
  );
}

// 3. Patch wrangler.jsonc.
writeFileSync(CONFIG_PATH, config.replace(PLACEHOLDER, namespaceId), "utf8");
console.log(`\n✔ KV namespace ready: ${namespaceId}`);
console.log("  Next step:  npm run deploy");
