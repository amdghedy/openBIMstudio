#!/usr/bin/env node
/**
 * BCF parser fuzz — invalid/incomplete markup.bcf handling gate.
 *
 * Mirrors scripts/fuzz-ifc-corpus.mjs: mutates seed markup bytes and feeds
 * each buffer to parseBcfMarkup in an ISOLATED child process with a capped
 * V8 heap. The child reports "ready" after the compiled markup module loads;
 * the parser timeout then measures the parse only, not Node startup or the
 * tsc compile.
 *
 * Seeds: one conformant markup built by the real writer (buildBcfMarkup) and
 * one legacy-dialect markup (attributes + <Text> comments, as exported by
 * older builds) — the reader accepts both, so both are fuzzed.
 *
 * Scope note: the child tokenizes XML with the minimal shim in
 * ./fuzz-bcf-xml-shim.cjs (same code as tests/bcf21-roundtrip.test.cjs);
 * production uses the browser DOMParser. This leg therefore fuzzes the
 * markup *semantic* layer (topic/comment extraction, GUID validation, date
 * handling) against adversarial trees — not the browser's XML tokenizer.
 * The .bcfzip envelope itself (JSZip) is a third-party library and is not
 * fuzzed here.
 *
 * Outcomes:
 *   ok              — parse returned a topic with only finite numbers
 *   typed-error     — child threw a catchable JS Error (controlled failure)
 *   bad-output      — parse returned a topic containing a non-finite number
 *   timeout         — parser did not finish within CHILD_TIMEOUT_MS
 *   startup-timeout — Node/markup load did not finish within INIT_TIMEOUT_MS
 *   contained-crash — child died without a result token (OOM kill / abort)
 *
 * Gate fails when: contained-crash rate exceeds 35%, parser timeout rate
 * exceeds 30%, startup timeout rate exceeds 1%, any bad-output is recorded,
 * or no outcomes are recorded. Each mutation remains process-isolated.
 *
 * Env: FUZZ_ITER (default 60), FUZZ_SEED (default 42).
 *   FUZZ_KIND (default "mixed"): "mixed" alternates the two families;
 *   "bitflip" forces the raw bit-flip family only; "structural" forces
 *   structure-preserving XML mutations only.
 *   FUZZ_ARTIFACT_DIR: failing inputs + summary.json land here.
 *   FUZZ_INIT_TIMEOUT_MS (default 30000), FUZZ_CHILD_TIMEOUT_MS (default 8000).
 */
import { spawn, execSync } from "child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));
const REPO = join(root, "..");
const CHILD = join(root, "fuzz-bcf-child.cjs");
const ITER = Math.max(1, Number(process.env.FUZZ_ITER) || 60);
const SEED = Number(process.env.FUZZ_SEED) || 42;
const KIND = (process.env.FUZZ_KIND || "mixed").toLowerCase();
if (!["mixed", "bitflip", "structural"].includes(KIND)) {
  console.error(`fuzz-bcf: FUZZ_KIND must be mixed, bitflip or structural (got ${process.env.FUZZ_KIND})`);
  process.exit(2);
}
const ARTIFACT_DIR = process.env.FUZZ_ARTIFACT_DIR ? resolve(process.cwd(), process.env.FUZZ_ARTIFACT_DIR) : null;
const INIT_TIMEOUT_MS = Math.max(1, Number(process.env.FUZZ_INIT_TIMEOUT_MS) || 30000);
const CHILD_TIMEOUT_MS = Math.max(1, Number(process.env.FUZZ_CHILD_TIMEOUT_MS) || 8000);
const TIMEOUT_RATE_MAX = 0.3;
const STARTUP_TIMEOUT_RATE_MAX = 0.01;
const CRASH_RATE_MAX = 0.35;

// Deterministic LCG so CI failures are reproducible (same stream as the IFC fuzzer).
let state = SEED >>> 0;
function rand(n) {
  state = (1103515245 * state + 12345) & 0x7fffffff;
  return state % n;
}

