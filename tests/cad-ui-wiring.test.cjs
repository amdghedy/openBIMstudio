// DWG-grade CAD reading, wired into the UI/UX — source drift-guard test.
//
// The engine reads the file's tables (LAYER / LTYPE / STYLE / DIMSTYLE) and
// entities the way DWG does (commit 73d381c). This suite guards the
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
const shortcutsSrc = read("features", "shortcuts.ts");

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

// ── 1. Drawing Database Status reports everything the reader pulled out ──
t("info dialog: full database status markers", () => {
  const mustContain = [
    "Drawing Database Status",
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

// ── 5. DWG command activation: Space executes exact commands and aliases ──
t("command entry: Space executes exact commands in both command inputs without eating argument spaces", () => {
  assert.ok(viewer.includes("function isExactCadCommandToken(rawInput: string): boolean"), "exact command-token guard missing");
  assert.ok(viewer.includes("const resolved = resolveCadToken(token, CAD_COMMANDS);"), "custom and built-in aliases are not resolved");
  assert.ok(viewer.includes('if (event.key === " " || event.code === "Space")'), "dynamic command input does not handle Space");
  assert.ok(viewer.includes('if (e.key === " " || e.code === "Space")'), "command line does not handle Space");
  assert.ok(viewer.includes("if (isExactCadCommandToken(dynCommandInput.value))"), "dynamic input executes partial commands");
  assert.ok(viewer.includes("if (isExactCadCommandToken(cmdInput.value))"), "command line executes partial commands");
  assert.ok(viewer.includes('if (!token || token.includes(" ")) return false;'), "argument-containing input is not protected");
});

// ── 6. Runtime: compile the two helpers and verify their behaviour ──
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
  // Zero height (DWG "fixed height 0" = height set per entity) falls back to an editable default
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
    'mod.placeLabel ?? "PASTECLIP"}: ${placed.length} object(s) placed',
    // Copy side: dependency snapshot + persistence
    "collectClipDeps(list, doc)",
    "persistClip();",
    "localStorage.setItem(CLIP_STORAGE_KEY",
    // Paste side: restore + style carry-over
    "parseClip(localStorage.getItem(CLIP_STORAGE_KEY))",
    "function applyClipCarryOver(): void {",
    "missingClipDeps(doc, clip)",
    // Tab-switch awareness
    "Ctrl+V or Ctrl+Shift+V to paste into this drawing",
  ];
  for (const m of mustContain) assert.ok(viewer.includes(m), `cad-viewer.ts drift: missing "${m}"`);
  // Hotkeys: Ctrl+C / Ctrl+Shift+C copy, Ctrl+X cut, Ctrl+V / Ctrl+Shift+V paste, Ctrl+Alt+V paste-to-origin
  // Layout-proof: shortcuts must fall back to ev.code for non-Latin keyboard layouts
  assert.ok(
    viewer.includes('const hotKey = lower >= "a" && lower <= "z" ? lower : physKey;'),
    "layout-proof hotkey resolution missing"
  );
  assert.ok(viewer.includes('if (modKey && hotKey === "c") {'), "Ctrl+C hotkey missing");
  assert.ok(viewer.includes("(Ctrl+C / Ctrl+Shift+C)"), "Ctrl+Shift+C copy hint missing");
  assert.ok(viewer.includes("if (copySelection()) eraseSelected();"), "Ctrl+X cut missing");
  assert.ok(viewer.includes("if (ev.altKey) pasteOrig();"), "Ctrl+Alt+V paste-to-origin missing");
  assert.ok(viewer.includes("else pasteClip();"), "Ctrl+V paste missing");
  // Keyboard ownership bridge: the BIM global shortcut registry must yield the
  // CAD editing combos while a drawing tab is active, or its
  // stopImmediatePropagation() kills the CAD hotkeys (Ctrl+Shift+C/V bug).
  assert.ok(
    shortcutsSrc.includes("__obsCadOwnsKeys") && shortcutsSrc.includes("CAD_EDITOR_COMBOS.has(combo)"),
    "shortcuts.ts CAD keyboard-ownership yield missing"
  );
  assert.ok(
    shortcutsSrc.includes('"ctrl+shift+c"') && shortcutsSrc.includes('"ctrl+shift+v"'),
    "CAD-owned combo set incomplete"
  );
  assert.ok(
    viewer.includes("(window as any).__obsCadOwnsKeys = () =>") &&
      viewer.includes("delete (window as any).__obsCadOwnsKeys;"),
    "cad-viewer.ts keyboard ownership bridge missing"
  );
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

// ── 7. Hotkey ownership: the CAD editor owns Ctrl+Shift+C / Ctrl+Shift+V ──
t("super copy hotkey ownership: app-level handlers stand down while a drawing tab is active", () => {
  // The ownership flag lives in a module singleton (core/cad-hotkey-ownership.ts)
  const owner = read("core", "cad-hotkey-ownership.ts");
  for (const m of ["export function isCadHotkeyOwnerActive(", "export function setCadHotkeyOwner("]) {
    assert.ok(owner.includes(m), `cad-hotkey-ownership.ts drift: missing "${m}"`);
  }
  // The CAD editor raises / lowers the ownership flag on activate / deactivate
  assert.ok(viewer.includes("setCadHotkeyOwner(true);"), "cad-viewer activate must claim hotkey ownership");
  assert.ok(viewer.includes("setCadHotkeyOwner(false);"), "cad-viewer deactivate must release hotkey ownership");
  // Shortcut-registry entries bound to the same combos must carry a when-guard,
  // otherwise the registry's stopImmediatePropagation eats the key before the
  // viewer's window-capture handler ever sees it.
  const ds = read("shell", "default-shortcuts.ts");
  assert.ok(ds.includes('keys: "ctrl+shift+c"'), "app-clash-review keys drift");
  assert.ok(ds.includes('keys: "ctrl+shift+v"'), "view.tools-manager keys drift");
  const guards = ds.split("when: () => !isCadHotkeyOwnerActive()").length - 1;
  assert.strictEqual(guards, 2, `expected 2 shortcut when-guards for CAD hotkey ownership, found ${guards}`);
  // Window-level handlers bound to Ctrl+Shift+V must stand down too
  for (const f of [["features", "saved-views.ts"], ["critical-gaps-boot-strength.ts"], ["modules", "view-templates", "vg-dialog.ts"]]) {
    const src = read(...f);
    assert.ok(src.includes("if (isCadHotkeyOwnerActive()) return;"), `${f[f.length - 1]} must stand down while a CAD drawing is active`);
  }
});

// ── 8. RAY / XLINE construction lines drawn like native CAD ──
t("ray/xline: infinite construction lines are read, drawn edge-to-edge and saved", () => {
  // The viewer clips the infinite line to the view and never culls it by its
  // degenerate anchor box
  for (const m of ["case \"RAY\":", "case \"XLINE\": {", "M.infiniteLineSegment(e, v)", "const infinite = e.type === \"RAY\" || e.type === \"XLINE\";"]) {
    assert.ok(viewer.includes(m), `cad-viewer.ts drift: missing "${m}"`);
  }
  // The math module owns the clip + anchor-only bbox + infinite-line picking
  const vm = read("modules", "cad-viewer", "viewer-math.ts");
  for (const m of ["export function infiniteLineSegment(", "case \"RAY\":\n    case \"XLINE\": return { minX: e.start.x"]) {
    assert.ok(vm.includes(m), `viewer-math.ts drift: missing "${JSON.stringify(m)}"`);
  }
  // The readers turn the file records into entities (no longer skipped)
  const reader = read("modules", "drawings", "dxf-reader.ts");
  assert.ok(reader.includes("case \"RAY\":\n      case \"XLINE\": {"), "dxf-reader must parse RAY/XLINE");
  const dwg = read("modules", "drawings", "dwg-convert.ts");
  assert.ok(dwg.includes("case \"RAY\":\n        case \"XLINE\": {"), "dwg-convert must convert RAY/XLINE");
  // The DXF writer keeps them on save
  const writer = read("modules", "drawings", "dxf-writer.ts");
  assert.ok(writer.includes("} else if (e.type === \"RAY\" || e.type === \"XLINE\") {"), "dxf-writer must write RAY/XLINE");
});

// ── 9. MTEXT fidelity: column wrap, inline runs, native measurement text ──
t("mtext fidelity: readers keep width/spacing/runs, viewer wraps and paints runs, writer splits multi-line TEXT", () => {
  // The decoder owns the structured runs and the reader-facing extras
  const mt = read("modules", "drawings", "mtext.ts");
  for (const m of ["export function mtextRuns(", "export function mtextExtras("]) {
    assert.ok(mt.includes(m), `mtext.ts drift: missing "${m}"`);
  }
  // All three readers attach the MTEXT extras (column width, line spacing, runs)
  const reader = read("modules", "drawings", "dxf-reader.ts");
  assert.ok(reader.includes("...mtextExtras(chunks, d.n(41, 0), d.n(44, 1))"), "dxf-reader must keep MTEXT wrap/spacing/runs");
  const dwg = read("modules", "drawings", "dwg-convert.ts");
  assert.ok(dwg.includes("mtextExtras("), "dwg-convert must keep MTEXT wrap/spacing/runs");
  const acad = read("modules", "drawings", "acad-engine.ts");
  assert.ok(acad.includes("mtextExtras("), "acad-engine must keep MTEXT wrap/spacing/runs");
  // The viewer draws through textRuns (wrap-aware) and paints styled runs per colour/weight
  for (const m of ["const lines = M.textRuns(e);", "r.rgb != null ? rgbToCss(r.rgb & 0xffffff)"]) {
    assert.ok(viewer.includes(m), `cad-viewer.ts drift: missing "${m}"`);
  }
  // viewer-math owns the wrap + runs view shared by drawing, hit-test and bbox
  const vm = read("modules", "cad-viewer", "viewer-math.ts");
  for (const m of ["export function textRuns(", "function wrapLine(", "e.lineSpacing ?? 1"]) {
    assert.ok(vm.includes(m), `viewer-math.ts drift: missing "${m}"`);
  }
  // The writer must never emit a raw newline inside a TEXT record
  const writer = read("modules", "drawings", "dxf-writer.ts");
  for (const m of ["const emitText = (value: string, pos: DxfPoint", "lines.length <= 1", "TEXT_LINE_PITCH"]) {
    assert.ok(writer.includes(m), `dxf-writer.ts drift: missing "${m}"`);
  }
  // Native dimension measurement formatting (DIMDEC / DIMPOST / DIMLFAC)
  for (const m of ["const decimals = Math.max(0, Math.min(8, d.has(271) ? d.n(271) : st?.decimals ?? 2));", "const postFix = st?.postFix ?? \"\";"]) {
    assert.ok(reader.includes(m), `dxf-reader.ts drift: missing "${m}"`);
  }
});

console.log(`\ncad-ui-wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
