/**
 * Revit 2D keyboard — audit gap G8.
 *
 * TR was bound to Truss while the context menu labelled Trim/Extend "TR";
 * DI/OF/CO/MI/AR/SC/VG/TL appeared as kbd labels with no binding at all.
 * This test pins the fix two ways:
 *   (1) runtime: compile the pure binding module and assert the key ->
 *       command table and its dispatch (no DOM, no app boot);
 *   (2) source: assert the live registrations, the TR->TS truss rename in
 *       every place that advertised it, and that no two-letter key is
 *       registered twice across the two registration files.
 *
 * WT/WC (Tile Views / Close Hidden) are asserted UNBOUND: views cannot tile
 * until gap G12 lands, so those keys must stay free.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── (1) runtime: the pure binding table ────────────────────────────────
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "g8-"));
execSync(`npx tsc src/modules/shortcuts/revit-g8-keys.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const g8 = require(path.join(out, "revit-g8-keys.js"));

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// Exact binding table: keys -> target command/tool.
const expected = [
  ["tr", { kind: "bim-command", id: "modify.trimExtend" }],
  ["co", { kind: "authoring-tool", tool: "copy" }],
  ["mi", { kind: "authoring-tool", tool: "mirror" }],
  ["ar", { kind: "authoring-tool", tool: "array" }],
  ["of", { kind: "authoring-tool", tool: "offset" }],
  ["sc", { kind: "gizmo-mode", mode: "scale" }],
  ["di", { kind: "plan-tool", tool: "dim-aligned" }],
  ["vg", { kind: "bim-command", id: "view.graphics" }],
  ["tl", { kind: "thin-lines" }],
];
ok(g8.REVIT_G8_BINDINGS.length === expected.length, `9 G8 bindings, got ${g8.REVIT_G8_BINDINGS.length}`);
for (const [keys, target] of expected) {
  const b = g8.findG8Binding(keys);
  ok(b, `${keys.toUpperCase()} is bound`);
  assert.deepStrictEqual(b.target, target, `${keys.toUpperCase()} target`);
}
ok(g8.findG8Binding("TR")?.keys === "tr", "lookup is case-insensitive");
ok(g8.findG8Binding("ts") === undefined, "TS (Truss) is not a G8 binding — it lives in default-shortcuts.ts");
ok(g8.findG8Binding("wt") === undefined && g8.findG8Binding("wc") === undefined, "WT/WC stay unbound (G12)");
ok(g8.TRUSS_KEYS === "ts", "TRUSS_KEYS is ts");
ok(g8.TRIM_EXTEND_KEYS === "tr", "TRIM_EXTEND_KEYS is tr");
assert.deepStrictEqual([...g8.G8_UNBOUND_KEYS].sort(), ["wc", "wt"], "unbound list is exactly wt/wc");
const tableKeys = g8.REVIT_G8_BINDINGS.map((b) => b.keys);
ok(new Set(tableKeys).size === tableKeys.length, "no duplicate keys in the G8 table");
ok(tableKeys.every((k) => /^[a-z]{2}$/.test(k)), "every G8 key is a two-letter sequence");

// Dispatch: each target kind calls exactly the right environment callback.
function recordingEnv() {
  const calls = [];
  return {
    calls,
    env: {
      executeBimCommand: (id) => calls.push(["bim-command", id]),
      setAuthoringTool: (tool) => calls.push(["authoring-tool", tool]),
      setGizmoMode: (mode) => calls.push(["gizmo-mode", mode]),
      openPlanTool: (tool) => calls.push(["plan-tool", tool]),
      toggleThinLines: () => calls.push(["thin-lines"]),
    },
  };
}
for (const b of g8.REVIT_G8_BINDINGS) {
  const r = recordingEnv();
  g8.runG8Binding(b, r.env);
  assert.strictEqual(r.calls.length, 1, `${b.keys.toUpperCase()} dispatches exactly once`);
  const [kind, arg] = r.calls[0];
  assert.strictEqual(kind, b.target.kind, `${b.keys} dispatch kind`);
  if (b.target.kind === "bim-command") assert.strictEqual(arg, b.target.id, `${b.keys} bim command id`);
  else if (b.target.kind === "authoring-tool" || b.target.kind === "plan-tool") assert.strictEqual(arg, b.target.tool, `${b.keys} tool`);
  else if (b.target.kind === "gizmo-mode") assert.strictEqual(arg, "scale", "SC gizmo mode");
  else if (b.target.kind === "thin-lines") assert.strictEqual(arg, undefined, "TL takes no argument");
  n++;
}
ok(true, "every G8 binding dispatches to its target");

// ── (2) source: the live wiring ────────────────────────────────────────
const ds = read("src/shell/default-shortcuts.ts");
const bic = read("src/features/bim-input-compatibility.ts");
const ribbon = read("src/shell/ribbon.ts");
const palette = read("src/features/command-palette.ts");
const planCmds = read("src/modules/plan/plan-commands.ts");
const ctxMenu = read("src/features/context-menu-model.ts");
const guide = read("docs/USER-GUIDE.md");

// Truss moved TR -> TS everywhere it was advertised.
ok(/id: "tool-truss",\s+label: "Truss",\s+keys: "ts"/.test(ds), "default-shortcuts: Truss on TS");
ok(!/keys: "tr"/.test(ds), "default-shortcuts: no TR binding left");
ok(/toolBtn\("truss", "Truss", "truss", "TS"\)/.test(ribbon), "ribbon: Truss button TS");
ok(/tool\("Truss", "truss", "TS"\)/.test(palette), "command palette: Truss TS");
ok(/truss: "TS"/.test(palette), "command palette aliases: truss TS");
ok(/"TRUSS", \["TS"\]/.test(planCmds), "plan commands: TRUSS alias TS");
ok(!/truss", "TR"/.test(palette) && !/truss: "TR"/.test(palette), "no TR left for Truss in the palette");

// TR now means Trim/Extend, consistently.
ok(/b\("move", "Trim\/Extend", cmd\("modify\.trimExtend"\), dis\(button, \{ kbd: "TR"/.test(ribbon), "ribbon: Trim/Extend button shows TR");
ok(/text: "Trim \/ Extend to Corner"[^}]*kbd: "TR"/.test(ctxMenu), "context menu: Trim/Extend still TR");
ok(bic.includes("REVIT_G8_BINDINGS") && bic.includes("runG8Binding"), "bim-input-compatibility consumes the G8 table");
ok(/for \(const binding of REVIT_G8_BINDINGS\)/.test(bic) && /keys: binding\.keys/.test(bic), "bim-input-compatibility registers the G8 table (TR included) via the loop");

// The G8 keys resolve to the right commands in the registration site.
for (const [keys, target] of expected) {
  ok(bic.includes(`keys: "${keys}"`) || bic.includes("REVIT_G8_BINDINGS"), `${keys.toUpperCase()} registered from the G8 table`);
}
ok(bic.includes('__obsBIMExperience'), "TR/VG dispatch through the BIM command runner");
ok(bic.includes('setAuthoringTool'), "CO/MI/AR/OF dispatch through setAuthoringTool");
ok(bic.includes('isThinLines') && bic.includes('setThinLines'), "TL dispatches through view-graphics");
ok(bic.includes('./plan-view-panel') && bic.includes('planView?.setTool?.'), "DI opens the plan view and arms its tool");

// Help overlay (Ctrl+/) lists the new keys (SC shares a cell with S).
for (const kbd of ["TR", "CO", "MI", "AR", "OF", "DI", "VG", "TL", "TS"]) {
  ok(bic.includes(`<td>${kbd}</td>`), `help overlay lists ${kbd}`);
}
ok(bic.includes("<td>S / SC</td>"), "help overlay lists S / SC");

// No two-letter key is registered twice across the two registration files.
function registeredKeys(src) {
  return [...src.matchAll(/keys:\s*"([a-z]{2})"/g)].map((m) => m[1]);
}
const allKeys = [...registeredKeys(ds), ...registeredKeys(bic)];
const dupes = allKeys.filter((k, i) => allKeys.indexOf(k) !== i);
ok(dupes.length === 0, `no duplicate two-letter keys (found: ${dupes.join(", ") || "none"})`);
for (const k of ["wt", "wc"]) {
  ok(!allKeys.includes(k), `${k.toUpperCase()} is not registered anywhere`);
}
ok(!registeredKeys(bic).includes("tr"), "TR is registered only via the G8 table, not as a stray literal");

// Docs agree with the code.
ok(/\*\*TS\*\* \| Truss/.test(guide), "user guide: TS Truss");
ok(/\*\*TR\*\* \| Trim \/ Extend/.test(guide), "user guide: TR Trim/Extend");
ok(!/\*\*TR\*\* \| Truss/.test(guide), "user guide: no TR Truss row left");

console.log(`revit-g8-keyboard: ${n} checks OK`);
