// RTL readiness of the core stylesheets (issue #141): direction-sensitive properties use logical values, so the same CSS
// mirrors under <html dir="rtl"> and renders identically under ltr. Static check only: no browser was used.
// Extended 2026-11-20 (#141): the original test covered only the two core stylesheets, while the real styling lives in
// inline STYLE/cssText literals in src/**/*.ts (73 physical-direction lines at the time). The TS scan below closes that
// gap — the count is now zero, and any new physical property fails the test.
const fs = require("fs"), path = require("path"), assert = require("assert");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const PHYSICAL = /(?<![\w-])(margin|padding|border)-(left|right)\b|border-(left|right)-color|text-align:\s*(left|right)\b|float:\s*(left|right)\b|\.(margin|padding|border)(Left|Right)([A-Z]\w*)?\b|\.cssFloat\b/;
// Item 16: the camelCase alternatives above close the hole the first version
// of this gate had — .style.marginLeft / .borderRight / .borderLeft in
// system-browser.ts, plan-view-panel.ts and ribbon.ts:3542 escaped the
// kebab-case scan (they are real direction properties, now logical).
// Deliberately NOT gated: `style.left`/`style.right` pixel assignments
// (drag/canvas screen coordinates, not layout) and two reviewed `textAlign`
// cases — cad-viewer.ts:2194 sets a CanvasRenderingContext2D textAlign for
// CAD drawing text (entity alignment, not UI chrome) and
// schedules-panel.ts:645 right-aligns numeric total cells (a data
// convention that holds in RTL: numbers stay right-aligned).
for (const f of ["src/style.css", "src/styles.css"]) {
  const css = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const bad = css.split("\n").map((l, i) => [l, i + 1]).filter(([l]) => PHYSICAL.test(l));
  ok(bad.length === 0, `${f} still has physical-direction properties: ` + bad.map(([l, i]) => `${i}: ${l.trim()}`).join(" | "));
  // left/right offsets are allowed only when symmetric (left:50% centring with translateX(-50%), or left:0 + right:0 spanning)
  const offs = css.split("\n").map((l, i) => [l.trim(), i + 1]).filter(([l]) => /(^|[\s;{])(left|right)\s*:/.test(l) && !/left:\s*50%|left:\s*0\b|right:\s*0\b|left:\s*var\(--sp-2\)|right:\s*var\(--sp-2\)|left:\s*-32%/.test(l));
  ok(offs.length === 0, `${f}: asymmetric left/right offsets: ` + offs.map(([l, i]) => `${i}: ${l}`).join(" | "));
}
const i18n = fs.readFileSync(path.join(__dirname, "../src/core/i18n.ts"), "utf8");
ok(/documentElement\.dir\s*=\s*dir/.test(i18n), "document direction follows the locale");
ok(/data-dir/.test(i18n), "body carries data-dir for CSS hooks");
// Untranslated RTL locales must not flip: he/fa/ur stay LTR until translated.
ok(/if \(!isTranslatedLocale\(locale\)\) return "ltr"/.test(i18n), "untranslated locales are held LTR (getDirectionFor gate)");

// ---- inline styles in src/**/*.ts: no physical-direction properties ----
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const tsFiles = walk(path.join(__dirname, "..", "src")).filter((f) => f.endsWith(".ts"));
const offenders = [];
for (const f of tsFiles) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((l, i) => { if (PHYSICAL.test(l)) offenders.push(`${path.relative(path.join(__dirname, ".."), f)}:${i + 1}: ${l.trim()}`); });
}
ok(offenders.length === 0, `physical-direction properties in TS inline styles (${offenders.length}):\n` + offenders.slice(0, 10).join("\n"));

// Item 16: the three camelCase leftovers now use logical properties.
const sysBrowser = fs.readFileSync(path.join(__dirname, "../src/features/system-browser.ts"), "utf8");
ok(/mrow\.style\.marginInlineStart = "18px"/.test(sysBrowser), "system browser child-row indent is margin-inline-start");
const planPanel = fs.readFileSync(path.join(__dirname, "../src/features/plan-view-panel.ts"), "utf8");
ok(/lastG\.style\.borderInlineEnd = "none"/.test(planPanel), "plan header last group clears border-inline-end (the separator is logical)");
const ribbon = fs.readFileSync(path.join(__dirname, "../src/shell/ribbon.ts"), "utf8");
ok(/borderInlineEnd = "1px solid var\(--border-default\)"/.test(ribbon) && /borderInlineStart = "1px solid var\(--border-default\)"/.test(ribbon), "left-host dock divider uses logical borders on both dock sides");

// ---- the named views from #141 are covered by the scan above; assert each explicitly ----
for (const f of [
  "src/features/cad-viewer.ts",      // modeling viewport + ribbon
  "src/shell/ribbon.ts",             // tool ribbon
  "src/features/property-palette.ts",// properties
  "src/features/schedules-panel.ts", // schedules
  "src/features/clash-report.ts",    // tables
  "src/modules/sheets/sheet-register.ts",
  "src/features/project-browser.ts", // tree (chevron mirrors via CSS, below)
]) {
  const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  ok(!PHYSICAL.test(src), `${f} has no physical-direction properties`);
}

// ---- intentional icon mirroring (#141: "icons flipped intentionally") ----
// The CAD ribbon reuses the undo SVG for redo via .cadrb--flip in LTR; under
// dir=rtl the pair swaps (undo points right, redo points left), and the same
// applies to the Quick Access undo/redo. The project-browser expand chevron
// "▶" mirrors to "◀" via scaleX (▼ is symmetric under scaleX).
const cad = fs.readFileSync(path.join(__dirname, "../src/features/cad-viewer.ts"), "utf8");
ok(/html\[dir="rtl"\][\s\S]*?\.cadrb\[data-a="undo"\][\s\S]*?transform:scaleX\(-1\)/.test(cad), "CAD ribbon: undo icon flips under RTL");
ok(/html\[dir="rtl"\][\s\S]*?\.cadrb\[data-a="redo"\][\s\S]*?transform:none/.test(cad), "CAD ribbon: redo icon unflips under RTL");
ok(/html\[dir="rtl"\][\s\S]*?\[data-qat="undo"\] svg\{transform:scaleX\(-1\)/.test(cad), "Quick Access: undo icon flips under RTL");
ok(/html\[dir="rtl"\][\s\S]*?\[data-qat="redo"\] \.qat-flip\{transform:none/.test(cad), "Quick Access: redo icon unflips under RTL");
const pb = fs.readFileSync(path.join(__dirname, "../src/features/project-browser.ts"), "utf8");
ok(/html\[dir="rtl"\] \.obs-project-browser \.pb-chev \{[^}]*transform:scaleX\(-1\)/.test(pb), "project browser chevron mirrors under RTL");
const langBtn = fs.readFileSync(path.join(__dirname, "../src/features/language-button.ts"), "utf8");
ok(/html\[dir="rtl"\]/.test(langBtn), "language switcher keeps its RTL placement rule");
console.log(`rtl-css: ${n} assertions passed`);
