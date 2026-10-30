#!/usr/bin/env node
/**
 * openBIMstudio — gap-closure fixes (apply script).
 *
 *   node apply-fixes.mjs [projectRoot] [--dry-run] [--delete-restore-workflows]
 *
 * Idempotent, anchor-based edits in the style of scripts/install-bim-gaps.mjs.
 * Nothing is changed if an anchor is not found; the script says so instead of
 * guessing. Line endings (CRLF/LF) and BOMs are preserved.
 *
 *   1. src/workers/clash.worker.ts        cancellation actually takes effect:
 *                                         the loop yielded with Promise.resolve()
 *                                         (a microtask), so the worker never read
 *                                         the "cancel" message until the run was
 *                                         over. It now yields a macrotask.
 *   2. src/features/clash-worker-client.ts  an abort rejects immediately with
 *                                         AbortError and drops the pending entry,
 *                                         instead of waiting for the worker.
 *   3. src/critical-gaps-boot.ts          starts setupBimGaps() (it was never
 *                                         called, so rooms/stairs/roofs/visibility
 *                                         tools and the authored IFC export did
 *                                         not start).
 *   4. scripts/install-bim-gaps.mjs       the installer hook called setupBIMGaps
 *                                         (wrong case) which silently no-ops via
 *                                         optional call; now setupBimGaps.
 *   5. .github/workflows/restore-*.yml    (only with --delete-restore-workflows)
 *                                         one-shot manual workflows that roll
 *                                         src/main.ts back to an old commit.
 *
 * After applying:  npm run typecheck  &&  node scripts/ci-unit-tests.mjs
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const delWf = args.includes("--delete-restore-workflows");
const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const results = [];

function read(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  return { p, rel, bom, eol, text: body.replace(/\r\n/g, "\n") };
}
function write(f, text) {
  if (dry) return;
  fs.writeFileSync(f.p, (f.bom ? "\ufeff" : "") + text.replace(/\n/g, f.eol), "utf8");
}
/** fn(text) -> new text, or null when the anchor is missing. `done` = marker proving it is applied. */
function patch(rel, name, done, fn) {
  const f = read(rel);
  if (!f) return results.push({ name, state: "SKIPPED", why: `${rel} not found` });
  if (f.text.includes(done)) return results.push({ name, state: "already applied" });
  const next = fn(f.text);
  if (!next || next === f.text) return results.push({ name, state: "NOT PATCHED", why: "anchor not found - apply by hand" });
  write(f, next);
  results.push({ name, state: dry ? "would patch" : "patched" });
}

// 1. worker: yield a macrotask so the "cancel" message can be delivered
patch("src/workers/clash.worker.ts", "worker cancel yield", "yieldToEventLoop", (t) => {
  const anchor = "const cancelled = new Set<string>();\n";
  const yieldLine = "        yield: () => Promise.resolve(),";
  if (!t.includes(anchor) || !t.includes(yieldLine)) return null;
  const helper =
    anchor +
    "\n" +
    "/**\n" +
    " * Yield a macrotask (not a microtask) so the worker's event loop can deliver\n" +
    " * a pending \"cancel\" message while a run is in progress. Promise.resolve()\n" +
    " * only yields a microtask, which never lets message events through.\n" +
    " */\n" +
    "function yieldToEventLoop(): Promise<void> {\n" +
    "  return new Promise<void>((resolve) => setTimeout(resolve, 0));\n" +
    "}\n";
  return t.replace(anchor, helper).replace(yieldLine, "        yield: yieldToEventLoop,");
});

// 2. client: abort rejects immediately
patch("src/features/clash-worker-client.ts", "client abort rejects", "Clash cancelled\", \"AbortError\"));\n      }\n    };", (t) => {
  const a = "    const onAbort = (): void => sendCancel();\n";
  const b = "        if (isCancelled(signal)) sendCancel();\n";
  if (!t.includes(a) || !t.includes(b)) return null;
  const onAbort =
    "    const onAbort = (): void => {\n" +
    "      sendCancel();\n" +
    "      // Reject now instead of waiting for the worker; late worker messages\n" +
    "      // for this request are ignored because the pending entry is gone.\n" +
    "      const p = pending.get(requestId);\n" +
    "      if (p) {\n" +
    "        pending.delete(requestId);\n" +
    "        p.reject(new DOMException(\"Clash cancelled\", \"AbortError\"));\n" +
    "      }\n" +
    "    };\n";
  return t.replace(a, onAbort).replace(b, "        if (isCancelled(signal)) onAbort();\n");
});

// 3. boot: actually start bim-gaps
patch("src/critical-gaps-boot.ts", "boot hook", "openbim-bim-gaps:v1", (t) => {
  const re = /^([ \t]*)console\.log\("\[critical-gaps-boot\] all critical gaps wired"\);/m;
  const m = re.exec(t);
  if (!m) return null;
  const i = m[1];
  const block =
    `${i}// Rooms, stairs/railings/ramps/curtain walls/roofs/ceilings, visibility, authored IFC export.\n` +
    `${i}await safe("bim-gaps", async () => { // openbim-bim-gaps:v1\n` +
    `${i}  const m: Any = await import("./modules/bim-gaps/bim-gaps-boot");\n` +
    `${i}  await m.setupBimGaps?.();\n` +
    `${i}});\n\n`;
  return t.slice(0, m.index) + block + t.slice(m.index);
});

// 4. installer typo (the installer's own marker check keeps it idempotent)
{
  const rel = "scripts/install-bim-gaps.mjs";
  const f = read(rel);
  if (!f) results.push({ name: "installer typo", state: "SKIPPED", why: `${rel} not found` });
  else if (!f.text.includes("setupBIMGaps")) results.push({ name: "installer typo", state: "already applied" });
  else { write(f, f.text.replaceAll("setupBIMGaps", "setupBimGaps")); results.push({ name: "installer typo", state: dry ? "would patch" : "patched" }); }
}

// 5. stale one-shot workflows (opt-in)
for (const wf of ["restore-main.yml", "restore-ribbon.yml"]) {
  const p = path.join(root, ".github/workflows", wf);
  if (!delWf) { results.push({ name: `delete ${wf}`, state: "skipped (pass --delete-restore-workflows)" }); continue; }
  if (!fs.existsSync(p)) { results.push({ name: `delete ${wf}`, state: "already gone" }); continue; }
  if (!dry) fs.rmSync(p);
  results.push({ name: `delete ${wf}`, state: dry ? "would delete" : "deleted" });
}

console.log((dry ? "[dry run] " : "") + "openBIMstudio fixes in " + root);
for (const r of results) console.log(`  ${r.state.padEnd(30)} ${r.name}${r.why ? "  - " + r.why : ""}`);
if (results.some((r) => r.state === "NOT PATCHED" || r.state === "SKIPPED")) process.exitCode = 2;
else console.log("Done. Now run: npm run typecheck && node scripts/ci-unit-tests.mjs");
