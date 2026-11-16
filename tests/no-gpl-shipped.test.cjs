/* Commercial-licence guard: nothing GPL/AGPL may be a shipped (non-dev) dependency or be copied into public/. */
const fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const copyleft = (lic) => typeof lic === "string" && /(^|[^L])GPL|AGPL|SSPL/i.test(lic) && !/^\(?(MIT|Apache|BSD|ISC)/.test(lic);

t("no GPL/AGPL licence among production (non-dev) lock entries", () => {
  const bad = Object.entries(lock.packages).filter(([k, v]) => k && !v.dev && copyleft(v.license)).map(([k, v]) => `${k} (${v.license})`);
  assert.deepStrictEqual(bad, [], "shipped copyleft packages: " + bad.join(", "));
});
t("libredwg (GPL-3.0) is a devDependency only", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(!pkg.dependencies["@mlightcad/libredwg-web"], "must not be in dependencies");
});
t("the reader is only ever loaded through the optional plug-in loader (no bare static import, no bundled copy)", () => {
  const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else if (/\.(ts|tsx)$/.test(e.name)) o.push(p); } return o; };
  for (const f of walk(path.join(root, "src"))) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/from\s+["']@mlightcad\/libredwg-web/.test(src), f + " statically imports the GPL reader");
    assert.ok(!/import\(\s*["']@mlightcad\/libredwg-web/.test(src), f + " dynamically imports the GPL reader by a bundled specifier");
  }
});
t("the copy script does nothing unless a developer opts in", () => {
  const s = fs.readFileSync(path.join(root, "scripts", "copy-libredwg-wasm.mjs"), "utf8");
  assert.ok(s.includes('OBS_BUNDLE_LIBREDWG !== "1"') && s.indexOf("process.exit(0)") < s.indexOf("copyFileSync") || !s.includes("copyFileSync"), "must exit before copying");
});
console.log(`no-gpl-shipped: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
