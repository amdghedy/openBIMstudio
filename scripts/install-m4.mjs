/**
 * Install M4 View Templates + Auto-Dimensions into an openBIMstudio project root.
 *
 * Usage:
 *   node scripts/install-m4.mjs <projectRoot> [--dry-run]
 *
 * Copies src modules and patches critical-gaps-boot.ts to load m4-view-dims-boot.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const SRC_FROM = path.join(PACKAGE_ROOT, "src");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const projectRoot = args.find((a) => !a.startsWith("-")) || process.cwd();

function log(msg) {
  console.log(`[install-m4] ${msg}`);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) {
    log(`skip missing: ${from}`);
    return 0;
  }
  let n = 0;
  const entries = fs.readdirSync(from, { withFileTypes: true });
  if (!dryRun) fs.mkdirSync(to, { recursive: true });
  for (const e of entries) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) {
      n += copyDir(s, d);
    } else {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
      }
      log(`${dryRun ? "would copy" : "copied"} ${path.relative(PACKAGE_ROOT, s)} → ${path.relative(projectRoot, d)}`);
      n++;
    }
  }
  return n;
}

function patchBoot(bootPath) {
  if (!fs.existsSync(bootPath)) {
    log(`critical-gaps-boot.ts not found at ${bootPath} — skip patch`);
    return false;
  }
  let text = fs.readFileSync(bootPath, "utf8");
  if (text.includes("m4-view-dims-boot")) {
    log("boot already references m4-view-dims-boot — no patch needed");
    return true;
  }

  const snippet = `
  await safe("m4-view-dims", async () => {
    const m: Any = await import("./features/m4-view-dims-boot");
    await m.setupM4ViewDims?.();
  });
`;

  // Insert before the final success log if present
  const marker = 'console.log("[critical-gaps-boot] all critical gaps wired")';
  if (text.includes(marker)) {
    text = text.replace(marker, `${snippet}\n  ${marker}`);
  } else {
    // append before last closing of runOnce if possible
    const idx = text.lastIndexOf("console.log");
    if (idx > 0) {
      text = text.slice(0, idx) + snippet + "\n  " + text.slice(idx);
    } else {
      text += "\n" + snippet;
    }
  }

  if (!dryRun) {
    fs.writeFileSync(bootPath, text, "utf8");
  }
  log(`${dryRun ? "would patch" : "patched"} ${bootPath}`);
  return true;
}

function main() {
  log(`project root: ${projectRoot}`);
  log(`package root: ${PACKAGE_ROOT}`);
  if (dryRun) log("DRY RUN — no files written");

  const destSrc = path.join(projectRoot, "src");
  if (!fs.existsSync(destSrc)) {
    console.error(`[install-m4] ERROR: ${destSrc} does not exist. Pass the openBIMstudio project root.`);
    process.exit(1);
  }

  const count = copyDir(SRC_FROM, destSrc);
  log(`files ${dryRun ? "to copy" : "copied"}: ${count}`);

  const bootPath = path.join(destSrc, "critical-gaps-boot.ts");
  patchBoot(bootPath);

  log("done.");
  log("Next: npm run typecheck && npm run dev");
  log("Then: Ctrl+Shift+V (VG), Ctrl+Shift+D (Auto Dim), or Command Center → View · Annotate (M4)");
}

main();
