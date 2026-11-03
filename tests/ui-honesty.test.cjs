// Guards against UI that pretends to work: toasts that tell the user to use the
// developer console, and fabricated marketplace statistics.
const fs = require("fs");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  PASS " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); } };

const ribbon = fs.readFileSync("src/shell/ribbon.ts", "utf8");
const toasts = [...ribbon.matchAll(/toast\(\s*([`"'])((?:\\.|(?!\1)[\s\S])*)\1/g)].map((m) => m[2]);
const bad = toasts.filter((t) => /__obs[A-Za-z]+/.test(t) || (/console/i.test(t) && !/failed/i.test(t)));
ok("ribbon toasts never point users at the console or __obs* globals", bad.length === 0, bad.join(" | "));

const market = fs.readFileSync("src/modules/plugin-marketplace/types.ts", "utf8");
ok("plugin marketplace has no fabricated downloads/ratings", !/downloads\s*:|rating\s*:/.test(market));

const sweeps = fs.readFileSync("src/features/authoring.ts", "utf8");
ok("wall builder renders params.sweeps", /attachWallSweeps\(mesh, el\)/.test(sweeps));

// No blocking browser dialogs: alert() is gone; prompt()/confirm() may only decrease (ratchet).
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d + "/" + e.name) : /\.ts$/.test(e.name) ? [d + "/" + e.name] : []);
const srcFiles = walk("src").filter((f) => !/form-modal\.ts$|core\/notify\.ts$/.test(f));
let alerts = 0, blocking = 0;
for (const f of srcFiles) {
  const t = fs.readFileSync(f, "utf8");
  alerts += (t.match(/(^|[^.\w])(window\.)?alert\(/gm) || []).length;
  blocking += (t.match(/(^|[^.\w])(window\.)?(prompt|confirm)\(/gm) || []).length;
}
ok("no blocking alert() calls in src (use uiAlert / notify)", alerts === 0, alerts + " found");
const BASELINE = 101;
ok("prompt()/confirm() count does not grow (baseline " + BASELINE + ", now " + blocking + ")", blocking <= BASELINE, "convert new ones to form-modal promptLine/confirmDialog");
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
