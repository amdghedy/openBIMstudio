import fs from "node:fs/promises";
import path from "node:path";

const root = process.argv[2] || process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function backup(rel) {
  const full = path.join(root, rel);
  if (await exists(full)) {
    await fs.copyFile(full, full + ".bak-" + stamp);
    console.log("Backup: " + rel);
  }
}

async function read(rel) {
  return fs.readFile(path.join(root, rel), "utf8");
}

async function write(rel, content) {
  await fs.writeFile(path.join(root, rel), content, "utf8");
}

function findMatchingBrace(text, start) {
  if (text[start] !== "{") return -1;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function parseValue(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;

  const ch = text[i];

  if (ch === '"' || ch === "'" || ch === "`") {
    const q = ch;
    i++;

    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }

      if (text[i] === q) {
        i++;
        break;
      }

      i++;
    }

    return i;
  }

  if (ch === "[" || ch === "{") {
    const open = ch;
    const close = ch === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let quote = "";
    let escaped = false;

    for (; i < text.length; i++) {
      const c = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (c === "\\") {
          escaped = true;
        } else if (c === quote) {
          inString = false;
        }
        continue;
      }

      if (c === '"' || c === "'" || c === "`") {
        inString = true;
        quote = c;
        continue;
      }

      if (c === open) {
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }

    return i;
  }

  while (i < text.length && !/[,;)\}\s]/.test(text[i])) {
    i++;
  }

  return i;
}

function findBlockStart(src, key) {
  const re = new RegExp("(^|\\n)\\s*" + key + "\\s*:\\s*\\{");
  const m = re.exec(src);

  if (!m) return -1;

  return m.index + m[0].length - 1;
}

function replaceTargetInBlock(src, blockStart) {
  const blockEnd = findMatchingBrace(src, blockStart);

  if (blockEnd < 0) {
    return { src, changed: false, reason: "brace-match-failed" };
  }

  const inner = src.slice(blockStart + 1, blockEnd);
  const targetRe = /(^|[^\w$.])target\s*:/;
  const tm = targetRe.exec(inner);

  if (!tm) {
    const insert = ' target: "esnext",';
    const out =
      src.slice(0, blockStart + 1) +
      insert +
      src.slice(blockStart + 1);

    return { src: out, changed: true, reason: "inserted-target" };
  }

  const colonAbs = blockStart + 1 + tm.index + tm[0].length - 1;
  const valStart = colonAbs + 1;
  const valEnd = parseValue(src, valStart);
  const current = src.slice(valStart, valEnd).trim();

  if (
    current === '"esnext"' ||
    current === "'esnext'" ||
    current === "`esnext`"
  ) {
    return { src, changed: false, reason: "already-esnext" };
  }

  const out =
    src.slice(0, valStart) +
    ' "esnext"' +
    src.slice(valEnd);

  return { src: out, changed: true, reason: "replaced-target" };
}

function ensureBlockWithTarget(src, key) {
  const start = findBlockStart(src, key);

  if (start >= 0) {
    return replaceTargetInBlock(src, start);
  }

  const dc = src.indexOf("defineConfig(");

  if (dc < 0) {
    return { src, changed: false, reason: "no-defineConfig" };
  }

  const ob = src.indexOf("{", dc);

  if (ob < 0) {
    return { src, changed: false, reason: "no-config-brace" };
  }

  const insert = "\n  " + key + ': { target: "esnext" },';
  const out = src.slice(0, ob + 1) + insert + src.slice(ob + 1);

  return { src: out, changed: true, reason: "added-block" };
}

async function patchPackageJson() {
  const rel = "package.json";
  const full = path.join(root, rel);

  if (!(await exists(full))) {
    console.log("SKIP: package.json not found");
    return;
  }

  const original = await read(rel);
  const pkg = JSON.parse(original);

  const desired = "tsc && vite build --target esnext";

  if (!pkg.scripts) {
    pkg.scripts = {};
  }

  if (pkg.scripts.build === desired) {
    console.log("NO CHANGE: package.json build script already forced.");
    return;
  }

  pkg.scripts.build = desired;

  await backup(rel);
  await write(rel, JSON.stringify(pkg, null, 2) + "\n");
  console.log("PATCHED: package.json build script -> " + desired);
}

async function patchViteConfig() {
  const rel = "vite.config.ts";
  const full = path.join(root, rel);

  if (!(await exists(full))) {
    console.log("SKIP: vite.config.ts not found");
    return;
  }

  let src = await read(rel);
  const original = src;
  let changed = false;

  const buildRes = ensureBlockWithTarget(src, "build");
  src = buildRes.src;

  if (buildRes.changed) {
    changed = true;
    console.log("PATCHED: vite.config.ts build.target -> esnext (" + buildRes.reason + ")");
  } else {
    console.log("NOTE: vite.config.ts build.target (" + buildRes.reason + ")");
  }

  const esbuildRes = ensureBlockWithTarget(src, "esbuild");
  src = esbuildRes.src;

  if (esbuildRes.changed) {
    changed = true;
    console.log("PATCHED: vite.config.ts esbuild.target -> esnext (" + esbuildRes.reason + ")");
  } else {
    console.log("NOTE: vite.config.ts esbuild.target (" + esbuildRes.reason + ")");
  }

  if (changed) {
    await backup(rel);
    await write(rel, src);
    console.log("WROTE: vite.config.ts");
  } else {
    console.log("NO CHANGE: vite.config.ts");
  }
}

async function main() {
  console.log("");
  console.log("Forcing Vite build target for top-level await...");
  console.log("");

  await patchPackageJson();
  await patchViteConfig();

  console.log("");
  console.log("Force build target patch completed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});