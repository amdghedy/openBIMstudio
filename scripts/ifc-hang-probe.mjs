#!/usr/bin/env node
/**
 * Which structural corruption classes make web-ifc hang? (issue #231)
 * Applies ONE targeted corruption per run to valid corpus files, feeds the bytes to web-ifc
 * WITHOUT the application pre-flight, in an isolated child, and records ok / typed-error / hang.
 * Hanging cases are then minimised by line-wise delta debugging so they can be checked in as
 * regression fixtures. Env: PROBE_TIMEOUT_MS (8000), PROBE_OUT (probe-artifacts).
 */
import { spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const root = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(root, "../tests/fixtures/ifc-corpus");
const CHILD = join(root, "fuzz-child.mjs");
const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS ?? 8000);
const OUT = process.env.PROBE_OUT ?? "probe-artifacts";
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "obs-probe-"));

function run(bytes, timeout = TIMEOUT) {
  return new Promise((res) => {
    const f = join(tmp, "p.ifc"); writeFileSync(f, bytes);
    const c = spawn(process.execPath, ["--max-old-space-size=256", CHILD, f], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "", t, started = false;
    const arm = (ms) => { clearTimeout(t); t = setTimeout(() => { c.kill("SIGKILL"); }, ms); };
    arm(30000); // init
    c.stdout.on("data", (d) => { out += d; if (!started && out.includes("ready")) { started = true; arm(timeout); } });
    c.on("close", () => { clearTimeout(t); res(out.includes("ok") ? "ok" : out.includes("typed-error") ? "typed-error" : started ? (out.includes("opened") ? "hang-GetModelSchema" : "hang-OpenModel") : "startup-failure"); });
  });
}

const L = (b) => b.toString("latin1").split("\n");
const J = (lines) => Buffer.from(lines.join("\n"), "latin1");
const dataIdx = (lines) => lines.findIndex((l) => l.trim() === "DATA;") + 1;
const firstWith = (lines, re, from = 0) => { for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i; return -1; };

const CLASSES = {
  "non-ascii-outside-string": (b) => { const l = L(b), i = dataIdx(l) + 2; l[i] = l[i].replace("=", "=é"); return J(l); },
  "control-byte": (b) => { const l = L(b), i = dataIdx(l) + 2; l[i] = l[i].replace("=", "=\u0001"); return J(l); },
  "unterminated-string": (b) => { const l = L(b), i = firstWith(l, /'[^']*'/, dataIdx(l)); l[i] = l[i].replace(/'([^']*)'/, "'$1"); return J(l); },
  "unterminated-comment": (b) => { const l = L(b), i = dataIdx(l); l.splice(i, 0, "/* never closed"); return J(l); },
  "unbalanced-open": (b) => { const l = L(b), i = dataIdx(l) + 2; l[i] = l[i].replace(/\);\s*$/, ";"); return J(l); },
  "unbalanced-close": (b) => { const l = L(b), i = dataIdx(l) + 2; l[i] = l[i].replace(/\);\s*$/, "));"); return J(l); },
  "missing-terminator": (b) => J(L(b).filter((x) => !x.startsWith("END-ISO-10303-21"))),
  "truncated-mid-record": (b) => b.subarray(0, Math.floor(b.length * 0.6)),
  "record-without-id": (b) => { const l = L(b), i = dataIdx(l) + 2; l[i] = l[i].replace(/^#\d+/, ""); return J(l); },
  "semicolon-in-parens": (b) => { const l = L(b), i = dataIdx(l) + 2; l[i] = l[i].replace("(", "(;"); return J(l); },
  "random-garbage-line": (b) => { const l = L(b), i = dataIdx(l) + 3; l.splice(i, 0, "%$&@!~^|\\\\"); return J(l); },
  "bit7-flip-in-keyword": (b) => { const o = Buffer.from(b); const i = b.indexOf("IFCWALL"); const j = i > 0 ? i : b.indexOf("IFC", b.indexOf("DATA;")); o[j + 3] |= 0x80; return o; },
};

async function minimise(bytes) {
  let lines = L(bytes);
  const lo = dataIdx(lines);
  let n = 2, tries = 0;
  const hangs = async (ls) => (await run(J(ls), 5000)).startsWith("hang");
  while (lines.length - lo > 4 && tries < 40) {
    const chunk = Math.ceil((lines.length - lo) / n);
    let reduced = false;
    for (let s = lo; s < lines.length && tries < 40; s += chunk) {
      const cand = lines.slice(0, s).concat(lines.slice(s + chunk));
      tries++;
      if (await hangs(cand)) { lines = cand; reduced = true; n = Math.max(n - 1, 2); break; }
    }
    if (!reduced) { if (n >= lines.length - lo) break; n = Math.min(n * 2, lines.length - lo); }
  }
  return J(lines);
}

const seeds = ["generated-small.ifc", "mep-model.ifc", "generated-2x3.ifc"];
const report = [];
for (const seed of seeds) {
  const src = readFileSync(join(CORPUS, seed));
  const base = await run(src);
  report.push({ seed, cls: "(unmodified)", result: base });
  for (const [cls, fn] of Object.entries(CLASSES)) {
    let bytes; try { bytes = fn(src); } catch (e) { report.push({ seed, cls, result: "mutator-failed" }); continue; }
    const result = await run(bytes);
    report.push({ seed, cls, result });
    console.log(`${seed.padEnd(22)} ${cls.padEnd(28)} ${result}`);
    if (result.startsWith("hang")) writeFileSync(join(OUT, `${seed}.${cls}.ifc`), bytes);
  }
}
// The checked-in minimal regression fixtures must really be the problem inputs (raw, no pre-flight).
import { readdirSync } from "fs";
const MAL = join(CORPUS, "malformed");
for (const f of readdirSync(MAL).filter((x) => x.endsWith(".ifc"))) {
  const result = await run(readFileSync(join(MAL, f)));
  report.push({ seed: `malformed/${f}`, cls: "(fixture, raw)", result });
  console.log(`malformed/${f.padEnd(34)} raw web-ifc: ${result}`);
}
const hangClasses = [...new Set(report.filter((r) => r.result.startsWith("hang")).map((r) => r.cls))];
for (const cls of hangClasses) {
  const r = report.find((x) => x.cls === cls && x.result.startsWith("hang"));
  const min = await minimise(readFileSync(join(OUT, `${r.seed}.${cls}.ifc`)));
  writeFileSync(join(OUT, `MIN.${cls}.ifc`), min);
  console.log(`minimised ${cls}: ${min.length} bytes`);
}
writeFileSync(join(OUT, "report.json"), JSON.stringify({ timeoutMs: TIMEOUT, report, hangClasses }, null, 1));
console.log("hang classes:", JSON.stringify(hangClasses));
