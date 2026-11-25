// CAD snap overrides (AutoCAD parity A15) — pure module tests.
//
// Mirrors the plan-view G14 test (tests/plan-snap-override-g14.test.cjs):
// the same five two-letter keys (SE/SM/SC/SI/SN) and the same one-shot
// state machine, so the CAD viewer matches plan-view behaviour. The
// module under test is src/modules/cad-viewer/cad-snap-override.ts.
//
// SC is contested three ways, and this test pins the resolution by
// scanning the real sources instead of trusting a hardcoded list:
//   1. SC = SCALE command alias in the CAD command line (cad-viewer.ts
//      CAD_COMMANDS) — the AutoCAD alias.
//   2. SC = G8 gizmo-scale binding in the global shortcut registry
//      (revit-g8-keys.ts id "bim-sc").
//   3. SC = snap-centre one-shot override (this module).
// While a CAD drafting tool is active, SC = snap-centre (the CAD keydown
// handler consumes the pair before the command line sees it); with no
// CAD tool active, SC falls through to the command line as SCALE. The
// G8 registry never fires inside the drawing editor at all — it yields
// bare letters while the CAD editor owns the keyboard.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-snap-ov-"));
try {
  execSync(`npx tsc src/modules/cad-viewer/cad-snap-override.ts --outDir ${out} --rootDir src --module commonjs --target es2020 --skipLibCheck`, { cwd: root, stdio: "pipe" });
} catch (e) {
  const log = String((e.stdout || "") + (e.stderr || ""));
  assert.fail("type errors in cad-snap-override.ts:\n" + log);
}
const ov = require(path.join(out, "modules/cad-viewer/cad-snap-override.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

// ---- State machine (one-shot) ----
t("override starts disarmed", () => { const o = ov.createCadSnapOverride(); assert.strictEqual(o.active, null); });
t("arm replaces, consume clears once", () => {
  const o = ov.createCadSnapOverride();
  o.arm("endpoint"); assert.strictEqual(o.active, "endpoint");
  o.arm("midpoint"); assert.strictEqual(o.active, "midpoint");
  assert.strictEqual(o.consumeAfterSnap(), true); assert.strictEqual(o.active, null);
  assert.strictEqual(o.consumeAfterSnap(), false);
});
t("clear disarms without consuming", () => {
  const o = ov.createCadSnapOverride();
  o.arm("center"); o.clear(); assert.strictEqual(o.active, null);
  assert.strictEqual(o.consumeAfterSnap(), false);
});
t("label lookup", () => {
  assert.strictEqual(ov.cadSnapOverrideLabel("intersection"), "Intersection");
  assert.strictEqual(ov.cadSnapOverrideLabel("nearest"), "Nearest");
  assert.strictEqual(ov.cadSnapOverrideLabel("center"), "Center");
});

// ---- Key resolution + SC precedence ----
t("SE/SM/SC/SI/SN resolve while a CAD tool is active", () => {
  assert.strictEqual(ov.resolveOverrideKeys("s", "e", true), "endpoint");
  assert.strictEqual(ov.resolveOverrideKeys("s", "m", true), "midpoint");
  assert.strictEqual(ov.resolveOverrideKeys("s", "c", true), "center");
  assert.strictEqual(ov.resolveOverrideKeys("s", "i", true), "intersection");
  assert.strictEqual(ov.resolveOverrideKeys("s", "n", true), "nearest");
});
t("SC falls through (SCALE command) when no CAD tool is active", () => {
  assert.strictEqual(ov.resolveOverrideKeys("s", "c", false), null);
});
t("no override resolves when no CAD tool is active", () => {
  assert.strictEqual(ov.resolveOverrideKeys("s", "e", false), null);
  assert.strictEqual(ov.resolveOverrideKeys("s", "n", false), null);
});
t("keys are case-insensitive", () => {
  assert.strictEqual(ov.resolveOverrideKeys("S", "E", true), "endpoint");
  assert.strictEqual(ov.resolveOverrideKeys("s", "C", true), "center");
});
t("first letter must be s", () => {
  assert.strictEqual(ov.resolveOverrideKeys("x", "e", true), null);
  assert.strictEqual(ov.resolveOverrideKeys("", "e", true), null);
});
t("SP/ST/SQ/SV are not override keys (not bound in this branch)", () => {
  for (const k of ["p", "t", "q", "v"]) assert.strictEqual(ov.resolveOverrideKeys("s", k, true), null);
});
t("omission table records all four honestly", () => {
  const ks = ov.OMITTED_OVERRIDE_KEYS.map((e) => e.keys).sort();
  assert.deepStrictEqual(ks, ["sp", "sq", "st", "sv"]);
  for (const e of ov.OMITTED_OVERRIDE_KEYS) assert.ok(e.reason.length > 10, e.keys);
  // ST's reason must name the real blocker: the STYLE command alias.
  assert.ok(ov.OMITTED_OVERRIDE_KEYS.find((e) => e.keys === "st").reason.includes("STYLE"));
});
t("override entries: five, unique keys, Revit labels", () => {
  assert.strictEqual(ov.CAD_SNAP_OVERRIDE_ENTRIES.length, 5);
  assert.deepStrictEqual(ov.CAD_SNAP_OVERRIDE_ENTRIES.map((e) => e.keys), ["se", "sm", "sc", "si", "sn"]);
  assert.deepStrictEqual(ov.CAD_SNAP_OVERRIDE_ENTRIES.map((e) => e.label), ["Endpoint", "Midpoint", "Center", "Intersection", "Nearest"]);
});
t("isOverrideFirstKey", () => {
  assert.strictEqual(ov.isOverrideFirstKey("s"), true);
  assert.strictEqual(ov.isOverrideFirstKey("S"), true);
  assert.strictEqual(ov.isOverrideFirstKey("e"), false);
});

// ---- SC three-way claim, scanned from the real sources ----
t("SC is claimed three ways, and only SC collides", () => {
  const viewerSrc = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  const cadAliases = new Set(
    [...viewerSrc.matchAll(/aliases:\s*\[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/"([A-Za-z]{1,2})"/g)].map((x) => x[1].toLowerCase())),
  );
  const g8Src = fs.readFileSync(path.join(root, "src/modules/shortcuts/revit-g8-keys.ts"), "utf8");
  const g8Keys = new Set([...g8Src.matchAll(/keys:\s*"([a-z]{2})"/g)].map((m) => m[1]));
  // The documented three-way claim must still be true.
  assert.ok(cadAliases.has("sc"), "SC must still be the SCALE command alias in the CAD viewer");
  assert.ok(g8Keys.has("sc"), "SC must still be the G8 gizmo-scale binding");
  assert.ok(viewerSrc.includes("SCALE") && viewerSrc.includes('"SC"'), "SCALE/SC alias must be present");
  // No other override key may be claimed by either.
  for (const e of ov.CAD_SNAP_OVERRIDE_ENTRIES) {
    if (e.keys === "sc") continue;
    assert.ok(!cadAliases.has(e.keys), e.keys + " collides with a CAD command alias");
    assert.ok(!g8Keys.has(e.keys), e.keys + " collides with a G8 registry key");
  }
  // ST must still be the STYLE alias (the reason SP/ST/SQ stay unbound).
  assert.ok(cadAliases.has("st"), "ST must still be the STYLE command alias");
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
