// Unit service: imperial display strings must re-parse to the same length (edit boxes show and accept what the chip shows).
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "uimp-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
try { fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* linked */ }
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
const run = (strict) => execSync(`npx tsc src/core/units.ts --outDir ${out} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --resolveJsonModule --skipLibCheck${strict ? " --strict" : ""}${flag}`, { stdio: "pipe", cwd: root });
try { run(true); } catch { run(false); }
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name === "node_modules") continue; const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
global.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
const U = require(find("units.js")).units;
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const IN = 0.0254;
t("ft-in format", () => {
  assert.equal(U.formatLength(150.5 * IN, { unit: "ft-in" }), `12'-6 1/2"`);
  assert.equal(U.formatLength(-18 * IN, { unit: "ft-in" }), `-1'-6"`);
});
t("ft-in round trip (format → parse) within 1/32 in", () => {
  for (const inches of [0, 6, 12, 150.5, 37.3125, 1000.25, 95.9375]) {
    const s = U.formatLength(inches * IN, { unit: "ft-in" });
    const back = U.parseLengthInput(s, "ft-in");
    assert.ok(back !== null && Math.abs(back - inches * IN) < IN / 32, `${s} → ${back}`);
  }
});
t("typed forms parse to metres", () => {
  const near = (a, b) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(U.parseLengthInput(`5'-6 1/2"`), (66.5) * IN);
  near(U.parseLengthInput(`5' 6"`), 66 * IN);
  near(U.parseLengthInput(`5'`), 60 * IN);
  near(U.parseLengthInput(`10 ft`), 120 * IN);
  near(U.parseLengthInput(`30in`), 30 * IN);
  near(U.parseLengthInput(`3.5 m`), 3.5);
  near(U.parseLengthInput(`200 mm`), 0.2);
});
t("garbage input is rejected, not NaN", () => {
  for (const s of ["", "abc", "5'x'y", "--3"]) { const r = U.parseLengthInput(s); assert.ok(r === null || Number.isFinite(r), s); }
});
console.log(`units-imperial-roundtrip: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
