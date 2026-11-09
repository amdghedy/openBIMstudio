// ICU MessageFormat subset + CLDR plural categories for en, ar, ru, pl, fr (issue #140).
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "icu-"));
execSync(`npx tsc src/core/icu-lite.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict`, { stdio: "pipe" });
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const { formatIcu, hasIcuSyntax } = require(find("icu-lite.js"));
let n = 0; const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const F = (t, v, loc = "en") => { const pr = new Intl.PluralRules(loc); return formatIcu(t, v, loc, (x) => pr.select(x)); };

// ---- CLDR categories (what the catalogs' one/few/many/other keys rely on)
const cat = (loc, nums) => nums.map((x) => new Intl.PluralRules(loc).select(x));
assert.deepStrictEqual(cat("en", [0, 1, 2, 5]), ["other", "one", "other", "other"]); n++;
assert.deepStrictEqual(cat("fr", [0, 1, 1.5, 2, 1000000]), ["one", "one", "one", "other", "many"]); n++;
assert.deepStrictEqual(cat("ru", [1, 2, 4, 5, 11, 21, 22, 25, 0]), ["one", "few", "few", "many", "many", "one", "few", "many", "many"]); n++;
assert.deepStrictEqual(cat("pl", [1, 2, 4, 5, 12, 22, 25, 0]), ["one", "few", "few", "many", "many", "few", "many", "many"]); n++;
assert.deepStrictEqual(cat("ar", [0, 1, 2, 3, 10, 11, 99, 100]), ["zero", "one", "two", "few", "few", "many", "many", "other"]); n++;

// ---- plural in messages
const clash = "{count, plural, =0{No clashes} one{# clash} other{# clashes}} found";
eq(F(clash, { count: 0 }), "No clashes found", "=0 exact wins over category"); eq(F(clash, { count: 1 }), "1 clash found"); eq(F(clash, { count: 1234 }), "1,234 clashes found", "# is locale formatted");
const ru = "{n, plural, one{# элемент} few{# элемента} many{# элементов} other{# элемента}}";
eq(F(ru, { n: 1 }, "ru"), "1 элемент"); eq(F(ru, { n: 3 }, "ru"), "3 элемента"); eq(F(ru, { n: 5 }, "ru"), "5 элементов"); eq(F(ru, { n: 21 }, "ru"), "21 элемент"); eq(F(ru, { n: 11 }, "ru"), "11 элементов");
const pl = "{n, plural, one{# ściana} few{# ściany} many{# ścian} other{# ściany}}";
eq(F(pl, { n: 1 }, "pl"), "1 ściana"); eq(F(pl, { n: 3 }, "pl"), "3 ściany"); eq(F(pl, { n: 12 }, "pl"), "12 ścian"); eq(F(pl, { n: 22 }, "pl"), "22 ściany");
const fr = "{n, plural, one{# mur} other{# murs}}";
eq(F(fr, { n: 0 }, "fr"), "0 mur", "French: 0 is singular"); eq(F(fr, { n: 1 }, "fr"), "1 mur"); eq(F(fr, { n: 2 }, "fr"), "2 murs");
const ar = "{n, plural, zero{لا جدران} one{جدار واحد} two{جداران} few{# جدران} many{# جدارًا} other{# جدار}}";
eq(F(ar, { n: 0 }, "ar"), "لا جدران"); eq(F(ar, { n: 2 }, "ar"), "جداران"); ok = F(ar, { n: 3 }, "ar"); assert.ok(/جدران$/.test(ok)); n++; assert.ok(/جدارًا$/.test(F(ar, { n: 11 }, "ar"))); n++;

// ---- select, number, date, nesting, quoting, plain
eq(F("{g, select, f{She} m{He} other{They}} opened it", { g: "f" }), "She opened it"); eq(F("{g, select, f{She} other{They}} opened it", { g: "x" }), "They opened it");
eq(F("{x, number}", { x: 1234567.5 }, "de"), "1.234.567,5", "German number format"); eq(F("{x, number}", { x: 1234567.5 }, "en"), "1,234,567.5");
eq(F("{d, date}", { d: Date.UTC(2026, 10, 9, 12) }, "en"), "11/9/2026"); eq(F("{d, date}", { d: Date.UTC(2026, 10, 9, 12) }, "de"), "9.11.2026");
eq(F("{who, select, a{{n, plural, one{# file} other{# files}} by A} other{other}}", { who: "a", n: 2 }), "2 files by A", "nested plural in select");
eq(F("Use '{'braces'}' and it''s fine", {}), "Use {braces} and it's fine", "apostrophe quoting"); eq(F("a # b", { n: 1 }), "a # b", "# outside plural is literal");
eq(F("Hello {name}", { name: "Sam" }), "Hello Sam"); eq(F("Hello {missing}", {}), "Hello {missing}", "unknown variable left visible");
// malformed input never throws and never loops: returned as written
for (const bad of ["{n, plural, one{x}", "{n, plural, one{x}}", "{n, plural,}", "{n, selectordinal, one{x} other{y}}", "{", "}}{", "{n, plural, one x other{y}}"]) eq(F(bad, { n: 5 }), bad, "malformed returned as-is: " + bad);
eq(F("{a, select, x{".repeat(20) + "z" + "}".repeat(20), { a: "x" }).length > 0, true, "deep nesting is bounded, not a crash");
eq(hasIcuSyntax("{count} clashes"), false, "plain {x} strings keep the legacy path"); eq(hasIcuSyntax("{n, plural, other{#}}"), true);
// the catalog files that already use plain forms still parse as JSON with plural objects
const en = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/locales/en.json"), "utf8"));
assert.ok(JSON.stringify(en).includes('"other"')); n++;
console.log(`icu-lite: ${n} assertions passed`);
