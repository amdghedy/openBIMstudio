// Sign-in crash fix — keyboard handler + email validation drift-guard test.
//
// User report: typing into the Sign in dialog threw
//   "Unhandled error: Cannot read properties of undefined (reading 'toLowerCase')"
//   at walk-mode-*.js  (the global capture-phase keyup handler `onKeyUp`).
//
// Root cause: setupWalkMode registers window-level key listeners for the whole
// session; onKeyUp lacked the enabled check AND any guard for synthetic events
// whose `key` is undefined (password managers / IMEs / extensions dispatch them).
//
// This suite guards:
//   1. walk-mode.ts — onKeyUp mirrors onKeyDown's enabled check and tolerates
//      key === undefined in BOTH handlers.
//   2. The other site-wide keyboard handlers (global-undo, shortcuts, accudraw,
//      clash-review, saved-views) never call .toLowerCase() on a raw e.key.
//   3. cloud-account.ts — the auth dialog pre-validates the email client-side
//      (mirrors the server's validEmail rule) with a friendly inline message.
//   4. worker/auth.ts still validates email server-side (uniform, no enumeration).
const fs = require("fs"), path = require("path"), assert = require("assert");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const walk = read("src", "features", "walk-mode.ts");
const undo = read("src", "features", "global-undo.ts");
const shortcuts = read("src", "features", "shortcuts.ts");
const accudraw = read("src", "features", "accudraw.ts");
const clash = read("src", "features", "clash-review.ts");
const views = read("src", "features", "saved-views.ts");
const acct = read("src", "features", "cloud-account.ts");
const auth = read("worker", "auth.ts");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const ciList = fs.readFileSync(path.join(__dirname, "..", "scripts", "ci-unit-tests.mjs"), "utf8");

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const src = (text, startMarker, endMarker) => {
  const i = text.indexOf(startMarker);
  assert.ok(i >= 0, "marker not found: " + startMarker);
  return text.slice(i, text.indexOf(endMarker, i) + endMarker.length);
};

// ── 1. walk-mode: the reported crash site ──
t("walk-mode: onKeyUp has the enabled check (registered site-wide for the session)", () => {
  const fn = src(walk, "function onKeyUp(e: KeyboardEvent) {", "}");
  assert.ok(/if \(!state\.enabled\) return;/.test(fn), "onKeyUp must bail when walk mode is disabled");
});

t("walk-mode: onKeyUp + onKeyDown tolerate key === undefined", () => {
  const up = src(walk, "function onKeyUp(e: KeyboardEvent) {", "}");
  assert.ok(/\(e\.key \?\? ""\)\.toLowerCase\(\)/.test(up), "onKeyUp must use (e.key ?? \"\")");
  assert.ok(/if \(!k\) return;/.test(up), "onKeyUp must bail on empty key");
  const down = src(walk, "function onKeyDown(e: KeyboardEvent) {", "\n  // Modifier combos");
  assert.ok(/\(e\.key \?\? ""\)\.toLowerCase\(\)/.test(down), "onKeyDown must use (e.key ?? \"\")");
  assert.ok(/if \(!k\) return;/.test(down), "onKeyDown must bail on empty key");
});

t("walk-mode: raw e.key.toLowerCase() is gone from both handlers", () => {
  const region = walk.slice(walk.indexOf("function onKeyDown"), walk.indexOf("function onPointerMove"));
  assert.ok(!/[^)]e\.key\.toLowerCase\(\)/.test(region.replace(/\(e\.key \?\? ""\)\.toLowerCase\(\)/g, "")),
    "raw e.key.toLowerCase() must not remain in walk-mode keyboard handlers");
});

// ── 2. sibling global keyboard handlers ──
t("global-undo + shortcuts: guarded key read (no raw e.key.length crash)", () => {
  for (const [name, text] of [["global-undo", undo], ["shortcuts", shortcuts]]) {
    assert.ok(!/e\.key\.length === 1/.test(text), name + " still uses raw e.key.length");
    assert.ok(/\(e\.key \?\? ""\)\.toLowerCase\(\)/.test(text), name + " missing (e.key ?? \"\") guard");
  }
});

t("accudraw + clash-review + saved-views: guarded key read", () => {
  assert.ok(/\(e\.key \?\? ""\)\.toLowerCase\(\)/.test(accudraw), "accudraw missing (e.key ?? \"\") guard");
  assert.ok(/\(e\.key \?\? ""\)\.toLowerCase\(\)/.test(clash), "clash-review missing (e.key ?? \"\") guard");
  assert.ok(/\(e\.key \?\? ""\)\.toLowerCase\(\) === "v"/.test(views), "saved-views ctrl+shift+v check must guard e.key");
});

// ── 3. sign-in dialog: friendly client-side email pre-check ──
t("cloud-account: auth dialog pre-validates the email format inline", () => {
  const fn = src(acct, "async function doSubmit(): Promise<void> {", "await api<{ ok: true }>");
  assert.ok(/Enter a valid email address/.test(fn), "friendly inline email message missing");
  assert.ok(/\/\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\{2,\}\$\//.test(fn), "email format regex missing in doSubmit");
  assert.ok(/emailInput\.value\.trim\(\)/.test(fn), "email must be trimmed before validation");
});

t("cloud-account: register + login payloads use the validated email", () => {
  const fn = src(acct, "async function doSubmit(): Promise<void> {", "await refreshAccountState()");
  assert.ok(/\{ email, password: passInput\.value, name: nameInput\.value \}/.test(fn), "register payload must reuse the validated email");
  assert.ok(/\{ email, password: passInput\.value \}/.test(fn), "login payload must reuse the validated email");
});

// ── 4. server side still validates (defense in depth, no enumeration) ──
t("worker/auth: register rejects invalid email; login keeps uniform error", () => {
  assert.ok(/function validEmail\(email: string\): boolean \{/.test(auth), "server validEmail missing");
  assert.ok(/if \(!validEmail\(email\)\) return json\(\{ error: "Enter a valid email address\." \}, 400\);/.test(auth), "register email validation missing");
  assert.ok(/return json\(\{ error: "Wrong email or password\." \}, 401\);/.test(auth), "uniform login error missing");
});

// ── 5. CI registration ──
t("test is registered in package.json and ci-unit-tests.mjs", () => {
  assert.ok(pkg.scripts["test:walk-key-guard"], "package.json script test:walk-key-guard missing");
  assert.ok(ciList.includes("test:walk-key-guard"), "ci-unit-tests.mjs must run test:walk-key-guard");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
