/* A truncated DXF must be refused when merging into an existing drawing (#90). */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "dxfc-"));
execSync(`npx tsc src/modules/drawings/dxf-complete.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe", cwd: path.join(__dirname, "..") });
const { dxfCompleteness } = require(path.join(out, "dxf-complete.js"));
const D = (...a) => a.join("\n") + "\n";
const good = D(0, "SECTION", 2, "ENTITIES", 0, "LINE", 8, "0", 10, 0, 20, 0, 11, 1, 21, 1, 0, "ENDSEC", 0, "EOF");
let n = 0; const t = (name, f) => { f(); n++; console.log("  PASS " + name); };
t("complete file passes (LF, CRLF, no trailing newline)", () => {
  assert.ok(dxfCompleteness(good).complete);
  assert.ok(dxfCompleteness(good.replace(/\n/g, "\r\n")).complete);
  assert.ok(dxfCompleteness(good.trimEnd()).complete);
  assert.ok(dxfCompleteness(good.replace("EOF", "eof")).complete);
});
t("cut mid-record is refused", () => {
  const cut = D(0, "SECTION", 2, "ENTITIES", 0, "LINE", 8, "0", 10, 0, 20);
  const r = dxfCompleteness(cut); assert.equal(r.complete, false); assert.match(r.reason, /middle of a record/);
});
t("missing EOF is refused", () => {
  const r = dxfCompleteness(D(0, "SECTION", 2, "ENTITIES", 0, "ENDSEC")); assert.equal(r.complete, false); assert.match(r.reason, /end-of-file/);
});
t("empty and one-line input is refused", () => { assert.equal(dxfCompleteness("").complete, false); assert.equal(dxfCompleteness("0").complete, false); });
t("binary DXF is left to the reader", () => { assert.ok(dxfCompleteness("AutoCAD Binary DXF\r\n\x1a\x00").complete); });
t("empty string values inside a record do not break the parity check", () => {
  assert.ok(dxfCompleteness(D(0, "SECTION", 2, "HEADER", 9, "$X", 1, "", 0, "ENDSEC", 0, "EOF")).complete);
});
console.log(`${n} passed, 0 failed`);
