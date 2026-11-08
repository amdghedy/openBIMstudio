// Forgot-password + remembered logins + Google popup — drift-guard test.
//
// Guards the three auth UX upgrades:
//   1. Forgot password: /api/auth/forgot issues a single-use SHA-256-stored
//      token (rate-limited), /api/auth/reset consumes it, updates the hash and
//      signs the user in; the worker emails the link when RESEND_API_KEY is
//      set and otherwise returns resetUrl for the UI to show inline.
//   2. Google popup flow: ?popup=1 → state=popup → the callback returns a
//      self-closing page that postMessages the opener; the client listens for
//      obs-oauth messages and falls back to the full-page redirect when the
//      popup is blocked; the top-level callback lands on /?signedin=1.
//   3. Remembered logins: the last emails live in localStorage and surface as
//      "Continue as" chips; sign-in/register/google success remembers them.
const fs = require("fs"), path = require("path"), assert = require("assert");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const auth = read("worker", "auth.ts");
const worker = read("worker", "index.ts");
const acct = read("src", "features", "cloud-account.ts");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const ciList = fs.readFileSync(path.join(__dirname, "..", "scripts", "ci-unit-tests.mjs"), "utf8");

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const src = (text, startMarker, endMarker) => {
  const i = text.indexOf(startMarker);
  assert.ok(i >= 0, "marker not found: " + startMarker);
  return text.slice(i, text.indexOf(endMarker, i) + endMarker.length);
};

// ── 1. worker: forgot + reset endpoints ──
t("auth.ts: DO routes forgot + reset", () => {
  assert.ok(auth.includes('path === "/api/auth/forgot" && request.method === "POST"'), "forgot route missing");
  assert.ok(auth.includes('path === "/api/auth/reset" && request.method === "POST"'), "reset route missing");
});

t("auth.ts: reset token is random 32 bytes, SHA-256-stored, 30-min TTL, single-use", () => {
  const fn = src(auth, "private async forgotPassword", "\n  /** Consumes a reset token");
  assert.ok(/new Uint8Array\(32\)/.test(fn), "token must be 32 random bytes");
  assert.ok(/rt:\$\{await sha256hex\(token\)\}/.test(fn), "token must be stored as SHA-256");
  assert.ok(/RESET_TTL_MS/.test(fn), "expiry must use RESET_TTL_MS");
  assert.ok(/FORGOT_MAX_PER_MIN/.test(fn), "forgot must be rate-limited");
  assert.ok(/user\.provider !== "password"/.test(fn), "google-only accounts must not get reset links");
  const reset = src(auth, "private async resetPassword", "\n  // ── project storage");
  assert.ok(/await this\.storage\.delete\(recordKey\)/.test(reset), "token must be burned (single-use)");
  assert.ok(/password\.length < 6/.test(reset), "reset must enforce the 6-char minimum");
  assert.ok(/sessionCookie\(session\)/.test(reset), "reset must sign the user in");
});

t("auth.ts: storage layout documents f: and rt: keys", () => {
  assert.ok(auth.includes("f:<email>:<minute>"), "forgot rate-limit key undocumented");
  assert.ok(auth.includes("rt:<sha256(token)>"), "reset token key undocumented");
  assert.ok(/POST \/api\/auth\/forgot/.test(auth), "forgot endpoint undocumented");
  assert.ok(/POST \/api\/auth\/reset/.test(auth), "reset endpoint undocumented");
});

t("auth.ts: sendResetEmail uses Resend only when RESEND_API_KEY exists", () => {
  const fn = src(auth, "export async function sendResetEmail", "\n/**\n * Tiny self-closing page");
  assert.ok(/if \(!env\.RESEND_API_KEY\) return false;/.test(fn), "must bail without RESEND_API_KEY");
  assert.ok(auth.includes("api.resend.com/emails"), "Resend API host missing");
});

// ── 2. worker: Google popup + forgot orchestration ──
t("auth.ts: google start carries state=popup; callback page postMessages + closes", () => {
  const start = src(auth, "export function googleStartUrl", "\n/**\n * Email the reset link");
  assert.ok(/popup \? "popup" : "app"/.test(start), "state must mark the popup flow");
  assert.ok(/prompt: "select_account"/.test(start), "select_account must stay (remembers previous accounts)");
  const cb = src(auth, "export function googlePopupCallbackPage", "\n/** Exchange the consent code");
  assert.ok(/window\.opener\.postMessage/.test(cb), "popup page must message the opener");
  assert.ok(/window\.close\(\)/.test(cb), "popup page must close itself");
  assert.ok(/obs-oauth/.test(cb), "popup message must use the obs-oauth type");
});

t("index.ts: forgot is orchestrated (mail when key set, resetUrl otherwise)", () => {
  const fn = src(worker, 'url.pathname === "/api/auth/forgot"', 'url.pathname.startsWith("/api/auth/")');
  assert.ok(fn.includes("sendResetEmail(env, email, resetUrl)"), "worker must try to email the link");
  assert.ok(fn.includes("resetUrl: mailed ? undefined : resetUrl"), "no-mail deployments must return resetUrl");
  assert.ok(fn.includes("hasAccount && body.token"), "resetUrl must only be returned for real accounts");
});

