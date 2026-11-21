// Options language dropdown must not advertise what does not translate
// (issue #140/#141; hardening item 14). Untranslated locales (fa, he, it,
// ko, nl, pl, tr, ur, zh-TW) are NOT offered — listing one advertised a
// language the UI does not speak, worst case he/fa/ur: an RTL flip around
// an English UI. Every remaining non-English locale is still partial, so
// its label says "(partial translation)" instead of implying a complete
// translation.
//
// The boot chain is compiled with the TypeScript compiler API in
// transpile-only mode (same pattern as tests/icu-catalog.test.cjs), into
// a throwaway dir under tests/ whose `locales` symlink points at
// src/locales, so locale-boot.ts's relative JSON imports resolve. The
// dir is removed afterwards, pass or fail.
const { transpileModule, ModuleKind, ScriptTarget } = require("typescript");
const fs = require("fs"), path = require("path"), assert = require("assert");

const root = path.join(__dirname, "..");
const tmp = path.join(__dirname, ".tmp-i18n-dropdown");
const core = path.join(tmp, "core");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

try {
  fs.mkdirSync(core, { recursive: true });
  fs.symlinkSync(path.join(root, "src", "locales"), path.join(tmp, "locales"), "dir");
  // The repo is "type": "module", so .js files here would load as ESM;
  // the compiled output is CommonJS (transpile-only, like icu-catalog).
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "commonjs" }));

  const compile = (rel) => {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    const { outputText } = transpileModule(src, {
      // esModuleInterop: locale-boot.ts default-imports the JSON locale
      // files; without it the compiled require reads `.default` off the
      // plain JSON object and every catalogue registers as undefined.
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020, esModuleInterop: true },
      fileName: rel,
    });
    const dest = path.join(core, path.basename(rel, ".ts") + ".js");
    fs.writeFileSync(dest, outputText);
    return dest;
  };
  // Order matters: context/diag first so the relative requires resolve.
  compile("src/core/context.ts");
  compile("src/core/diagnostics.ts");
  compile("src/core/icu-lite.ts");
  compile("src/core/i18n.ts");
  compile("src/core/units.ts");
  compile("src/core/region.ts");
  compile("src/core/services.ts");
  compile("src/core/options-registry.ts");
  compile("src/core/locale-boot.ts");

  global.localStorage = {
    _s: {},
    getItem(k) { return this._s[k] ?? null; },
    setItem(k, v) { this._s[k] = String(v); },
    removeItem(k) { delete this._s[k]; },
  };
  global.navigator = { languages: ["en"], language: "en" };
  global.document = { documentElement: { style: { setProperty() {} } } };
  global.CustomEvent = class CustomEvent {
    constructor(type, opts) { this.type = type; this.detail = opts?.detail; }
  };
  global.window = { dispatchEvent() {} };

  const { setupLocale } = require(path.join(core, "locale-boot.js"));
  const { listOptions } = require(path.join(core, "options-registry.js"));

  setupLocale();

  const option = listOptions("Language & Region").find((o) => o.id === "locale.language");
  ok(option, "locale.language option is registered");
  ok(option.type === "select", "locale.language is a select");
  const choices = option.choices;
  const values = choices.map((c) => c.value);

  // Exactly the 10 translated locales — nothing else is offered.
  ok(values.length === 10, `dropdown offers exactly 10 locales, got ${values.length}: ${values.join(", ")}`);
  for (const loc of ["en", "ar", "de", "es", "fr", "hi", "ja", "pt-BR", "ru", "zh-CN"]) {
    ok(values.includes(loc), `${loc} is offered`);
  }
  for (const loc of ["fa", "he", "it", "ko", "nl", "pl", "tr", "ur", "zh-TW"]) {
    ok(!values.includes(loc), `${loc} is NOT offered (untranslated)`);
  }

  // Partial-translation indicator: every offered locale except English —
  // the source language — is labelled partial; English carries no marker.
  for (const c of choices) {
    if (c.value === "en") {
      ok(!/partial|untranslated/i.test(c.label), `en label carries no translation marker: ${c.label}`);
    } else {
      ok(c.label.includes("(partial translation)"), `${c.value} label marks partial translation: ${c.label}`);
    }
  }
  ok(option.default === "en", `default locale is en, got ${option.default}`);

  console.log(`i18n-dropdown: ${n} assertions passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