const tmp = mkdtempSync(join(tmpdir(), "obs-fuzz-bcf-"));
// Compile the real markup module once (same invocation as tests/bcf21-roundtrip.test.cjs).
symlinkSync(join(REPO, "node_modules"), join(tmp, "node_modules"), "junction");
execSync(
  `npx tsc src/modules/issues/bcf-markup.ts --outDir ${tmp} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`,
  { stdio: "pipe", cwd: REPO },
);
const MARKUP = ["modules/issues/bcf-markup.js", "bcf-markup.js"]
  .map((p) => join(tmp, p))
  .find((p) => existsSync(p));
if (!MARKUP) {
  console.error("fuzz-bcf: expected compiled module (bcf-markup.js) under the tsc outDir");
  process.exit(1);
}
const { buildBcfMarkup } = require(MARKUP);

const T0 = Date.parse("2026-03-05T10:20:30Z");
const T1 = Date.parse("2026-03-06T11:21:32Z");
const T2 = Date.parse("2026-03-10T09:00:00Z");
const CONFORMANT_SEED = buildBcfMarkup({
  guid: "9b2f4c1e-1111-4222-8333-444455556666",
  topicType: "Issue",
  topicStatus: "In Progress",
  title: "Duct runs through wall",
  priority: "High",
  labels: ["Envelope", "MEP"],
  createdAt: T0,
  createdBy: "Ada Arch",
  modifiedAt: T1,
  modifiedBy: "Bob MEP",
  dueDate: T2,
  assignedTo: "Cara Str",
  description: "Clash description with quotes & angles",
  comments: [
    { guid: "aa2f4c1e-1111-4222-8333-444455556666", author: "Bob MEP", date: T1, text: "Confirmed on site — needs offset" },
    { guid: "bb2f4c1e-1111-4222-8333-444455556666", author: "Ada Arch", date: T2, text: "Wall moved 150mm" },
  ],
});
// Legacy dialect (pre-shared-module writer): fields on attributes, <Text> comments.
const LEGACY_SEED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Markup>',
  '  <Header><File IfcProject="0" IfcSpatialStructureElement="1" isExternal="false"><Filename>model.ifc</Filename><Date>2026-03-05T10:20:30Z</Date></File></Header>',
  '  <Topic Guid="9b2f4c1e-1111-4222-8333-444455556666" TopicType="Issue" TopicStatus="Open" Title="Legacy clash" Priority="Low" CreationDate="2026-03-05T10:20:30Z" CreationAuthor="Ada Arch" ModifiedDate="2026-03-06T11:21:32Z" ModifiedAuthor="Bob MEP" DueDate="2026-03-10T09:00:00Z" AssignedTo="Cara Str">',
  '    <DescriptionText>Legacy description</DescriptionText>',
  '    <Comment Guid="aa2f4c1e-1111-4222-8333-444455556666" Date="2026-03-06T11:21:32Z" Author="Bob MEP"><Text>Legacy comment</Text></Comment>',
  "  </Topic>",
  "</Markup>",
  "",
].join("\n");

const seeds = [
  { name: "conformant.bcf", bytes: Buffer.from(CONFORMANT_SEED, "utf8") },
  { name: "legacy.bcf", bytes: Buffer.from(LEGACY_SEED, "utf8") },
];
if (ARTIFACT_DIR) mkdirSync(ARTIFACT_DIR, { recursive: true });

function runChild(bytes) {
  return new Promise((resolve) => {
    const file = join(tmp, "buf.bcf");
    writeFileSync(file, bytes);
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=256", CHILD, MARKUP, file],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let stage = "startup";
    let timedOutStage = null;
    let timer;

    const armTimeout = (ms, timeoutStage) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOutStage = timeoutStage;
        child.kill("SIGKILL");
      }, ms);
    };

    armTimeout(INIT_TIMEOUT_MS, "startup");
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (stage === "startup" && out.includes("ready")) {
        stage = "parse";
        armTimeout(CHILD_TIMEOUT_MS, "parse");
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (out.includes("ok")) resolve({ outcome: "ok" });
      else if (out.includes("bad-output")) resolve({ outcome: "bad-output", detail: out.match(/bad-output:(\S+)/)?.[1] ?? null });
      else if (out.includes("typed-error")) resolve({ outcome: "typed-error" });
      else if (timedOutStage === "startup") resolve({ outcome: "startup-timeout" });
      else if (timedOutStage === "parse") resolve({ outcome: "timeout" });
      else resolve({ outcome: "contained-crash", code, signal });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ outcome: "contained-crash", code: -1, signal: null });
    });
  });
}

