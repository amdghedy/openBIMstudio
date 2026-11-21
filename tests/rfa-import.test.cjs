/**
 * tests/rfa-import.test.cjs
 *
 * Follow-up 1 — the five rfaImport stub gaps, fixed and proven against a
 * MOCKED APS client (no live credentials, no APS calls):
 *   1. bucket verify-or-create (never silently assumed);
 *   2. job polling to completion with a bounded attempt budget;
 *   3. step 5 downloads the IFC derivative named by the manifest, never
 *      the manifest JSON itself;
 *   4. file input is a File / ArrayBuffer / Uint8Array, never axios.get
 *      on a local path;
 *   5. the job URN is base64 of the objectId
 *      (`urn:adsk.objects:os.object:<bucket>/<key>`), not of `<bucket>/<key>`.
 *
 * The module is compiled from source with tsc into a temp dir (same
 * harness pattern as parametric-family-hosting / project-file), with
 * node_modules symlinked in so the axios import resolves.
 *
 * Run: `node tests/rfa-import.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-rfa-import-"));
fs.symlinkSync(path.join(root, "node_modules"), path.join(tmpOut, "node_modules"), "junction");
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/services/rfaImport.ts",
  { cwd: root, stdio: "inherit", shell: true },
);
const { importRFA, DEFAULT_RFA_BUCKET_KEY } = require(path.join(tmpOut, "services/rfaImport.js"));

// ── Mock APS client ─────────────────────────────────────────────────────
const AUTH_URL = "https://developer.api.autodesk.com/authentication/v1/authenticate";
const OSS_BASE = "https://developer.api.autodesk.com/oss/v2";
const MD_BASE = "https://developer.api.autodesk.com/modelderivative/v2/designdata";
const BUCKET = DEFAULT_RFA_BUCKET_KEY;
const FILE = "chair.rfa";
const OBJECT_ID = `urn:adsk.objects:os.object:${BUCKET}/${FILE}`;
const EXPECTED_URN = Buffer.from(OBJECT_ID).toString("base64");
const WRONG_URN = Buffer.from(`${BUCKET}/${FILE}`).toString("base64");
const DERIVATIVE_URN = "urn:adsk.viewing:fs.file:abc123/output/chair.ifc";
const IFC_BYTES = Uint8Array.from([0x49, 0x53, 0x4f, 0x2d, 0x31, 0x30, 0x33, 0x30, 0x33]); // "ISO-10303"

function httpError(status, message) {
  const err = new Error(message || `HTTP ${status}`);
  err.response = { status };
  return err;
}

/**
 * Mock HTTP client with axios semantics: non-2xx rejects with an error
 * carrying `response.status`. Behaviour is scripted per test via `script`.
 */
