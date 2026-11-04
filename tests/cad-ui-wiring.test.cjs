// AutoCAD-grade CAD reading, wired into the UI/UX — source drift-guard test.
//
// The engine reads the file's tables (LAYER / LTYPE / STYLE / DIMSTYLE) and
// entities the way AutoCAD does (commit 73d381c). This suite guards the
// UI/UX wiring that surfaces everything that was read:
//
//   1. Drawing Database Status (Info) reports the whole database:
//      linetype table, LTSCALE, STYLE table (style -> font), fonts in the
//      drawing, DIMSTYLE table and entities that were not drawn.
//   2. The properties panel shows per-entity true-colour hex, linetype
//      scale, transparency, and for TEXT: style name + font.
//   3. The Text Style Manager offers every file style with a "Set current"
//      adoption action (fileStyleToTextStyle), and the style editor's font
//      dropdown merges the file's own fonts (fontOptionsFor).
//
// Marker-based on the real sources, plus a logic check of
// fileStyleToTextStyle and fontOptionsFor compiled straight from cad-style-ui.ts.
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const { execSync } = require("child_process");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "src", ...p), "utf8");
const viewer = read("features", "cad-viewer.ts");
const styleUi = read("features", "cad-style-ui.ts");

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

// ── 1. Drawing Database Status reports everything the reader pulled out ──
t("info dialog: full database status markers", () => {
  const mustContain = [
    "AutoCAD Drawing Database Status",
    "Linetype Table:",
    "LTSCALE:",
    "Text Style Table:",
    "Fonts in Drawing:",
    "Dimension Style Table:",
    "Entities Not Drawn:",
  ];
  for (const m of mustContain) assert.ok(viewer.includes(m), `cad-viewer.ts drift: missing "${m}"`);
  // The report is driven by the real document tables, not hardcoded strings
  assert.ok(viewer.includes("Object.keys(doc.linetypes ?? {})"), "linetype table not read");
  assert.ok(viewer.includes("Object.entries(doc.textStyles ?? {})"), "STYLE table not read");
  assert.ok(viewer.includes("doc.dimStyles ?? []"), "DIMSTYLE table not read");
  assert.ok(viewer.includes("doc.skipped ?? {}"), "skipped-entity summary not read");
});

// ── 2. Properties panel: per-entity read data is visible ──
t("properties panel: true-colour hex, ltScale, transparency, text style + font", () => {
  assert.ok(viewer.includes("padStart(6, \"0\").toUpperCase()}, true colour)"), "true-colour hex missing");
  assert.ok(viewer.includes('if (e.ltScale != null && e.ltScale !== 1) rows.push(row("Linetype scale"'), "per-entity lt-scale row missing");
  assert.ok(viewer.includes('if (e.transparency) rows.push(row("Transparency"'), "transparency row missing");
  assert.ok(viewer.includes('row("Text style", styleName)'), "TEXT style row missing");
  assert.ok(viewer.includes("const fontName = e.font ?? fileStyle?.font;"), "TEXT font lookup (entity font, then STYLE table) missing");
});

// ── 3. Text Style Manager: file fonts in the editor, file styles adoptable ──
t("text style manager: fontOptionsFor merges file fonts", () => {
  assert.ok(styleUi.includes("function fontOptionsFor(api: CadStyleApi | null)"), "fontOptionsFor missing");
  assert.ok(styleUi.includes('st.font) fileFonts.add(st.font)'), "STYLE-table fonts not collected");
  assert.ok(styleUi.includes('e.type === "TEXT" && e.font) fileFonts.add(e.font)'), "entity fonts not collected");
  assert.ok(styleUi.includes('"${f} (from file)"') || styleUi.includes("` (from file)`".replace("` (from file)`", "${f} (from file)")), "file fonts not labelled");
  // The editor must use the merged list, not the hardcoded CAD_FONTS only
  assert.ok(styleUi.includes("const fontOptions: Array<[string, string]> = fontOptionsFor(api);"), "style editor does not use fontOptionsFor");
});

t("text style manager: file styles adoptable via Set current", () => {
  assert.ok(styleUi.includes("export function fileStyleToTextStyle("), "fileStyleToTextStyle missing");
  assert.ok(styleUi.includes('const use = el("button", BTN + ";font-size:10px;padding:1px 7px;flex:none", "Set current")'), "Set current button on file styles missing");
  assert.ok(styleUi.includes("setCurrentTextStyle(ts);"), "adoption does not set current");
  assert.ok(styleUi.includes("writeJson(STYLE_KEY, [...rest, ts]);"), "adoption does not persist the style");
  // Fixed-height styles: height 0 in the table means per-entity height -> editable default
  assert.ok(styleUi.includes("height: s.height && s.height > 0 ? s.height : 2.5"), "zero-height fallback missing");
});

// ── 4. Runtime: compile the two helpers and verify their behaviour ──
t("runtime: fileStyleToTextStyle + fontOptionsFor behaviour", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cad-uiw-"));
  // Stub the DOM-touching imports so the module compiles standalone.
  const stubDir = path.join(out, "stub");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, "form-modal.ts"), "export function openFormModal(_: unknown): Promise<null> { return Promise.resolve(null); }\n");
  execSync(
    `npx tsc src/features/cad-style-ui.ts --outDir ${out}/js --module commonjs --target es2020 --skipLibCheck --esModuleInterop` +
    ` --moduleResolution node`,
    { cwd: path.join(__dirname, ".."), stdio: "ignore" },
  );
  const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
  const mod = require(find(path.join(out, "js"), "cad-style-ui.js"));
  const st = mod.fileStyleToTextStyle("FIXED", { font: "simplex.shx", height: 3.5, width: 0.8, oblique: 15, bigFont: "bigfont.shx" });
  assert.strictEqual(st.name, "FIXED");
  assert.strictEqual(st.font, "simplex.shx");
  assert.strictEqual(st.height, 3.5);
  assert.strictEqual(st.widthFactor, 0.8);
  assert.strictEqual(st.oblique, 15);
  // Zero height (AutoCAD "fixed height 0" = height set per entity) falls back to an editable default
  const zero = mod.fileStyleToTextStyle("STANDARD", { font: "txt.shx", height: 0 });
  assert.strictEqual(zero.height, 2.5);
  // Font options include the file fonts, labelled, after the built-ins
  const api = {
    doc: () => ({ textStyles: { FIXED: { font: "custom-stroke.shx" } } }),
    entities: () => [{ type: "TEXT", font: "Gotham" }],
  };
  const opts = mod.fontOptionsFor(api);
  assert.ok(opts.some(([v, l]) => v === "custom-stroke.shx" && l === "custom-stroke.shx (from file)"), "STYLE font not offered");
  assert.ok(opts.some(([v, l]) => v === "Gotham" && l === "Gotham (from file)"), "entity font not offered");
  assert.ok(opts.some(([v]) => v === "Arial"), "built-in fonts dropped");
  // Known fonts already in CAD_FONTS are not duplicated
  const dup = mod.fontOptionsFor({ doc: () => ({ textStyles: { A: { font: "romans.shx" } } }), entities: () => [] });
  assert.strictEqual(dup.filter(([v]) => v === "romans.shx").length, 1, "duplicate font entry for known SHX font");
  // Null api (no drawing open) still yields the built-in list
  assert.ok(mod.fontOptionsFor(null).some(([v]) => v === "Arial"), "built-in list unavailable without a drawing");
  fs.rmSync(out, { recursive: true, force: true });
});

console.log(`\ncad-ui-wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