const POISON_STRINGS = [
  "NaN", "Infinity", "1e999", "not-a-guid", "issue-1", "x".repeat(400),
  "2026-13-45T99:99:99Z", "&undefined;", "&#xD800;", "]]>", "--", "<![CDATA[unclosed",
  "9b2f4c1e-1111-4222-8333-444455556666",
];

/** XML-level mutations on the markup text. */
function structuralMutate(srcBytes) {
  const text = srcBytes.toString("latin1");
  const lines = text.split("\n");
  const op = rand(10);
  if (op === 0) return Buffer.from(lines.slice(0, 1 + rand(lines.length - 1)).join("\n"), "latin1"); // truncate
  if (op === 1) { for (let i = 0; i < 1 + rand(4); i++) lines.splice(rand(lines.length), 1); } // delete lines
  if (op === 2) { // duplicate a random line (duplicated Topic/Comment blocks)
    const at = rand(lines.length);
    lines.splice(at, 0, lines[at]);
  }
  if (op === 3) { // poison an attribute value or text run
    const at = rand(lines.length);
    lines[at] = lines[at].replace(/"[^"]*"/, `"${POISON_STRINGS[rand(POISON_STRINGS.length)]}"`);
  }
  if (op === 4) { // drop a closing tag (mismatched / unclosed nesting)
    const closers = lines.map((l, i) => (l.includes("</") ? i : -1)).filter((i) => i >= 0);
    if (closers.length) lines.splice(closers[rand(closers.length)], 1);
  }
  if (op === 5) { // deep nesting: wrap the Topic body in nested <Comment> elements
    const depth = 50 + rand(200);
    let open = "", close = "";
    for (let k = 0; k < depth; k++) { open += "<Comment>"; close = "</Comment>" + close; }
    const at = lines.findIndex((l) => l.includes("<Topic"));
    if (at >= 0) lines.splice(at + 1, 0, open);
    const end = lines.findIndex((l) => l.includes("</Topic>"));
    if (end >= 0) lines.splice(end, 0, close);
  }
  if (op === 6) { // comment flood: thousands of <Comment> blocks before </Topic>
    const flood = [];
    for (let i = 0; i < 1000 + rand(4000); i++) {
      flood.push(`<Comment Guid="aa2f4c1e-1111-4222-8333-44445555666${i % 10}"><Date>2026-03-06T11:21:32Z</Date><Author>Bot</Author><Comment>flood ${i}</Comment></Comment>`);
    }
    const end = lines.findIndex((l) => l.includes("</Topic>"));
    if (end >= 0) lines.splice(end, 0, ...flood);
    else lines.push(...flood);
  }
  if (op === 7) { // strip the XML declaration / prolog
    return Buffer.from(lines.filter((l) => !l.startsWith("<?xml")).join("\n"), "latin1");
  }
  if (op === 8) { // binary garbage spliced in
    const at = rand(text.length);
    const garbage = Buffer.from(Array.from({ length: 1 + rand(40) }, () => rand(256))).toString("latin1");
    return Buffer.from(text.slice(0, at) + garbage + text.slice(at), "latin1");
  }
  // entity / CDATA chaos in a text run
  const at = rand(lines.length);
  lines[at] = lines[at].replace(/>([^<]*)</, `>${POISON_STRINGS[rand(POISON_STRINGS.length)]}<`);
  return Buffer.from(lines.join("\n"), "latin1");
}

let ok = 0, typedError = 0, badOutput = 0, containedCrash = 0, timeout = 0, startupTimeout = 0;
const byKind = {};
const timeoutsBySeed = {};
const failures = [];

