/**
 * tests/no-cdn-imports.test.cjs
 *
 * Drift guard: the app must never ship a runtime ESM import from an
 * external CDN. A runtime `import ... from "https://cdn..."` makes the
 * whole boot depend on third-party reachability — in networks that block
 * CDNs (corporate filters, some regional ISPs) the module graph rejects
 * and the app renders a permanent blank screen. Everything must load from
 * the same origin.
 *
 * Run: `node tests/no-cdn-imports.test.cjs`
 */

const fs = require("node:fs");
const path = require("node:path");

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
    fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const root = path.resolve(__dirname, "..");

// Patterns that constitute a runtime ESM import from an external origin.
const importRe = /\bimport\s+(?:[\w*{},\s]+from\s*)?["'](https?:)?\/\/[^"']+["']/;

function walk(dir, exts, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(p);
  }
  return out;
}

t("src/ has no runtime CDN imports", () => {
  const files = walk(path.join(root, "src"), [".ts", ".tsx", ".js", ".mjs"], []);
  const offenders = files.filter((f) => {
    const s = fs.readFileSync(f, "utf8");
    return importRe.test(s);
  });
  assert(offenders.length === 0, `CDN imports found in:\n  ${offenders.join("\n  ")}`);
});

t("public/ scripts have no runtime CDN imports", () => {
  const pub = path.join(root, "public");
  if (!fs.existsSync(pub)) return;
  const files = walk(pub, [".js", ".mjs", ".html"], []);
  const offenders = files.filter((f) => importRe.test(fs.readFileSync(f, "utf8")));
  assert(offenders.length === 0, `CDN imports found in:\n  ${offenders.join("\n  ")}`);
});

t("index.html has no runtime CDN imports", () => {
  const f = path.join(root, "index.html");
  if (!fs.existsSync(f)) return;
  assert(!importRe.test(fs.readFileSync(f, "utf8")), "index.html imports from an external origin");
});

t("dist/ build (when present) has no runtime CDN imports", () => {
  const dist = path.join(root, "dist");
  if (!fs.existsSync(dist)) return; // dist exists only after a local build
  const files = walk(dist, [".js", ".mjs", ".html"], []);
  const offenders = files.filter((f) => importRe.test(fs.readFileSync(f, "utf8")));
  assert(offenders.length === 0, `CDN imports shipped in the build:\n  ${offenders.join("\n  ")}`);
});

// ── Registration check (drift guard) ───────────────────────────────────────
t("CI registration: test listed in package.json and ci-unit-tests.mjs", () => {
  const pkg = fs.readFileSync(path.join(root, "package.json"), "utf8");
  assert(pkg.includes("test:no-cdn"), "package.json must register test:no-cdn");
  const ci = fs.readFileSync(path.join(root, "scripts/ci-unit-tests.mjs"), "utf8");
  assert(ci.includes("test:no-cdn"), "ci-unit-tests.mjs must register test:no-cdn");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
