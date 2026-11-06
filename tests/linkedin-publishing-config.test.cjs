const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("LinkedIn OAuth requests only the required self-service member scopes", () => {
  const source = read("worker/linkedin.ts");
  assert.ok(source.includes('scope", "openid profile w_member_social"'));
  assert.ok(source.includes("oauth/v2/authorization"));
  assert.ok(source.includes("oauth/v2/accessToken"));
  assert.ok(source.includes("consume-state"));
  assert.ok(source.includes("__Host-obs-linkedin-oauth"));
  assert.ok(source.includes("constantTimeEqual(state, browserState)"));
});

test("LinkedIn tokens are stored in the private vault and not returned by status", () => {
  const source = read("worker/linkedin.ts");
  assert.ok(source.includes("class LinkedInVault"));
  assert.ok(source.includes("storage.put(TOKEN_KEY, body)"));
  assert.ok(source.includes("accessToken: token.access_token"));
  const statusHandler = source.slice(
    source.indexOf('url.pathname === "/api/linkedin/status"'),
    source.indexOf('url.pathname === "/api/linkedin/publish"'),
  );
  assert.equal(statusHandler.includes("accessToken:"), false);
});

test("Publishing is protected and targets the authenticated personal member", () => {
  const source = read("worker/linkedin.ts");
  assert.ok(source.includes("if (!authorized(request, env))"));
  assert.ok(source.includes("urn:li:person:"));
  assert.ok(source.includes("https://api.linkedin.com/rest/posts"));
  assert.ok(source.includes('lifecycleState: "PUBLISHED"'));
});

test("Worker routes LinkedIn requests and binds the dedicated Durable Object", () => {
  const worker = read("worker/index.ts");
  const config = JSON.parse(read("wrangler.jsonc"));
  assert.ok(worker.includes("handleLinkedInRequest(request, env)"));
  assert.ok(config.durable_objects.bindings.some(
    (binding) => binding.name === "LINKEDIN_VAULT" && binding.class_name === "LinkedInVault",
  ));
  assert.ok(config.migrations.some(
    (migration) => migration.new_sqlite_classes?.includes("LinkedInVault"),
  ));
});

test("GitHub workflow is manual only and does not expose credentials", () => {
  const workflow = read(".github/workflows/linkedin-publish.yml");
  assert.ok(workflow.includes("workflow_dispatch:"));
  assert.equal(workflow.includes("  schedule:"), false);
  assert.equal(workflow.includes("  push:"), false);
  assert.ok(workflow.includes("secrets.LINKEDIN_PUBLISH_SECRET"));
  assert.ok(workflow.includes("secrets.LINKEDIN_WORKER_URL"));
});
