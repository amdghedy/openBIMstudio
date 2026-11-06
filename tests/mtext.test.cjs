const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "mt-"));
execSync(`npx tsc src/modules/drawings/mtext.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const { cleanText, textLines } = require(path.join(out, "mtext.js"));
let n = 0; const t = (a, b) => { assert.strictEqual(cleanText(a), b, JSON.stringify(a)); n++; };
t("Line1\\PLine2", "Line1\nLine2");
t("{\\fArial|b1|i0|c0|p34;Bold} text", "Bold text");
t("\\H2.5x;Big\\H1x; small", "Big small");
t("\\C1;Red\\C7;White", "RedWhite");
t("\\W0.8;\\Q15;\\T2;\\A1;ok", "ok");
t("\\LUnder\\l and \\Oover\\o", "Under and over");
t("\\S1/2; in", "1/2 in");
t("\\S3^ 4;", "3  4");
t("\\S1#2;", "1/2");
t("\\U+00B0 \\U+00D8", "° Ø");
t("%%c50 %%d %%p0.1", "Ø50 ° ±0.1");
t("%%uUnder%%u %%065", "Under A");
t("a\\~b", "a b");
t("\\\\ \\{x\\}", "\\ {x}");
t("\\pxi-3,l3;Para", "Para");
t("plain text", "plain text");
t("  trailing \\P  ", "trailing");
t("a\\P \\P b", "a\n\nb");
t("\\fSimSun|b0|i0|c134|p2;中文", "中文");
assert.deepStrictEqual(textLines("a\nb\nc"), ["a", "b", "c"]); n++;

// mtextRuns — structured runs with inline colour / weight state
const { mtextRuns } = require(path.join(out, "mtext.js"));
const R = (src) => mtextRuns(src);
const eq = (got, want, label) => { assert.deepStrictEqual(got, want, label); n++; };

eq(R("plain text"), [{ text: "plain text" }], "unformatted MTEXT -> one bare run");
eq(
  R("\\C1;Red\\C7;White"),
  [{ text: "Red", color: 1 }, { text: "White", color: 7 }],
  "\\C codes split runs and carry the ACI colour",
);
eq(
  R("\\c16576;true"),
  [{ text: "true", rgb: 16576 & 0xffffff }],
  "\\c true colour is masked to RGB",
);
eq(
  R("{\\fArial|b1|i0;Bold} and \\fRomans|i1;ital"),
  [
    { text: "Bold and ", bold: true },
    { text: "ital", italic: true },
  ],
  "\\f flags apply until the next \\f; absent flags reset (native semantics)",
);
eq(
  R("Line1\\PLine2\\C3; end"),
  [{ text: "Line1\nLine2", }, { text: " end", color: 3 }],
  "\\P stays inside the run text; style change after it splits",
);
eq(R("\\H2x;size\\W0.8;"), [{ text: "size" }], "\\H / \\W are dropped, not run boundaries");
eq(
  R("%%c50 \\U+00B0"),
  [{ text: "Ø50 °" }],
  "%% and \\U+ escapes decode inside runs",
);
eq(R(""), [], "empty string -> no runs");
console.log("mtext OK", n);
