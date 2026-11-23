/**
 * tests/offline-icons.test.cjs
 *
 * Drift gate for the offline icon loader: every `mdi:<name>` referenced in
 * the app source (and the vendor UI dists) must exist in the local
 * collection registered at boot, so the iconify runtime never attempts the
 * CSP-blocked CDN fetches (api.iconify.design / unisvg / simplesvg) that
 * used to fire per icon (see src/features/iconify-offline.ts and
 * scripts/gen-mdi-offline.py).
 *
 * Run: `node tests/offline-icons.test.cjs`
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; } }

const root = path.join(__dirname, "..");
const iconsPath = path.join(root, "src", "features", "mdi-offline-icons.json");
const collection = JSON.parse(fs.readFileSync(iconsPath, "utf8"));

t("offline mdi collection exists and is a valid Iconify collection", () => {
  assert.strictEqual(collection.prefix, "mdi");
  assert.ok(collection.icons && Object.keys(collection.icons).length >= 14, "collection too small");
  for (const [name, icon] of Object.entries(collection.icons)) {
    assert.ok(icon && typeof icon.body === "string" && icon.body.length > 10, `icon ${name} has no usable body`);
  }
});

function collectMdiNames(dir, exts, into) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMdiNames(full, exts, into);
    else if (exts.some((e) => entry.name.endsWith(e))) {
      const text = fs.readFileSync(full, "utf8");
      for (const m of text.matchAll(/mdi:([a-z0-9\-]+)/g)) into.add(m[1]);
    }
  }
}

t("every referenced mdi icon is in the offline collection", () => {
  const referenced = new Set();
  collectMdiNames(path.join(root, "src"), [".ts", ".html"], referenced);
  collectMdiNames(path.join(root, "public", "js"), [".js"], referenced);
  for (const vendor of ["@thatopen/ui", "@thatopen/ui-obc", "@thatopen/components-front"]) {
    const p = path.join(root, "node_modules", vendor, "dist", "index.js");
    if (fs.existsSync(p)) {
      for (const m of fs.readFileSync(p, "utf8").matchAll(/mdi:([a-z0-9\-]+)/g)) referenced.add(m[1]);
    }
  }
  assert.ok(referenced.size > 0, "no mdi references found — generator patterns stale?");
  const missing = [...referenced].filter((n) => !collection.icons[n]);
  assert.deepStrictEqual(missing, [], `icons referenced but not in the offline collection: ${missing.join(", ")} (run scripts/gen-mdi-offline.py)`);
});

t("main.ts registers the collection before UI mounts", () => {
  const main = fs.readFileSync(path.join(root, "src", "main.ts"), "utf8");
  const firstImport = main.indexOf('import "./core/webgpu-compat";');
  assert.ok(firstImport >= 0, "webgpu-compat import missing");
  const setup = main.indexOf("setupOfflineIcons()");
  assert.ok(setup > firstImport, "setupOfflineIcons() call missing from main.ts");
  assert.ok(main.indexOf('from "./features/iconify-offline"') > -1, "iconify-offline import missing");
  assert.ok(setup < main.indexOf("import { setupViewer }"), "must register before the viewer setup");
});

t("no runtime icon-CDN hosts in source", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const text = fs.readFileSync(full, "utf8");
        if (/api\.iconify\.design|unisvg\.com|simplesvg\.com/.test(text)) offenders.push(path.relative(root, full));
      }
    }
  };
  walk(path.join(root, "src"));
  assert.deepStrictEqual(offenders, [], `runtime icon-CDN references in src: ${offenders.join(", ")}`);
});

console.log(`=== offline-icons tests complete: ${passed} passed, ${process.exitCode ? 1 : 0} failed ===`);
if (process.exitCode) process.exit(1);