t("index.ts: callback branches popup vs top-level /?signedin=1", () => {
  const fn = src(worker, 'url.pathname === "/api/auth/google/callback"', 'url.pathname === "/api/auth/forgot"');
  assert.ok(fn.includes('searchParams.get("state") === "popup"'), "callback must read the popup state");
  assert.ok(fn.includes('location: "/?signedin=1"'), "top-level flow must land on /?signedin=1");
  assert.ok(fn.includes("googlePopupCallbackPage(true)"), "popup success page missing");
  assert.ok(fn.includes("RESEND_API_KEY?") || worker.includes("RESEND_API_KEY?"), "Env must declare RESEND_API_KEY");
});

// ── 3. client: forgot dialog, reset dialog, URL landings ──
t("cloud-account: forgot dialog requests /api/auth/forgot and shows link or mail message", () => {
  assert.ok(acct.includes('async function openForgotDialog'), "openForgotDialog missing");
  const fn = src(acct, "async function openForgotDialog", "// ── URL landings");
  assert.ok(fn.includes('"/api/auth/forgot"'), "forgot dialog must call the endpoint");
  assert.ok(fn.includes("res.resetUrl"), "inline one-time link path missing");
  assert.ok(fn.includes("Enter a valid email address"), "email pre-validation missing");
  assert.ok(fn.includes("← Back to sign in"), "back navigation missing");
});

t("cloud-account: reset dialog posts /api/auth/reset with confirm + auto sign-in", () => {
  const fn = src(acct, "async function openResetDialog", "// ── URL landings");
  assert.ok(fn.includes('"/api/auth/reset"'), "reset dialog must call the endpoint");
  assert.ok(fn.includes("don't match"), "password confirmation missing");
  assert.ok(fn.includes("await refreshAccountState()"), "reset must refresh the session");
  assert.ok(fn.includes("Password updated"), "success toast missing");
});

t("cloud-account: handleAuthUrlParams reacts to ?reset= and ?signedin=1, cleans the URL", () => {
  assert.ok(acct.includes("export function handleAuthUrlParams"), "handleAuthUrlParams must be exported");
  const fn = src(acct, "export function handleAuthUrlParams", "// ── cloud project vault");
  assert.ok(fn.includes('url.searchParams.get("reset")'), "reset param missing");
  assert.ok(fn.includes('"signedin"') && fn.includes("Welcome back"), "google welcome-back missing");
  assert.ok(fn.includes("history.replaceState"), "address bar must be cleaned");
  assert.ok(acct.includes("handleAuthUrlParams();"), "setupCloudAccount must call handleAuthUrlParams");
});

t("cloud-account: sign-in dialog has Forgot password? + remembered chips + Enter flow", () => {
  assert.ok(acct.includes('"Forgot password?"'), "forgot link missing");
  assert.ok(acct.includes("openForgotDialog(emailInput.value)"), "forgot must carry the typed email");
  assert.ok(acct.includes("Continue as ${em}"), "remembered-login chips missing");
  assert.ok(acct.includes("emailInput.value = remembered[0]"), "last email must prefill");
  assert.ok(acct.includes('function rememberedEmails'), "rememberedEmails helper missing");
  assert.ok(acct.includes("function rememberEmail"), "rememberEmail helper missing");
  assert.ok(src(acct, "async function doSubmit", "  submit.onclick").includes("rememberEmail(email)"), "sign-in must remember the email");
  const enter = src(acct, "emailInput.addEventListener(\"keydown\"", "  body.append(err, submit, forgot, swap, google, note);");
  assert.ok(/passInput\.focus\(\)/.test(enter), "Enter on email must move to the password field");
});

// ── 4. client: Google popup opener ──
t("cloud-account: popup opener + obs-oauth listener + blocked-popup fallback", () => {
  const fn = src(acct, "function openGoogleOAuth", "async function api<");
  assert.ok(fn.includes('"/api/auth/google/start?popup=1"'), "popup must open the ?popup=1 start URL");
  assert.ok(fn.includes('d.type !== "obs-oauth"'), "message filter missing");
  assert.ok(fn.includes("e.origin !== location.origin"), "postMessage origin check missing");
  assert.ok(fn.includes('window.location.href = "/api/auth/google/start"'), "blocked popup must fall back to full-page");
  assert.ok(fn.includes("rememberEmail(currentUser!.email)"), "google success must remember the account");
  const dlg = src(acct, "google.addEventListener(\"click\"", "  const note = document.createElement");
  assert.ok(dlg.includes("openGoogleOAuth((ok) =>"), "dialog google button must use the popup flow");
});

// ── 5. CI registration ──
t("test is registered in package.json and ci-unit-tests.mjs", () => {
  assert.ok(pkg.scripts["test:auth-ux"], "package.json script test:auth-ux missing");
  assert.ok(ciList.includes("test:auth-ux"), "ci-unit-tests.mjs must run test:auth-ux");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