for (let i = 0; i < ITER; i++) {
  const src = seeds[rand(seeds.length)];
  const kind = KIND === "mixed" ? (rand(1000) < 500 ? "bitflip" : "structural") : KIND; // not rand(2): the LCG low bit has a period of 2
  let bytes;
  if (kind === "bitflip") {
    bytes = Buffer.from(src.bytes);
    const nMut = 8 + rand(17);
    for (let k = 0; k < nMut; k++) {
      const pos = rand(bytes.length);
      bytes[pos] ^= 1 << rand(8);
    }
  } else {
    bytes = structuralMutate(src.bytes);
  }
  const r = await runChild(bytes);
  byKind[kind] = byKind[kind] || { n: 0, ok: 0, typed: 0, badOutput: 0, timeout: 0, crash: 0 };
  byKind[kind].n++;
  if (r.outcome === "ok") { ok++; byKind[kind].ok++; }
  else if (r.outcome === "typed-error") { typedError++; byKind[kind].typed++; }
  else if (r.outcome === "bad-output") { badOutput++; byKind[kind].badOutput++; }
  else if (r.outcome === "timeout") { timeout++; byKind[kind].timeout++; timeoutsBySeed[src.name] = (timeoutsBySeed[src.name] || 0) + 1; }
  else if (r.outcome === "startup-timeout") { startupTimeout++; byKind[kind].crash++; }
  else { containedCrash++; byKind[kind].crash++; }

  if (["timeout", "startup-timeout", "contained-crash", "bad-output"].includes(r.outcome)) {
    console.warn(`fuzz-bcf: ${r.outcome} at iteration ${i} (seed ${src.name}, kind ${kind})${r.detail ? ` at ${r.detail}` : ""} — bounded by harness kill`);
    const failure = { iteration: i, seed: src.name, kind, outcome: r.outcome, detail: r.detail ?? null, code: r.code ?? null, signal: r.signal ?? null };
    failures.push(failure);
    if (ARTIFACT_DIR) writeFileSync(join(ARTIFACT_DIR, `failure-${String(i).padStart(4, "0")}.bcf`), bytes);
  }
}

rmSync(tmp, { recursive: true, force: true });

const total = ok + typedError + badOutput + containedCrash + timeout + startupTimeout;
if (ARTIFACT_DIR) {
  writeFileSync(join(ARTIFACT_DIR, "summary.json"), JSON.stringify({
    format: "bcf", seed: SEED, iterations: ITER, kind: KIND, total, ok, typedError, badOutput, preflightRejected: 0, containedCrash, timeout, startupTimeout, timeoutsByOp: {}, timeoutsBySeed, byKind, failures,
  }, null, 2) + "\n");
}
console.log(`fuzz-bcf: outcomes by mutation kind ${JSON.stringify(byKind)}`);
console.log(`fuzz-bcf: timeouts by seed ${JSON.stringify(timeoutsBySeed)}`);
console.log(`fuzz-bcf: ${ITER} mutations over ${seeds.length} seeds — ok: ${ok}, typed-error: ${typedError}, bad-output: ${badOutput}, parser-timeout: ${timeout}, startup-timeout: ${startupTimeout}, contained-crash: ${containedCrash}`);

let failed = false;
if (total === 0) {
  console.error("fuzz-bcf: no outcomes recorded — corpus or parser broken");
  failed = true;
}
const crashRate = containedCrash / Math.max(1, total);
const timeoutRate = timeout / Math.max(1, total);
const startupTimeoutRate = startupTimeout / Math.max(1, total);
if (crashRate > CRASH_RATE_MAX) {
  console.error(`fuzz-bcf: contained-crash rate ${(crashRate * 100).toFixed(0)}% exceeds the ${(CRASH_RATE_MAX * 100).toFixed(0)}% baseline — parser robustness regressed`);
  failed = true;
}
if (timeoutRate > TIMEOUT_RATE_MAX) {
  console.error(`fuzz-bcf: parser timeout rate ${(timeoutRate * 100).toFixed(0)}% exceeds ${(TIMEOUT_RATE_MAX * 100).toFixed(0)}% — pathological grind on adversarial input`);
  failed = true;
}
if (startupTimeoutRate > STARTUP_TIMEOUT_RATE_MAX) {
  console.error(`fuzz-bcf: startup timeout rate ${(startupTimeoutRate * 100).toFixed(0)}% exceeds ${(STARTUP_TIMEOUT_RATE_MAX * 100).toFixed(0)}% — Node/markup initialization is unstable`);
  failed = true;
}
if (badOutput > 0) {
  console.error(`fuzz-bcf: ${badOutput} parse(s) returned non-finite values — the parsed-topic invariant is broken`);
  failed = true;
}
process.exit(failed ? 1 : 0);
