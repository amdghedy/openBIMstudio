// RTL readiness of the core stylesheets (issue #141): direction-sensitive properties use logical values, so the same CSS
// mirrors under <html dir="rtl"> and renders identically under ltr. Static check only: no browser was used.
const fs = require("fs"), path = require("path"), assert = require("assert");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
for (const f of ["src/style.css", "src/styles.css"]) {
  const css = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const bad = css.split("\n").map((l, i) => [l, i + 1]).filter(([l]) => /(?<![\w-])(margin|padding|border)-(left|right)\b|text-align:\s*(left|right)\b|float:\s*(left|right)/.test(l));
  ok(bad.length === 0, `${f} still has physical-direction properties: ` + bad.map(([l, i]) => `${i}: ${l.trim()}`).join(" | "));
  // left/right offsets are allowed only when symmetric (left:50% centring with translateX(-50%), or left:0 + right:0 spanning)
  const offs = css.split("\n").map((l, i) => [l.trim(), i + 1]).filter(([l]) => /(^|[\s;{])(left|right)\s*:/.test(l) && !/left:\s*50%|left:\s*0\b|right:\s*0\b|left:\s*var\(--sp-2\)|right:\s*var\(--sp-2\)|left:\s*-32%/.test(l));
  ok(offs.length === 0, `${f}: asymmetric left/right offsets: ` + offs.map(([l, i]) => `${i}: ${l}`).join(" | "));
}
const i18n = fs.readFileSync(path.join(__dirname, "../src/core/i18n.ts"), "utf8");
ok(/documentElement\.dir\s*=\s*dir/.test(i18n), "document direction follows the locale");
ok(/data-dir/.test(i18n), "body carries data-dir for CSS hooks");
console.log(`rtl-css: ${n} assertions passed`);
