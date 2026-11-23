// Focused runtime regression tests for Google OAuth browser state and account linking.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText).toString('base64');
(async () => {
  globalThis.crypto ??= require('node:crypto').webcrypto;
  const authUrl = asModule(fs.readFileSync(path.join(root, 'worker/auth.ts'), 'utf8'));
  const linkedInUrl = asModule(fs.readFileSync(path.join(root, 'worker/linkedin.ts'), 'utf8'));
  const auth = await import(authUrl);
  const source = fs.readFileSync(path.join(root, 'worker/index.ts'), 'utf8')
    .replace('"./auth"', JSON.stringify(authUrl)).replace('"./linkedin"', JSON.stringify(linkedInUrl));
  const { default: worker } = await import(asModule(source));
  let calls = 0, upserts = 0, verified = true;
  const originalWarn = console.warn;
  console.warn = () => {}; // expected negative callbacks must not print data-URL stack traces
  globalThis.fetch = async url => {
    calls++;
    return new Response(JSON.stringify(String(url).includes('/token')
      ? { access_token: 'test-only-access-token' }
      : { email: 'owner@example.invalid', email_verified: verified, name: 'Owner', sub: 'test-sub' }),
    { headers: { 'content-type': 'application/json' } });
  };
  const session = 'obs_session=test-only-session; Path=/; HttpOnly; Secure; SameSite=Lax';
  const env = { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
    AUTH: { idFromName: () => 'global', get: () => ({ fetch: async () => {
      upserts++; return new Response('{"ok":true}', { headers: { 'set-cookie': session } });
    } }) } };
  const request = (state, cookie = state) => new Request(
    'https://example.invalid/api/auth/google/callback?code=test&state=' + encodeURIComponent(state),
    { headers: cookie ? { cookie: '__Host-obs_google_state=' + cookie } : {} });
  for (const mode of ['app', 'popup']) {
    const startRequest = new Request('https://example.invalid/api/auth/google/start' + (mode === 'popup' ? '?popup=1' : ''));
    const start = await worker.fetch(startRequest, env);
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    assert.match(state, new RegExp('^' + mode + '\\.[A-Za-z0-9_-]{43}\\.\\d{13}$'));
    assert.notEqual(state, auth.googleOAuthState(startRequest));
    const stateCookie = start.headers.get('set-cookie');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) assert.ok(stateCookie.includes(flag));
    const result = await worker.fetch(request(state), env);
    assert.equal(result.status, mode === 'popup' ? 200 : 302);
    const cookies = result.headers.get('set-cookie');
    assert.ok(cookies.includes(session), 'session must survive in both callback modes');
    assert.ok(cookies.includes('__Host-obs_google_state=;'), 'state cookie must be consumed');
    if (mode === 'popup') assert.match(await result.text(), /obs-oauth/);
    else assert.equal(result.headers.get('location'), '/?signedin=1');
  }
  for (const [state, cookie] of [
    ['popup', 'popup'], ['app', 'app'], ['', ''],
    [auth.googleOAuthState(new Request('https://example.invalid/')), 'wrong-browser-state'],
    [auth.googleOAuthState(new Request('https://example.invalid/')), ''],
    ['app.' + 'a'.repeat(43) + '.' + (Date.now() - 601000), null],
    ['app.' + 'a'.repeat(43) + '.' + (Date.now() + 60000), null],
  ]) {
    const before = calls;
    const result = await worker.fetch(request(state, cookie === null ? state : cookie), env);
    assert.equal(result.status, 502);
    assert.equal(calls, before, 'invalid browser state must stop before any Google exchange');
    assert.ok(result.headers.get('set-cookie').includes('Max-Age=0'));
  }
  verified = false;
  const beforeUpsert = upserts;
  const state = auth.googleOAuthState(new Request('https://example.invalid/'));
  const rejected = await worker.fetch(request(state), env);
  assert.equal(rejected.status, 502);
  assert.equal(upserts, beforeUpsert, 'unverified Google email must never link an account');
  assert.match(await rejected.text(), /unverified-email/);
  console.warn = originalWarn;
  console.log('PASS Google OAuth runtime state, cookie, expiry, wrong-browser and verified-email checks');
})().catch(error => { console.error(error); process.exitCode = 1; });
