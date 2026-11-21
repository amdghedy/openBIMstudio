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

// Item 15: the report carries coverage % per language, the dead-key
// report, and the CSS-fragment-key count (not just the gates).
ok(/coverage/.test(out), "report has a coverage column");
ok(/^ar\s+translated\s+rtl→rtl\s+86\s+4\s+3431\s+73\s+yes\s+97\.9%/m.test(out), "ar coverage is 97.9%");
ok(/^hi\s+translated\s+ltr→ltr\s+15\s+4\s+3431\s+849\s+yes\s+75\.3%/m.test(out), "hi coverage is 75.3%");
ok(/css-fragment keys: 0 in all catalogues/.test(out), "CSS-fragment keys reported (0)");
ok(/dead-key report \(JSON namespaces with no call site in src\/ — kept, key migration pending\): app \(17 keys\), clash \(32 keys\), authoring \(9 keys\), camera \(4 keys\), cost \(6 keys\), options \(6 keys\)/.test(out), "dead-key report names the six dead namespaces");

// The stale-key diff (Gate 2) names added/removed/changed keys: exercise
// the exported pure helper directly.
const diffProbe = spawnSync("node", ["--input-type=module", "-e",
  `import { diffGenEntries } from "file://${path.join(root, "scripts", "i18n-audit.mjs").replace(/\\/g, "/")}";` +
  ` const d = diffGenEntries({ x: "1", y: "2", z: "3" }, { x: "1", y: "CHANGED", w: "4" });` +
  ` if (JSON.stringify(d.added) !== '["w"]' || JSON.stringify(d.removed) !== '["z"]' || JSON.stringify(d.changed) !== '["y"]') { console.error("diff mismatch", d); process.exit(1); }`,
], { encoding: "utf8" });
ok(diffProbe.status === 0, `diffGenEntries names added/removed/changed keys:\n${diffProbe.stdout}\n${diffProbe.stderr}`);

console.log(`i18n-audit: ${n} assertions passed`);
