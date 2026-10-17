import fs from "node:fs/promises";
import path from "node:path";

const root = process.argv[2] || process.cwd();
const rel = "src/critical-gaps-boot.ts";
const full = path.join(root, rel);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let src;

try {
  src = await fs.readFile(full, "utf8");
} catch (e) {
  console.log("SKIP: cannot read " + rel + " (" + (e.code || e.message) + ")");
  process.exit(0);
}

const importWheel =
  'import { setupWheelArbiter } from "./core/wheel-arbiter";';

const importRealtime =
  'import { setupRealtimeClient } from "./modules/collaboration/realtime-client";';

const callWheel =
  'await safe("wheel-arbiter", setupWheelArbiter);';

const callRealtime =
  'await safe("realtime-client", setupRealtimeClient);';

let changed = false;

if (!src.includes(importWheel)) {
  src = importWheel + "\n" + src;
  changed = true;
}

if (!src.includes(importRealtime)) {
  src = importRealtime + "\n" + src;
  changed = true;
}

if (!src.includes(callWheel) || !src.includes(callRealtime)) {
  const anchor =
    'await safe("revit-mouse-policy", setupRevitMousePolicy);';

  if (src.includes(anchor)) {
    const replacement =
      callWheel +
      "\n  " +
      callRealtime +
      "\n  " +
      anchor;

    src = src.replace(anchor, replacement);
    changed = true;
  } else {
    const readyAnchor =
      'console.log("[critical-gaps-boot] remaining gaps patch ready");';

    if (src.includes(readyAnchor)) {
      const replacement =
        callWheel +
        "\n  " +
        callRealtime +
        "\n\n  " +
        readyAnchor;

      src = src.replace(readyAnchor, replacement);
      changed = true;
    } else {
      src =
        src.trimEnd() +
        "\n\n" +
        callWheel +
        "\n" +
        callRealtime +
        "\n";

      changed = true;
    }
  }
}

if (!changed) {
  console.log("NO CHANGE: boot already wires wheel-arbiter and realtime-client.");
  process.exit(0);
}

await fs.copyFile(full, full + ".bak-" + stamp);
await fs.writeFile(full, src, "utf8");

console.log("PATCHED: src/critical-gaps-boot.ts");