import fs from "node:fs/promises";
import path from "node:path";

const root = process.argv[2] || process.cwd();
const rel = "vite.config.ts";
const full = path.join(root, rel);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let src;
try { src = await fs.readFile(full, "utf8"); }
catch (e) { console.log("SKIP: cannot read " + rel + " (" + (e.code || e.message) + ")"); process.exit(0); }

// Idempotent: already done?
if (/target:\s*["']esnext["']/.test(src)) {
  console.log("NO CHANGE: build.target already esnext.");
  process.exit(0);
}

function findMatchingBrace(text, start) {
  if (text[start] !== "{") return -1;
  let depth = 0, inStr = false, q = "", esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === q) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = true; q = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Parse a JS value starting at index i (after a colon). Returns end index (exclusive).
function parseValue(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  const ch = text[i];
  if (ch === '"' || ch === "'" || ch === "`") {
    const q = ch; i++;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === q) { i++; break; }
      i++;
    }
    return i;
  }
  if (ch === "[" || ch === "{") {
    const open = ch, close = ch === "[" ? "]" : "}";
    let depth = 0, inStr = false, sq = "", esc = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === sq) inStr = false;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { inStr = true; sq = c; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return i + 1; }
    }
    return i;
  }
  // bare token: identifier / number / true / false / null
  while (i < text.length && !/[,;)\}\s]/.test(text[i])) i++;
  return i;
}

let changed = false;

// 1) Is there a top-level build: { ... } ?
const bm = /(^|[^\w$.])build\s*:\s*\{/m.exec(src);

if (bm) {
  const braceIdx = bm.index + bm[0].length - 1;
  const endIdx = findMatchingBrace(src, braceIdx);

  if (endIdx > braceIdx) {
    const inner = src.slice(braceIdx + 1, endIdx);
    const tm = /(^|[^\w$.])target\s*:/.exec(inner);

    if (tm) {
      // Replace the existing target value (scalar OR array) with "esnext".
      const colonAbs = braceIdx + 1 + tm.index + tm[0].length - 1;
      const valStart = colonAbs + 1;
      const valEnd = parseValue(src, valStart);
      const cur = src.slice(valStart, valEnd).trim();
      if (cur === '"esnext"' || cur === "'esnext'" || cur === "`esnext`") {
        // already esnext (shouldn't reach here due to top guard, but safe)
      } else {
        src = src.slice(0, valStart) + ' "esnext"' + src.slice(valEnd);
        changed = true;
        console.log("PATCHED: replaced existing build.target value with esnext.");
      }
    } else {
      // build block exists but has no target -> insert one.
      src = src.slice(0, braceIdx + 1) + ' target: "esnext",' + src.slice(braceIdx + 1);
      changed = true;
      console.log("PATCHED: inserted target into existing build block.");
    }
  } else {
    console.log("WARN: build: { found but brace match failed; falling back to insert.");
  }
}

// 2) No usable build block -> add a fresh one right after defineConfig({
if (!changed) {
  const dc = src.indexOf("defineConfig(");
  if (dc < 0) { console.log("SKIP: defineConfig( anchor not found."); process.exit(0); }
  const ob = src.indexOf("{", dc);
  if (ob < 0) { console.log("SKIP: no opening brace after defineConfig(."); process.exit(0); }
  src = src.slice(0, ob + 1) + '\n  build: { target: "esnext" },' + src.slice(ob + 1);
  changed = true;
  console.log("PATCHED: added new build: { target: \"esnext\" } block.");
}

if (!changed) { console.log("NO CHANGE."); process.exit(0); }

await fs.copyFile(full, full + ".bak-" + stamp);
await fs.writeFile(full, src, "utf8");
console.log("WROTE: " + rel);