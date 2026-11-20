// ICU strings in the key catalogues, rendered through the real i18n service
// (issue #140). Before this change the ICU engine existed but ZERO ICU
// strings existed in any catalogue — the engine had no input. This test
// proves the counts.* ICU messages render with real CLDR plural rules for
// every translated locale (plus pl, whose JSON carries the plural data even
// though its UI is not yet translated) and that untranslated RTL locales
// stay LTR.
//
// The service is compiled with the TypeScript compiler API in transpile-only
// mode (no module resolution: context.ts only has `import type` imports),
// which keeps this test independent of the full node_modules install.
const { transpileModule, ModuleKind, ScriptTarget } = require("typescript");
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");

const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "icu-cat-"));
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
// Order matters: context/diag first so the relative requires resolve.
compile("src/core/context.ts");
compile("src/core/diagnostics.ts");
compile("src/core/icu-lite.ts");
compile("src/core/i18n.ts");

global.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { i18n, hasIcuSyntax } = require(path.join(out, "i18n.js"));
void hasIcuSyntax;

let n = 0;
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const LOCALES = ["en", "ar", "de", "es", "fr", "hi", "ja", "pt-BR", "ru", "zh-CN", "pl"];
const catalogs = {};
for (const loc of LOCALES) {
  catalogs[loc] = JSON.parse(fs.readFileSync(path.join(root, "src", "locales", `${loc}.json`), "utf8"));
  i18n.register(loc, catalogs[loc]);
}
// The untranslated stubs must also be registered for the status/dir gates.
for (const loc of ["fa", "he", "it", "ko", "nl", "tr", "ur", "zh-TW"]) {
  i18n.register(loc, JSON.parse(fs.readFileSync(path.join(root, "src", "locales", `${loc}.json`), "utf8")));
}

// ---- the engine finally has input: every counts.* string is ICU syntax
for (const loc of LOCALES) {
  for (const key of ["elements", "selected", "authoredSelected", "clashes"]) {
    const s = catalogs[loc].counts[key];
    assert.ok(typeof s === "string" && /,\s*(plural|select)\b/.test(s), `${loc}.counts.${key} is not an ICU message: ${s}`);
    n++;
  }
}

// ---- counts.elements: exact renderings, all CLDR categories exercised
// Expected values were verified by hand against CLDR plural rules:
// ar 0/1/2/3/11/100 -> zero/one/two/few/many/other; ru/pl 1/2/5/21 -> one/few/many/one;
// fr 0 is singular; pt-BR 0 is singular; ja/zh have no plural distinction.
const ELEMENTS = {
  "en":    ["0 elements", "1 element", "2 elements", "3 elements", "5 elements", "11 elements", "21 elements", "100 elements"],
  "ar":    ["لا عناصر", "عنصر واحد", "عنصران", "3 عناصر", "5 عناصر", "11 عنصرًا", "21 عنصرًا", "100 عنصر"],
  "de":    ["0 Elemente", "1 Element", "2 Elemente", "3 Elemente", "5 Elemente", "11 Elemente", "21 Elemente", "100 Elemente"],
  "es":    ["0 elementos", "1 elemento", "2 elementos", "3 elementos", "5 elementos", "11 elementos", "21 elementos", "100 elementos"],
  "fr":    ["0 élément", "1 élément", "2 éléments", "3 éléments", "5 éléments", "11 éléments", "21 éléments", "100 éléments"],
  "hi":    ["0 तत्व", "1 तत्व", "2 तत्व", "3 तत्व", "5 तत्व", "11 तत्व", "21 तत्व", "100 तत्व"],
  "ja":    ["0 個の要素", "1 個の要素", "2 個の要素", "3 個の要素", "5 個の要素", "11 個の要素", "21 個の要素", "100 個の要素"],
  "pt-BR": ["0 elemento", "1 elemento", "2 elementos", "3 elementos", "5 elementos", "11 elementos", "21 elementos", "100 elementos"],
  "ru":    ["0 элементов", "1 элемент", "2 элемента", "3 элемента", "5 элементов", "11 элементов", "21 элемент", "100 элементов"],
  "zh-CN": ["0 个元素", "1 个元素", "2 个元素", "3 个元素", "5 个元素", "11 个元素", "21 个元素", "100 个元素"],
  "pl":    ["0 elementów", "1 element", "2 elementy", "3 elementy", "5 elementów", "11 elementów", "21 elementów", "100 elementów"],
};
const COUNTS = [0, 1, 2, 3, 5, 11, 21, 100];
for (const loc of LOCALES) {
  i18n.setLocale(loc);
  COUNTS.forEach((c, i) => eq(i18n.t("counts.elements", { n: c }), ELEMENTS[loc][i], `${loc} counts.elements n=${c}`));
}

