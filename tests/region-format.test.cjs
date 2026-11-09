// Region-aware number/date formatting helpers (issue #140): output follows region.getResolved().locale.
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "regfmt-"));
try { execSync(`npx tsc src/core/region.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --moduleResolution node --resolveJsonModule --esModuleInterop`, { stdio: "pipe" }); }
catch (e) { if (!/region\.js/.test(String(fs.existsSync(out) && fs.readdirSync(out, { recursive: true })))) throw e; /* type errors from packages not installed locally still emit JS */ }
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
global.localStorage = global.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };
const R = require(find("region.js"));
let n = 0; const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const setLocale = (loc) => { R.region.getResolved = () => ({ locale: loc, currency: "EUR" }); };
const d = Date.UTC(2026, 10, 9, 14, 5, 7);
setLocale("en-US"); eq(R.fmtNumber(1234567.891, { maximumFractionDigits: 2 }), "1,234,567.89", "en-US number"); eq(R.fmtDate(d).replace(/\D/g, "/").slice(0, 9).includes("2026") || /26/.test(R.fmtDate(d)), true, "en-US date has the year");
setLocale("de-DE"); eq(R.fmtNumber(1234567.891, { maximumFractionDigits: 2 }), "1.234.567,89", "German separators"); eq(/^0?9\.11\.(20)?26/.test(R.fmtDate(d)), true, "German date order: " + R.fmtDate(d));
setLocale("ar-EG"); eq(/[٠-٩]/.test(R.fmtNumber(123)), true, "Arabic-Indic digits for ar-EG: " + R.fmtNumber(123));
setLocale("fr-FR"); eq(R.fmtNumber(1234.5).replace(/\s/g, " ").includes(","), true, "French decimal comma");
setLocale("not a locale!!"); eq(R.fmtNumber(1234.5), new Intl.NumberFormat(undefined).format(1234.5), "invalid locale falls back to default instead of throwing");
eq(R.fmtDateTime("garbage"), "", "invalid date -> empty, not 'Invalid Date'"); eq(R.fmtNumber(NaN), new Intl.NumberFormat(undefined).format(0), "NaN -> 0");
R.region.getResolved = () => { throw new Error("no region yet"); }; eq(typeof R.fmtNumber(5), "string", "works before the region service is ready");
// the hard-coded browser-locale calls the codemod replaced must not come back in the UI layer
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const offenders = [];
for (const f of [...walk(path.join(__dirname, "../src/features")), ...walk(path.join(__dirname, "../src/shell"))].filter((f) => f.endsWith(".ts"))) {
  const t = fs.readFileSync(f, "utf8"); if (/new Date\([^()]*\)\.toLocale(Time)?String\(\)/.test(t) || /(?<![\w.)\]])[A-Za-z_]\w*(?:\??\.[A-Za-z_]\w*)*\.toLocaleString\(\)/.test(t)) offenders.push(path.relative(path.join(__dirname, ".."), f));
}
eq(offenders.join(", "), "", "UI code uses fmtNumber/fmtDateTime, not browser-locale toLocaleString()");
console.log(`region-format: ${n} assertions passed`);