function makeMock(script) {
  const calls = [];
  const sleeps = [];
  let manifestCalls = 0;
  const client = {
    calls,
    sleeps,
    get manifestCalls() { return manifestCalls; },
    async get(url, config) {
      calls.push({ method: "GET", url, config });
      if (url === `${OSS_BASE}/buckets/${BUCKET}`) {
        if (script.bucketGet === "missing") throw httpError(404, "Bucket not found");
        if (script.bucketGet === "error") throw httpError(500, "Internal error");
        return { status: 200, data: { bucketKey: BUCKET } };
      }
      if (url.startsWith(`${MD_BASE}/`) && url.endsWith("/manifest")) {
        manifestCalls++;
        const next = script.manifests[Math.min(manifestCalls - 1, script.manifests.length - 1)];
        return { status: 200, data: next };
      }
      if (url === `${MD_BASE}/${EXPECTED_URN}/manifest/${DERIVATIVE_URN}`) {
        return { status: 200, data: script.derivativeBytes ?? IFC_BYTES };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, data, config) {
      calls.push({ method: "POST", url, data, config });
      if (url === AUTH_URL) {
        return { status: 200, data: { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 } };
      }
      if (url === `${OSS_BASE}/buckets`) {
        if (script.bucketCreate === "forbidden") throw httpError(403, "Forbidden");
        if (script.bucketCreate === "race") throw httpError(409, "Bucket already exists");
        return { status: 200, data: { bucketKey: BUCKET } };
      }
      if (url === `${MD_BASE}/job`) return { status: 200, data: {} };
      throw new Error(`unexpected POST ${url}`);
    },
    async put(url, data, config) {
      calls.push({ method: "PUT", url, data, config });
      if (url === `${OSS_BASE}/buckets/${BUCKET}/objects/${encodeURIComponent(FILE)}` ||
          url.startsWith(`${OSS_BASE}/buckets/${BUCKET}/objects/`)) {
        return { status: 200, data: script.uploadData ?? { objectId: OBJECT_ID } };
      }
      throw new Error(`unexpected PUT ${url}`);
    },
  };
  return { client, calls, sleeps, get manifestCalls() { return manifestCalls; } };
}

function successManifest() {
  return {
    status: "success",
    progress: "complete",
    derivatives: [{ urn: DERIVATIVE_URN, outputType: "ifc" }],
  };
}

function makeApi() {
  const openModelCalls = [];
  return {
    openModelCalls,
    api: {
      OpenModel(bytes) { openModelCalls.push(bytes); return 7; },
    },
  };
}

const RFA_BYTES = Uint8Array.from([0x52, 0x45, 0x56, 0x49, 0x54]); // fake .rfa payload

const savedClientId = process.env.FORGE_CLIENT_ID;
const savedClientSecret = process.env.FORGE_CLIENT_SECRET;
function setCreds() {
  process.env.FORGE_CLIENT_ID = "test-client-id";
  process.env.FORGE_CLIENT_SECRET = "test-client-secret";
}
function clearCreds() {
  delete process.env.FORGE_CLIENT_ID;
  delete process.env.FORGE_CLIENT_SECRET;
}
function restoreCreds() {
  if (savedClientId === undefined) delete process.env.FORGE_CLIENT_ID;
  else process.env.FORGE_CLIENT_ID = savedClientId;
  if (savedClientSecret === undefined) delete process.env.FORGE_CLIENT_SECRET;
  else process.env.FORGE_CLIENT_SECRET = savedClientSecret;
}

(async () => {
try {
  await t("happy path: token → bucket → upload → job → poll → derivative → OpenModel", async () => {
    setCreds();
    const { client, calls, sleeps } = makeMock({
      manifests: [{ status: "inprogress", progress: "10%" }, { status: "inprogress", progress: "55%" }, successManifest()],
    });
    const { api, openModelCalls } = makeApi();
    const sleep = async (ms) => { sleeps.push(ms); };
    await importRFA(RFA_BYTES, FILE, api, { http: client, pollIntervalMs: 250, sleep });

    // Auth requested the scopes the bucket step needs.
    const authCall = calls.find((c) => c.method === "POST" && c.url === AUTH_URL);
    assert.ok(authCall, "expected an auth call");
    const scope = String(authCall.data.get("scope"));
    assert.ok(scope.includes("bucket:read"), `scope missing bucket:read: ${scope}`);
    assert.ok(scope.includes("bucket:create"), `scope missing bucket:create: ${scope}`);

    // Bucket was verified (GET) and NOT created (it already existed).
    assert.ok(calls.some((c) => c.method === "GET" && c.url === `${OSS_BASE}/buckets/${BUCKET}`), "bucket GET missing");
    assert.ok(!calls.some((c) => c.method === "POST" && c.url === `${OSS_BASE}/buckets`), "bucket must not be created when it exists");

    // Upload carried the exact input bytes.
    const upload = calls.find((c) => c.method === "PUT");
    assert.ok(upload, "upload PUT missing");
    assert.deepStrictEqual([...upload.data], [...RFA_BYTES]);

    // Job URN is base64(objectId), NOT base64("bucket/key").
    const job = calls.find((c) => c.method === "POST" && c.url === `${MD_BASE}/job`);
    assert.ok(job, "job POST missing");
    assert.strictEqual(job.data.input.urn, EXPECTED_URN);
    assert.notStrictEqual(job.data.input.urn, WRONG_URN);

    // Polled 3 times, waited between attempts, derivative fetched only after success.
    const manifestGets = calls.filter((c) => c.method === "GET" && c.url.endsWith("/manifest"));
    assert.strictEqual(manifestGets.length, 3, `expected 3 manifest polls, got ${manifestGets.length}`);
    assert.deepStrictEqual(sleeps, [250, 250], "expected one sleep per gap between polls");
    const derivativeGet = calls.find((c) => c.method === "GET" && c.url.includes(DERIVATIVE_URN));
    assert.ok(derivativeGet, "derivative download missing");
    assert.strictEqual(derivativeGet.url, `${MD_BASE}/${EXPECTED_URN}/manifest/${DERIVATIVE_URN}`);
    assert.strictEqual(derivativeGet.config.responseType, "arraybuffer");

    // OpenModel received the DERIVATIVE bytes, never the manifest JSON.
    assert.strictEqual(openModelCalls.length, 1, "OpenModel must be called exactly once");
    assert.deepStrictEqual([...openModelCalls[0]], [...IFC_BYTES]);
  });

  await t("gap 1: missing bucket is created, then the import continues", async () => {
    setCreds();
    const { client, calls } = makeMock({ bucketGet: "missing", manifests: [successManifest()] });
    const { api, openModelCalls } = makeApi();
    await importRFA(RFA_BYTES, FILE, api, { http: client, pollIntervalMs: 0, sleep: async () => {} });
    const create = calls.find((c) => c.method === "POST" && c.url === `${OSS_BASE}/buckets`);
    assert.ok(create, "bucket create POST missing");
    assert.deepStrictEqual(create.data, { bucketKey: BUCKET, policyKey: "transient" });
    assert.strictEqual(openModelCalls.length, 1, "import must complete after bucket creation");
  });

  await t("gap 1: bucket create race (409) is treated as success", async () => {
    setCreds();
    const { client } = makeMock({ bucketGet: "missing", bucketCreate: "race", manifests: [successManifest()] });
    const { api, openModelCalls } = makeApi();
    await importRFA(RFA_BYTES, FILE, api, { http: client, pollIntervalMs: 0, sleep: async () => {} });
    assert.strictEqual(openModelCalls.length, 1);
  });

  await t("gap 1: bucket that cannot be created fails loudly, before any upload", async () => {
    setCreds();
    const { client, calls } = makeMock({ bucketGet: "missing", bucketCreate: "forbidden", manifests: [successManifest()] });
    const { api } = makeApi();
    await assert.rejects(
      () => importRFA(RFA_BYTES, FILE, api, { http: client, pollIntervalMs: 0, sleep: async () => {} }),
      /could not be created/,
    );
    assert.ok(!calls.some((c) => c.method === "PUT"), "no upload must be attempted without a bucket");
  });

  await t("gap 1: bucket that cannot be verified fails loudly", async () => {
    setCreds();
    const { client, calls } = makeMock({ bucketGet: "error", manifests: [successManifest()] });
    const { api } = makeApi();
    await assert.rejects(
      () => importRFA(RFA_BYTES, FILE, api, { http: client, pollIntervalMs: 0, sleep: async () => {} }),
      /could not be verified/,
    );
    assert.ok(!calls.some((c) => c.method === "PUT"), "no upload must be attempted when verification fails");
  });

  await t("gap 2: polling gives up after the attempt budget, without downloading", async () => {
    setCreds();
    const mock = makeMock({ manifests: [{ status: "inprogress", progress: "40%" }] });
    const { api, openModelCalls } = makeApi();
    await assert.rejects(
      () => importRFA(RFA_BYTES, FILE, api, { http: mock.client, maxPollAttempts: 3, pollIntervalMs: 0, sleep: async (ms) => mock.sleeps.push(ms) }),
      /did not finish after 3 status checks/,
    );
    assert.strictEqual(mock.manifestCalls, 3, `expected exactly 3 manifest polls, got ${mock.manifestCalls}`);
    assert.strictEqual(openModelCalls.length, 0, "no model must be opened on timeout");
    assert.ok(!mock.calls.some((c) => c.method === "GET" && c.url.includes(DERIVATIVE_URN)), "derivative must not be downloaded before success");
    assert.deepStrictEqual(mock.sleeps, [0, 0], "sleep between attempts only, not after the last");
  });

  await t("gap 2: failed job rejects and never downloads a derivative", async () => {
    setCreds();
    const mock = makeMock({ manifests: [{ status: "inprogress", progress: "20%" }, { status: "failed", progress: "20%" }] });
    const { api, openModelCalls } = makeApi();
    await assert.rejects(
      () => importRFA(RFA_BYTES, FILE, api, { http: mock.client, pollIntervalMs: 0, sleep: async () => {} }),
      /translation failed.*failed/,
    );
    assert.strictEqual(mock.manifestCalls, 2);
    assert.strictEqual(openModelCalls.length, 0);
  });

  await t("gap 3: success without an IFC derivative rejects, derivative never fetched", async () => {
    setCreds();
    const mock = makeMock({ manifests: [{ status: "success", progress: "complete", derivatives: [{ urn: "urn:x", outputType: "svf" }] }] });
    const { api, openModelCalls } = makeApi();
    await assert.rejects(
      () => importRFA(RFA_BYTES, FILE, api, { http: mock.client, pollIntervalMs: 0, sleep: async () => {} }),
      /no IFC derivative/,
    );
    assert.strictEqual(openModelCalls.length, 0);
    assert.ok(!mock.calls.some((c) => c.method === "GET" && c.url.includes("/manifest/urn:")), "no derivative download without an IFC derivative");
  });

  await t("gap 4: File / ArrayBuffer / Uint8Array inputs all upload the same bytes", async () => {
    setCreds();
    for (const input of [
      new File([RFA_BYTES], FILE),
      RFA_BYTES.buffer.slice(RFA_BYTES.byteOffset, RFA_BYTES.byteOffset + RFA_BYTES.byteLength),
      RFA_BYTES,
    ]) {
      const { client, calls } = makeMock({ manifests: [successManifest()] });
      const { api, openModelCalls } = makeApi();
      await importRFA(input, FILE, api, { http: client, pollIntervalMs: 0, sleep: async () => {} });
      const upload = calls.find((c) => c.method === "PUT");
      assert.deepStrictEqual([...upload.data], [...RFA_BYTES], `input of type ${input.constructor.name} uploaded wrong bytes`);
      assert.strictEqual(openModelCalls.length, 1);
    }
  });

  await t("gap 4: a file path is rejected and never fetched as a URL", async () => {
    setCreds();
    const { client, calls } = makeMock({ manifests: [successManifest()] });
    const { api } = makeApi();
    await assert.rejects(
      // @ts-expect-error — deliberately passing the old (path) input shape.
      () => importRFA("/tmp/chair.rfa", FILE, api, { http: client, pollIntervalMs: 0, sleep: async () => {} }),
      /file path is not accepted/,
    );
    assert.strictEqual(calls.length, 0, "no HTTP call may be made for a path input");
  });

  await t("gap 4: non-.rfa name and empty file are rejected before auth", async () => {
    setCreds();
    const { client, calls } = makeMock({ manifests: [successManifest()] });
    const { api } = makeApi();
    await assert.rejects(() => importRFA(RFA_BYTES, "chair.txt", api, { http: client }), /\.rfa/);
    await assert.rejects(() => importRFA(new Uint8Array(0), FILE, api, { http: client }), /empty file/);
    assert.strictEqual(calls.length, 0, "validation must happen before any HTTP call");
  });

  await t("gap 4: directory components in the file name are stripped from the object key", async () => {
    setCreds();
    const { client, calls } = makeMock({ manifests: [successManifest()] });
    const { api } = makeApi();
    await importRFA(RFA_BYTES, "../../etc/chair.rfa", api, { http: client, pollIntervalMs: 0, sleep: async () => {} });
    const upload = calls.find((c) => c.method === "PUT");
    assert.ok(upload.url.endsWith(`/objects/${FILE}`), `object key must be the basename, got ${upload.url}`);
    assert.ok(!upload.url.includes(".."), "object key must not contain path traversal");
  });

  await t("gap 5: upload response without objectId falls back to the constructed objectId", async () => {
    setCreds();
    const { client, calls } = makeMock({ manifests: [successManifest()], uploadData: { objectKey: FILE } });
    const { api } = makeApi();
    await importRFA(RFA_BYTES, FILE, api, { http: client, pollIntervalMs: 0, sleep: async () => {} });
    const job = calls.find((c) => c.method === "POST" && c.url === `${MD_BASE}/job`);
    assert.strictEqual(job.data.input.urn, EXPECTED_URN, "fallback URN must still be base64(objectId)");
  });

  await t("no credentials: returns without any HTTP call", async () => {
    clearCreds();
    const { client, calls } = makeMock({ manifests: [successManifest()] });
    const { api, openModelCalls } = makeApi();
    await importRFA(RFA_BYTES, FILE, api, { http: client, pollIntervalMs: 0, sleep: async () => {} });
    assert.strictEqual(calls.length, 0, "no APS call without credentials");
    assert.strictEqual(openModelCalls.length, 0);
  });
} finally {
  restoreCreds();
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