// ---- counts.clashes: the ICU form of clash.status.found (incl. =0 exact)
const CLASHES = {
  "en": ["No clashes found.", "1 clash found.", "5 clashes found."],
  "ar": ["لم يتم العثور على تعارضات.", "تم العثور على تعارض واحد.", "تم العثور على 5 تعارضات."],
  "de": ["0 Kollisionen gefunden.", "1 Kollision gefunden.", "5 Kollisionen gefunden."],
  "fr": ["0 conflit détecté.", "1 conflit détecté.", "5 conflits détectés."],
  "ru": ["Найдено 0 конфликтов.", "Найден 1 конфликт.", "Найдено 5 конфликтов."],
  "pl": ["Znaleziono 0 kolizji.", "Znaleziono 1 kolizję.", "Znaleziono 5 kolizji."],
};
for (const [loc, [z, o, f]] of Object.entries(CLASHES)) {
  i18n.setLocale(loc);
  eq(i18n.t("counts.clashes", { n: 0 }), z, `${loc} clashes 0`);
  eq(i18n.t("counts.clashes", { n: 1 }), o, `${loc} clashes 1`);
  eq(i18n.t("counts.clashes", { n: 5 }), f, `${loc} clashes 5`);
}

// ---- counts.selected / authoredSelected: word order + paucal forms
const SEL = {
  "ar": { 0: "لم يتم تحديد شيء", 2: "تم تحديد عنصرين", 11: "تم تحديد 11 عنصرًا" },
  "ru": { 0: "выбрано 0 элементов", 1: "выбран 1 элемент", 3: "выбрано 3 элемента" },
  "pl": { 1: "wybrano 1 element", 2: "wybrano 2 elementy", 5: "wybrano 5 elementów" },
  "fr": { 0: "0 sélectionné", 2: "2 sélectionnés" },
};
for (const [loc, cases] of Object.entries(SEL)) {
  i18n.setLocale(loc);
  for (const [c, want] of Object.entries(cases)) {
    eq(i18n.t("counts.selected", { n: Number(c) }), want, `${loc} counts.selected n=${c}`);
  }
}
const AUTH = {
  "ar": { 2: "تم تحديد عنصرين منشأين", 11: "تم تحديد 11 عنصرًا منشأً" },
  "ru": { 1: "1 созданный элемент выбран", 5: "5 созданных элементов выбрано" },
  "en": { 1: "1 authored element selected", 5: "5 authored elements selected" },
};
for (const [loc, cases] of Object.entries(AUTH)) {
  i18n.setLocale(loc);
  for (const [c, want] of Object.entries(cases)) {
    eq(i18n.t("counts.authoredSelected", { n: Number(c) }), want, `${loc} counts.authoredSelected n=${c}`);
  }
}

// ---- translation status + direction gates (issue #141)
// he/fa/ur have meta.dir "rtl" in their catalogues but no translation: the
// service must NOT flip them to RTL (English UI in an RTL shell).
for (const loc of ["he", "fa", "ur"]) {
  eq(i18n.translationStatus(loc), "untranslated", `${loc} is untranslated`);
  eq(i18n.getDirectionFor(loc), "ltr", `${loc} stays LTR until translated`);
}
eq(i18n.translationStatus("ar"), "translated", "ar is translated");
eq(i18n.getDirectionFor("ar"), "rtl", "ar flips to RTL");
eq(i18n.getDirectionFor("en"), "ltr", "en is LTR");
for (const loc of ["it", "ko", "nl", "tr", "zh-TW"]) {
  eq(i18n.translationStatus(loc), "untranslated", `${loc} is untranslated`);
}
const listed = i18n.listLocales();
for (const loc of ["he", "fa", "ur", "it", "ko", "nl", "pl", "tr", "zh-TW"]) {
  eq(listed.find((l) => l.id === loc).translated, false, `${loc} listed as untranslated`);
}
eq(listed.find((l) => l.id === "ar").translated, true, "ar listed as translated");

// ---- standards.title now resolves for the four full locales that lacked it
for (const [loc, want] of [["ar", "المعايير"], ["de", "Normen"], ["ja", "規格"], ["zh-CN", "标准"]]) {
  i18n.setLocale(loc);
  eq(i18n.t("standards.title"), want, `${loc} standards.title`);
}

console.log(`icu-catalog: ${n} assertions passed`);
