/* Google sign-in login-CSRF defence (#92): state is bound to the starting browser by a single-use cookie,
 * and unverified Google emails are rejected. Runs the real worker/auth.ts. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-"));
execSync(`npx tsc worker/auth.ts --outDir ${out} --module commonjs --target es2022 --skipLibCheck --lib es2022,dom --ignoreConfig`, { stdio: "pipe", cwd: path.join(__dirname, "..") });
const A = require(path.join(out, "auth.js"));
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const env = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" };
const start = (q = "") => A.googleStart(new Request("https://app.example/api/auth/google/start" + q), env);
const nonceOf = (s) => /obs_oauth=([0-9a-f]+);/.exec(s.setCookie)[1];
const stateOf = (s) => new URL(s.location).searchParams.get("state");
const cb = (state, cookie) => new Request("https://app.example/api/auth/google/callback?code=x&state=" + encodeURIComponent(state), { headers: cookie ? { cookie } : {} });

(async () => {
  await t("start sets a random HttpOnly Secure SameSite=Lax cookie scoped to the auth path", () => {
    const a = start(), b = start();
    assert.notEqual(nonceOf(a), nonceOf(b));
    assert.equal(nonceOf(a).length, 32);
    for (const f of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/auth/google", "Max-Age=600"]) assert.ok(a.setCookie.includes(f), f);
    assert.match(stateOf(a), /^app\.[0-9a-f]{32}$/);
    assert.match(stateOf(start("?popup=1")), /^popup\.[0-9a-f]{32}$/);
  });
  await t("callback with matching state+cookie is accepted and keeps the flow mode", () => {
    const s = start("?popup=1");
    assert.equal(A.verifyGoogleState(cb(stateOf(s), "obs_oauth=" + nonceOf(s))), "popup");
    const s2 = start();
    assert.equal(A.verifyGoogleState(cb(stateOf(s2), "x=1; obs_oauth=" + nonceOf(s2))), "app");
  });
  await t("callback without the cookie is rejected (attacker-initiated flow)", () => {
    const s = start();
    assert.equal(A.verifyGoogleState(cb(stateOf(s), "")), null);
  });
  await t("callback with another browser's nonce is rejected", () => {
    assert.equal(A.verifyGoogleState(cb(stateOf(start()), "obs_oauth=" + nonceOf(start()))), null);
  });
  await t("legacy static state values and malformed states are rejected", () => {
    const c = "obs_oauth=" + "a".repeat(32);
    for (const st of ["popup", "app", "", "app.", "app." + "a".repeat(31), "evil." + "a".repeat(32), "app." + "A".repeat(32), "app." + "a".repeat(32) + "x"]) {
      assert.equal(A.verifyGoogleState(cb(st, c)), null, st);
    }
    assert.equal(A.verifyGoogleState(cb("app." + "a".repeat(32), "obs_oauth=short")), null);
  });
  await t("missing client id means no flow and no cookie", () => {
    assert.equal(A.googleStart(new Request("https://app.example/x"), {}), null);
  });
  await t("clear cookie deletes the binding", () => {
    assert.ok(/Max-Age=0/.test(A.clearOAuthStateCookie()) && /obs_oauth=;/.test(A.clearOAuthStateCookie()));
  });
  const realFetch = global.fetch;
  const mockGoogle = (info) => { global.fetch = async (u) => String(u).includes("oauth2.googleapis.com") ? new Response(JSON.stringify({ access_token: "tok" })) : new Response(JSON.stringify(info)); };
  await t("unverified Google email is rejected", async () => {
    for (const v of [false, "false", undefined, 0]) {
      mockGoogle({ email: "victim@example.com", email_verified: v, sub: "1" });
      await assert.rejects(A.googleCallback(cb("app." + "a".repeat(32), ""), env), /email-not-verified/);
    }
  });
  await t("verified Google email is accepted", async () => {
    for (const v of [true, "true"]) {
      mockGoogle({ email: "ok@example.com", email_verified: v, name: "Ok", sub: "2" });
      const r = await A.googleCallback(cb("app." + "a".repeat(32), ""), env);
      assert.equal(r.email, "ok@example.com");
    }
  });
  global.fetch = realFetch;
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
