// Typed feet/inches as a direct distance (follow-up to #312): 5'6" typed while a tool waits for a number must
// act as 1676.4 in an mm drawing. The command line rewrote the text but tested the ORIGINAL text, so it answered "Unknown command".
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "typd-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
try { fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* linked */ }
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
const run = (strict) => execSync(`npx tsc src/modules/cad-viewer/imperial.ts --outDir ${out} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck${strict ? " --strict" : ""}${flag}`, { stdio: "pipe", cwd: root });
try { run(true); } catch { run(false); }
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name === "node_modules") continue; const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const I = require(find("imperial.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const dist = (line, units) => I.directNumberFromInput(I.rewriteImperialInput(line, units).text);

t("5'6\" in an mm drawing is a 1676.4 distance", () => { assert.equal(dist("5'6\"", "mm"), 1676.4); });
t("5' in an ft drawing is 5; 6\" in an in drawing is 6", () => { assert.equal(dist("5'", "ft"), 5); assert.equal(dist("6\"", "in"), 6); });
t("12'-6 1/2\" in an mm drawing", () => { assert.ok(Math.abs(dist("12'-6 1/2\"", "mm") - 3822.7) < 1e-9); });
t("plain numbers are unchanged", () => { assert.equal(dist("1676.4", "mm"), 1676.4); assert.equal(dist("-3", "mm"), -3); assert.equal(dist("2e3", "mm"), 2000); });
t("commands and coordinate pairs are not direct distances", () => { assert.equal(dist("LINE", "mm"), null); assert.equal(dist("0,0", "mm"), null); assert.equal(dist("OFFSET 5'", "mm"), null); });

// Wiring guard: cad-viewer must decide on the REWRITTEN text (not the raw typed text) for the direct-number branch.
const src = fs.readFileSync(path.join(root, "src", "features", "cad-viewer.ts"), "utf8");
t("cad-viewer uses directNumberFromInput(imp.text) for direct entry", () => {
  assert.ok(src.includes("directNumberFromInput(imp.text)"), "direct-number branch must use the rewritten text");
  assert.ok(!/\.test\(trimmed\)\) \{\s*const num = parseFloat\(trimmed\);/.test(src), "old raw-text direct-number check is back");
});
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
