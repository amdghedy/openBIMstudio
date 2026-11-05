// Source-level guard: Clash Review is a dockable panel, not a fixed floating box.
const fs = require("fs"), assert = require("assert");
const s = fs.readFileSync("src/features/clash-review.ts", "utf8");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
t("uses makeDockable with a header and a stable id", () => { assert.ok(/makeDockable\(panel/.test(s)); assert.ok(/id: "clash-review"/.test(s)); assert.ok(/header,/.test(s)); });
t("is mounted in the right host, not on document.body", () => { assert.ok(s.includes("ctx.rightHost.appendChild(panel)")); assert.ok(!s.includes("document.body.appendChild(panel)")); });
t("the old hand-rolled drag code is gone", () => { assert.ok(!s.includes("POS_KEY")); assert.ok(!/let dragging/.test(s)); });
t("open and close keep the dock in step", () => { assert.ok(s.includes("dock?.show()")); assert.ok(s.includes("dock?.hide()")); });
console.log(`=== Result: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
