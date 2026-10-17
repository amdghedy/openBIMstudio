// Dedupe the [code-review-fix] block in scripts/verify-input-focus.mjs.
// Idempotent. Touches one file only.
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || process.cwd();
const rel = "scripts/verify-input-focus.mjs";
const full = path.join(root, rel);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

// Marker exactly as Fix-OpenBIMStudio-Issues.ps1 writes it (with a space
// after the colon -- that is the source of the original idempotency bug).
const MARKER = "// ---- openbim-fix: verify-input-focus.mjs -- code review fix contract ----";

if (!fs.existsSync(full)) {
  console.log("  [SKIP] " + rel + " (missing)");
  process.exit(0);
}

const raw = fs.readFileSync(full, "utf8");
const hasCRLF = raw.indexOf("\r\n") >= 0;
const src = hasCRLF ? raw.split("\r\n").join("\n") : raw;

const parts = src.split(MARKER);
const markerCount = parts.length - 1;

if (markerCount === 0) {
  console.log("  [SKIP] " + rel + " (no [code-review-fix] marker -- nothing to dedupe)");
  process.exit(0);
}

if (markerCount === 1) {
  console.log("  [NOOP] " + rel + " (1 marker, already clean)");
  process.exit(0);
}

console.log("  Found " + markerCount + " copies of the [code-review-fix] block.");

// parts[0]   = everything before the first marker
// parts[1]   = body of block 1 (up to, but not including, marker 2)
// parts[2]   = body of block 2 (up to, but not including, marker 3)
// ...
// parts[last]= body of the last block, immediately followed by the
//              original trailing content that used to sit right before
//              `const byGroup = {};`.
const bodies = parts.slice(1, parts.length - 1);  // all but the last
const lastBody = parts[parts.length - 1];

// Guard: the last part must begin with the same body as the others,
// followed by the original trailing content.
const reference = parts[1];
if (!lastBody.startsWith(reference)) {
  console.log("  [WARN] " + rel + " (block bodies differ; refusing to guess)");
  console.log("        Run this to inspect:");
  console.log("        node -e \"const s=require('fs').readFileSync('" + rel + "','utf8');");
  console.log("          const p=s.split('" + MARKER.replace(/'/g, "\\'") + "');");
  console.log("          p.forEach((x,i)=>console.log('--- part',i,'---\\n'+x.slice(0,200)));\"");
  process.exit(1);
}
for (let i = 0; i < bodies.length; i++) {
  if (bodies[i] !== reference) {
    console.log("  [WARN] " + rel + " (block body #" + (i + 1) + " differs from #1)");
    process.exit(1);
  }
}

const trailing = lastBody.slice(reference.length);
const deduped = parts[0] + MARKER + reference + trailing;

fs.copyFileSync(full, full + ".bak-dedupe-" + stamp);
fs.writeFileSync(full, hasCRLF ? deduped.split("\n").join("\r\n") : deduped, "utf8");

console.log("  [PATCH] " + rel + " (" + markerCount + " -> 1 copy, backup .bak-dedupe-" + stamp + ")");