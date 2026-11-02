import fs from "node:fs/promises";
import path from "node:path";

const root = process.argv[2] || process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
async function backup(rel) {
  const full = path.join(root, rel);
  if (await exists(full)) await fs.copyFile(full, full + ".bak-" + stamp);
}
async function read(rel) { return fs.readFile(path.join(root, rel), "utf8"); }
async function write(rel, s) { await fs.writeFile(path.join(root, rel), s, "utf8"); }

// ---------------------------------------------------------------------------
// 1. drafting-bridge.ts : fix TS2345 on the raycaster camera argument
// ---------------------------------------------------------------------------
async function fixDraftingBridge() {
  const rel = "src/features/drafting-bridge.ts";
  if (!(await exists(path.join(root, rel)))) { console.log("SKIP: " + rel); return; }
  let s = await read(rel);
  const before = s;

  // Primary: cast at the call site (unique anchor).
  s = s.replace(
    "new THREE.Vector2(ndcX, ndcY), cam)",
    "new THREE.Vector2(ndcX, ndcY), cam as unknown as THREE.Camera)"
  );

  // Fallback (if formatting differed): loosen the local declaration.
  if (s === before) {
    s = s.replace(
      "const cam = cont.world?.camera?.three as Any;",
      "const cam = cont.world?.camera?.three as any;"
    );
  }

  if (s !== before) {
    await backup(rel);
    await write(rel, s);
    console.log("PATCHED: " + rel + " (camera cast)");
  } else if (s.includes("cam as unknown as THREE.Camera") || s.includes("camera?.three as any")) {
    console.log("NO CHANGE: " + rel + " (already fixed)");
  } else {
    console.log("SKIP: " + rel + " (anchor not found)");
  }
}

// ---------------------------------------------------------------------------
// 2. index.html : silence /favicon.ico 404 with an empty icon link
// ---------------------------------------------------------------------------
async function fixFavicon() {
  const rel = "index.html";
  if (!(await exists(path.join(root, rel)))) { console.log("SKIP: " + rel); return; }
  let s = await read(rel);
  if (/rel=["']icon["']/i.test(s) || /rel=["']shortcut icon["']/i.test(s)) {
    console.log("NO CHANGE: " + rel + " (icon link present)");
    return;
  }
  const m = s.match(/<head[^>]*>/i);
  if (!m) { console.log("SKIP: " + rel + " (no <head>)"); return; }
  const insertAt = m.index + m[0].length;
  s = s.slice(0, insertAt) + "\n    <link rel=\"icon\" href=\"data:,\">" + s.slice(insertAt);
  await backup(rel);
  await write(rel, s);
  console.log("PATCHED: " + rel + " (favicon suppressed)");
}

// ---------------------------------------------------------------------------
// 3. vite.config.ts : dedupe Lit so only ONE copy loads (kills the warning
//    and prevents double custom-element registration / dropped reactivity)
// ---------------------------------------------------------------------------
async function dedupeLit() {
  const rel = "vite.config.ts";
  if (!(await exists(path.join(root, rel)))) { console.log("SKIP: " + rel); return; }
  let s = await read(rel);
  const before = s;

  const already = /dedupe\s*:/.test(s) && /["']lit["']/.test(s);
  if (already) { console.log("NO CHANGE: " + rel + " (lit dedupe present)"); return; }

  const arr = '["lit", "lit-html", "lit-element", "@lit/reactive-element"]';

  const resolveIdx = s.indexOf("resolve:");
  if (resolveIdx >= 0) {
    const braceIdx = s.indexOf("{", resolveIdx);
    if (braceIdx >= 0) {
      s = s.slice(0, braceIdx + 1) + "\n    dedupe: " + arr + "," + s.slice(braceIdx + 1);
    }
  } else {
    const dcIdx = s.indexOf("defineConfig(");
    if (dcIdx >= 0) {
      const braceIdx = s.indexOf("{", dcIdx);
      if (braceIdx >= 0) {
        s = s.slice(0, braceIdx + 1) + "\n  resolve: { dedupe: " + arr + " }," + s.slice(braceIdx + 1);
      }
    }
  }

  if (s !== before) {
    await backup(rel);
    await write(rel, s);
    console.log("PATCHED: " + rel + " (Lit dedupe added)");
  } else {
    console.log("SKIP: " + rel + " (no safe anchor)");
  }
}

async function main() {
  console.log("");
  console.log("Running finalize patch...");
  console.log("");
  await fixDraftingBridge();
  await fixFavicon();
  await dedupeLit();
  console.log("");
  console.log("Finalize patch completed.");
}

main().catch((e) => { console.error(e); process.exit(1); });