// i18n audit gates (issues #140, #141; ROADMAP Phase 0). Black-box: runs the
// audit script itself, so the gates it enforces are the ones CI enforces.
const { spawnSync } = require("child_process");
const path = require("path"), assert = require("assert");

const root = path.join(__dirname, "..");
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const run = (args) => spawnSync("node", [path.join(root, "scripts", "i18n-audit.mjs"), ...args], { encoding: "utf8" });

const audit = run(["--check"]);
ok(audit.status === 0, `i18n-audit --check must pass:\n${audit.stdout}\n${audit.stderr}`);

const gen = spawnSync("node", [path.join(root, "scripts", "gen-catalogs.mjs"), "--check"], { encoding: "utf8" });
ok(gen.status === 0, `gen-catalogs --check must pass (checked-in catalogues in sync with sources):\n${gen.stdout}\n${gen.stderr}`);

// The report itself is the evidence: exactly 10 translated locales, the
// 9 untranslated ones named, and he/fa/ur held LTR (catalogue rtl, effective ltr).
const out = audit.stdout;
ok(/translated \(10\): ar, de, en, es, fr, hi, ja, pt-BR, ru, zh-CN/.test(out), "10 translated locales");
ok(/untranslated \(9\): fa, he, it, ko, nl, pl, tr, ur, zh-TW/.test(out), "9 untranslated locales named");
for (const loc of ["fa", "he", "ur"]) {
  ok(new RegExp(`^${loc}\\s+UNTRANSLATED\\s+rtl→ltr`, "m").test(out), `${loc} is rtl in catalogue but held LTR`);
}
ok(/hi \(849 untranslated entries\)/.test(out), "Hindi's 849 untranslated catalogue entries are reported, not hidden");

console.log(`i18n-audit: ${n} assertions passed`);
