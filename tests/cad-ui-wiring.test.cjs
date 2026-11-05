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

// ── 4. In-canvas command entry is wired to the existing CAD command parser ──
t("viewport keyboard opens a cursor-positioned command prompt and reuses command execution", () => {
  const mustContain = [
    'ev.target !== cv',
    'openDynamicCommand(ev.key)',
    'position:absolute;z-index:15',
    'dynCommandInput.addEventListener("keydown"',
    'executeAutoCadCommand(value)',
    'closeDynamicCommand();',
    'CAD_COMMANDS.filter((item)',
    'dynCommandInput.addEventListener("input"',
  ];
  for (const marker of mustContain) assert.ok(viewer.includes(marker), `in-canvas command entry missing "${marker}"`);
  assert.ok(viewer.includes('dynCommandInput.placeholder = "Enter command…";'), "dynamic prompt placeholder missing");
  assert.ok(viewer.includes('dynCommandInput.setSelectionRange(initialText.length, initialText.length);'), "initial typed character is not retained");
});

// ── 5. AutoCAD command activation: Space executes exact commands and aliases ──
t("command entry: Space executes exact commands in both command inputs without eating argument spaces", () => {
  assert.ok(viewer.includes("function isExactCadCommandToken(rawInput: string): boolean"), "exact command-token guard missing");
  assert.ok(viewer.includes("const resolved = resolveCadToken(token, CAD_COMMANDS);"), "custom and built-in aliases are not resolved");
  assert.ok(viewer.includes('if (event.key === " " || event.code === "Space")'), "dynamic command input does not handle Space");
  assert.ok(viewer.includes('if (e.key === " " || e.code === "Space")'), "command line does not handle Space");
  assert.ok(viewer.includes("if (isExactCadCommandToken(dynCommandInput.value))"), "dynamic input executes partial commands");
  assert.ok(viewer.includes("if (isExactCadCommandToken(cmdInput.value))"), "command line executes partial commands");
  assert.ok(viewer.includes("if (!token || /\\s/.test(token)) return false;"), "argument-containing input is not protected");
  // Space only prevents its default insertion when a complete command/alias is present.
  assert.ok(viewer.includes("event.preventDefault();\\n            const value = dynCommandInput.value;"), "dynamic Space execution does not preserve ordinary spaces");
  assert.ok(viewer.includes("e.preventDefault();\\n        executeAutoCadCommand(cmdInput.value);"), "command-line Space execution does not preserve ordinary spaces");
});

// ── 5. Runtime: compile the two helpers and verify their behaviour ──
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

// ── 6. Super Copy: Ctrl+C / Ctrl+V across drawings, wired end to end ──
t("super copy: clipboard engine wired into tools, hotkeys, ribbon and commands", () => {
  const mustContain = [
    // Interactive placement tool (ghost follows the cursor, click drops a copy)
    'setTool("paste")',
    'kind: "paste", stage: "second"',
    "case \"paste\": {",
    "PASTECLIP: ${placed.length} object(s) placed",
    // Copy side: dependency snapshot + persistence
    "collectClipDeps(list, doc)",
    "persistClip();",
    "localStorage.setItem(CLIP_STORAGE_KEY",
    // Paste side: restore + style carry-over
    "parseClip(localStorage.getItem(CLIP_STORAGE_KEY))",
    "function applyClipCarryOver(): void {",
    "missingClipDeps(doc, clip)",
    // Tab-switch awareness
    "Ctrl+V to paste into this drawing",
  ];
  for (const m of mustContain) assert.ok(viewer.includes(m), `cad-viewer.ts drift: missing "${m}"`);
  // Hotkeys: Ctrl+C copy, Ctrl+X cut, Ctrl+V paste, Ctrl+Shift+V paste-to-origin
  assert.ok(viewer.includes('if (modKey && lower === "c") {'), "Ctrl+C hotkey missing");
  assert.ok(viewer.includes("if (copySelection()) eraseSelected();"), "Ctrl+X cut missing");
  assert.ok(viewer.includes("if (ev.shiftKey) pasteOrig();"), "Ctrl+Shift+V missing");
  assert.ok(viewer.includes("else pasteClip();"), "Ctrl+V missing");
  // Ribbon Clipboard panel buttons
  for (const a of ['data-a="clipcopy"', 'data-a="clipcut"', 'data-a="clippaste"', 'data-a="pasteorig"']) {
    assert.ok(viewer.includes(a), `ribbon button ${a} missing`);
  }
  // Command table + parser
  assert.ok(viewer.includes('if (cmd === "COPYCLIP") {'), "COPYCLIP command missing");
  assert.ok(viewer.includes('if (cmd === "PASTECLIP") {'), "PASTECLIP command missing");
  assert.ok(viewer.includes('if (cmd === "PASTEORIG") {'), "PASTEORIG command missing");
  // The clipboard module exposes the Super Copy API the viewer imports
  const clipSrc = read("modules", "cad-viewer", "clipboard.ts");
  for (const m of ["export function collectClipDeps(", "export function missingClipDeps(", "export function serializeClip(", "export function parseClip("]) {
    assert.ok(clipSrc.includes(m), `clipboard.ts drift: missing "${m}"`);
  }
});

console.log(`\ncad-ui-wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
