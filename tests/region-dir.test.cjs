// Region profile direction + locale-aware formatting through the region
// service (issues #140, #141).
//
// #141 proposed driving direction from RegionService.dir. Direction stays
// owned by the i18n service, but the region service now exposes it as a
// derived field on the resolved profile, so panels that read the region
// profile get the right direction without a second lookup. Formatting in
// format.ts likewise takes its Intl locale from the active region profile.
// Compiled with the TypeScript compiler API in transpile-only mode (see
// tests/icu-catalog.test.cjs for why: no full node_modules needed).
const { transpileModule, ModuleKind, ScriptTarget } = require("typescript");
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");

const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "region-dir-"));
const compile = (rel) => {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  const { outputText } = transpileModule(src, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
    fileName: rel,
  });
  const dest = path.join(out, path.basename(rel, ".ts") + ".js");
  fs.writeFileSync(dest, outputText);
  return dest;
};
compile("src/core/context.ts");
compile("src/core/diagnostics.ts");
compile("src/core/icu-lite.ts");
compile("src/core/i18n.ts");
compile("src/core/region.ts");
compile("src/core/format.ts");

global.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { region } = require(path.join(out, "region.js"));
const R = require(path.join(out, "region.js"));
const F = require(path.join(out, "format.js"));

let n = 0;
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ---- direction is derived from the resolved profile's locale
region.boot();
eq(region.getResolved().dir, "ltr", "intl profile is LTR");
for (const [profile, dir] of [["ae", "rtl"], ["sa", "rtl"], ["eg", "rtl"], ["us", "ltr"], ["de", "ltr"], ["fr", "ltr"]]) {
  assert.ok(region.setProfile(profile), `setProfile(${profile})`);
  eq(region.getResolved().dir, dir, `${profile} resolves dir=${dir}`);
}
// An untranslated RTL locale resolves LTR even via an explicit override:
// the region profile cannot flip the layout into an untranslated RTL shell.
region.setOverride({ locale: "he" });
eq(region.getResolved().locale, "he", "override locale he");
eq(region.getResolved().dir, "ltr", "he override stays LTR (untranslated)");
region.setOverride({ locale: "ar" });
eq(region.getResolved().dir, "rtl", "ar override is RTL");
region.clearOverrides();

// ---- numbers/dates follow the active region profile, not the browser
// Consolidation (issue #140, 2026-11-21): region.ts is canonical for
// fmtNumber/fmtDate/fmtTime/fmtDateTime/fmtCurrency. format.ts no longer
// exports those names — the same assertions now run against R, with
// identical expected values (no weakened assertions).
for (const name of ["fmtNumber", "fmtCurrency", "fmtDate", "fmtTime", "fmtDateTime"]) {
  assert.ok(!(name in F), `format.ts must not export the duplicate ${name} (region.ts is canonical)`);
  n++;
}
assert.ok(region.setProfile("de"));
eq(R.fmtNumber(1234567.891, { maximumFractionDigits: 2 }), "1.234.567,89", "de-DE number via region profile");
eq(F.fmtInteger(1234567), "1.234.567", "de-DE integer via region profile");
assert.ok(region.setProfile("ae"));
assert.ok(/٣|3/.test(R.fmtNumber(123)), "ar number renders: " + R.fmtNumber(123));
eq(F.getCurrency(), "AED", "ae profile currency default is AED (region locale)");
assert.ok(region.setProfile("us"));
eq(R.fmtNumber(1234567.891, { maximumFractionDigits: 2 }), "1,234,567.89", "en-US number via region profile");
eq(F.fmtPercent(0.123, 1), "12.3%", "en-US percent via format.ts delegating to region.ts");
eq(F.fmtBytes(1536, 1), "1.5 KB", "file size via format.ts delegating to region.ts");
const d = new Date(Date.UTC(2026, 10, 9, 14, 5, 7));
assert.ok(region.setProfile("de"));
assert.ok(/^0?9\.11\.(20)?26/.test(R.fmtDate(d)), "de-DE date order: " + R.fmtDate(d));

console.log(`region-dir: ${n} assertions passed`);
