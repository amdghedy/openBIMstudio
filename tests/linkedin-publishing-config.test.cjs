const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("LinkedIn OAuth requests only the required self-service member scopes", () => {
  const source = read("worker/linkedin.ts");
  assert.match(source, /scope", "openid profile w_member_social"/);
  assert.match(source, /oauth\/v2\/authorization/);
  assert.match(source, /oauth\/v2\/accessToken/);
  assert.match(source, /consume-state/);
});

test("LinkedIn tokens are stored in the private vault and not returned by status", () => {
  const source = read("worker/linkedin.ts");
  assert.match(source, /class LinkedInVault/);
  assert.match(source, /storage\.put\(TOKEN_KEY, body\)/);
  assert.match(source, /accessToken: token\.access_token/);
  const statusHandler = source.slice(source.indexOf('url.pathname === "/api/linkedin/status"'), source.indexOf('url.pathname === "/api/linkedin/publish"'));
  assert.doesNotMatch(statusHandler, /accessToken/);
});

test("Publishing is protected and targets the authenticated personal member", () => {
  const source = read("worker/linkedin.ts");
  assert.match(source, /if \(!authorized\(request, env\)\) return json\(\{ error: "Unauthorized\." \}, 401\)/);
  assert.match(source, /urn:li:person:/);
  assert.match(source, /https:\/\/api\.linkedin\.com\/rest\/posts/);
  assert.match(source, /lifecycleState: "PUBLISHED"/);
});

test("Worker routes LinkedIn requests and binds the dedicated Durable Object", () => {
  const worker = read("worker/index.ts");
  const config = JSON.parse(read("wrangler.jsonc"));
  assert.match(worker, /handleLinkedInRequest\(request, env\)/);
  assert.ok(config.durable_objects.bindings.some((binding) => binding.name === "LINKEDIN_VAULT" && binding.class_name === "LinkedInVault"));
  assert.ok(config.migrations.some((migration) => migration.new_sqlite_classes?.includes("LinkedInVault")));
});

test("GitHub workflow is manual only and does not expose credentials", () => {
  const workflow = read(".github/workflows/linkedin-publish.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(schedule|push|pull_request):/m);
  assert.match(workflow, /secrets\.LINKEDIN_PUBLISH_SECRET/);
  assert.match(workflow, /secrets\.LINKEDIN_WORKER_URL/);
});
