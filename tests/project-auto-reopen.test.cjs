/**
 * tests/project-auto-reopen.test.cjs
 *
 * Unit tests for boot-time auto-reopen of the last opened project
 * (src/modules/projects/auto-reopen.ts).
 *
 * Pins the project-persistence fix: a fresh boot no longer enters an empty
 * session when a saved project exists — the last opened project is reopened
 * through the normal pipeline, and stale pointers are cleared silently.
 *
 * Run: `node tests/project-auto-reopen.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let pass = 0;
let fail = 0;
const pending = [];
function t(name, fn) {
  if (fn.constructor.name === "AsyncFunction") { pending.push({ name, fn }); return; }
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); fail++; }
}
async function runAsync() {
  for (const { name, fn } of pending) {
    try { await fn(); console.log(`  PASS ${name}`); pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); fail++; }
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

/* ── localStorage shim ──────────────────────────────────────────────── */
const lsStore = new Map();
globalThis.localStorage = {
  setItem: (k, v) => lsStore.set(String(k), String(v)),
  getItem: (k) => (lsStore.has(String(k)) ? lsStore.get(String(k)) : null),
  removeItem: (k) => lsStore.delete(String(k)),
  clear: () => lsStore.clear(),
};

/* ── Compile the single module to CommonJS (no transitive graph) ────── */
const repoRoot = path.resolve(__dirname, "..");
const entry = path.join(repoRoot, "src/modules/projects/auto-reopen.ts");
const tmpOut = path.join(os.tmpdir(), "obs-autoreopen-" + Date.now());
fs.mkdirSync(tmpOut, { recursive: true });
execSync(
  `npx tsc ${JSON.stringify(entry)} --outDir ${JSON.stringify(tmpOut)} ` +
  `--module commonjs --target es2020 --lib es2020 --skipLibCheck --strict ` +
  `--ignoreDeprecations 5.0 --noResolve --noCheck`,
  { cwd: repoRoot, stdio: "pipe" },
);
const compiled = path.join(tmpOut, "auto-reopen.js");
const output = fs.readFileSync(compiled, "utf8");

/* ── Mocks ──────────────────────────────────────────────────────────── */
let openCalls = [];
let currentProject = null;
let docs = [];
let listDocsError = null;
const ctxMock = {
  ctx: {
    features: {
      projects: {
        getCurrentProject: () => currentProject,
        openProject: async (id) => { openCalls.push(id); },
      },
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../core/context") return ctxMock;
  if (request === "./store") {
    return {
      listProjectDocs: async () => {
        if (listDocsError) throw listDocsError;
        return docs;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const mod = new Module(compiled, module);
mod.filename = compiled;
mod.paths = Module._nodeModulePaths(path.dirname(compiled));
mod._compile(output, compiled);
const ar = mod.exports;

/* ── Pure decision ──────────────────────────────────────────────────── */
t("pickAutoReopenId: null when a project is already current", () => {
  assert(ar.pickAutoReopenId([{ id: "p1" }], "p1", true) === null, "must not reopen over a live session");
});
t("pickAutoReopenId: null without a recorded pointer", () => {
  assert(ar.pickAutoReopenId([{ id: "p1" }], null, false) === null, "no pointer → no reopen");
});
t("pickAutoReopenId: returns the id when the doc still exists", () => {
  assert(ar.pickAutoReopenId([{ id: "p1" }, { id: "p2" }], "p2", false) === "p2", "valid pointer → reopen");
});
t("pickAutoReopenId: null for a stale pointer (doc deleted)", () => {
  assert(ar.pickAutoReopenId([{ id: "p1" }], "gone", false) === null, "stale pointer → no reopen");
});
t("pickAutoReopenId: null on an empty store", () => {
  assert(ar.pickAutoReopenId([], "p1", false) === null, "empty store → no reopen");
});

/* ── Pointer helpers ────────────────────────────────────────────────── */
t("record/clear/readLastProjectId round-trips through localStorage", () => {
  assert(ar.readLastProjectId() === null, "starts empty");
  ar.recordLastProjectId("p9");
  assert(ar.readLastProjectId() === "p9", "recorded id readable");
  ar.clearLastProjectId();
  assert(ar.readLastProjectId() === null, "cleared id unreadable");
});

/* ── Boot hook behaviour ────────────────────────────────────────────── */
t("boot hook: no pointer → welcome screen stays, openProject untouched", async () => {
  openCalls = [];
  lsStore.clear();
  currentProject = null;
  docs = [{ id: "p1" }];
  const did = await ar.autoReopenLastProject();
  assert(did === false && openCalls.length === 0, `did=${did} calls=${openCalls.length}`);
});
t("boot hook: valid pointer + stored doc → reopen via openProject", async () => {
  openCalls = [];
  docs = [{ id: "p1" }, { id: "p2" }];
  ar.recordLastProjectId("p2");
  currentProject = null;
  const did = await ar.autoReopenLastProject();
  assert(did === true, "reports reopen attempted");
  assert(JSON.stringify(openCalls) === JSON.stringify(["p2"]), `opened ${openCalls}`);
});
t("boot hook: stale pointer cleared silently, no alert, no open", async () => {
  openCalls = [];
  docs = [{ id: "p1" }];
  ar.recordLastProjectId("ghost");
  currentProject = null;
  const did = await ar.autoReopenLastProject();
  assert(did === false, "no reopen");
  assert(openCalls.length === 0, "openProject not called for a stale id");
  assert(ar.readLastProjectId() === null, "stale pointer cleared");
});
t("boot hook: never runs over a live session", async () => {
  openCalls = [];
  docs = [{ id: "p1" }];
  ar.recordLastProjectId("p1");
  currentProject = { id: "p1" };
  const did = await ar.autoReopenLastProject();
  assert(did === false && openCalls.length === 0, `did=${did} calls=${openCalls.length}`);
  currentProject = null;
});
t("boot hook: service missing → false, no crash", async () => {
  const saved = ctxMock.ctx.features.projects;
  delete ctxMock.ctx.features.projects;
  ar.recordLastProjectId("p1");
  docs = [{ id: "p1" }];
  const did = await ar.autoReopenLastProject();
  ctxMock.ctx.features.projects = saved;
  assert(did === false, "must bail out without the service");
});
t("boot hook: storage failure → false, no crash, pointer preserved", async () => {
  openCalls = [];
  listDocsError = new Error("IndexedDB unavailable");
  docs = [{ id: "p1" }];
  ar.recordLastProjectId("p1");
  currentProject = null;
  const did = await ar.autoReopenLastProject();
  listDocsError = null;
  assert(did === false && openCalls.length === 0, `did=${did} calls=${openCalls.length}`);
  assert(ar.readLastProjectId() === "p1", "pointer kept for the next boot");
});

Module._load = originalLoad;
(async () => {
  await runAsync();
  if (fail) process.exit(1);
  console.log(`=== project-auto-reopen tests complete: ${pass} passed, ${fail} failed ===`);
})();
