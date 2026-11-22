/* The wasm staged for this build must report the DWG failsafe capability the app requires.
   STRICT everywhere: hosts that do not run cargo (Vercel, Cloudflare Workers Builds) serve the checked-in wasm, so a stale copy here reaches users (user console: bridge 0.1.0 without dwgRead).
   PE-12: the identity string must also carry the staleness attestation — the
   Rust source hash and the build stamp from the manifest — so a stale engine
   is visible in diagnostics instead of hiding behind one static string. */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), crypto = require("crypto");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "acid-"));
execSync(`npx tsc src/modules/drawings/acad-engine.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const E = require(find(out, "acad-engine.js"));
(async () => {
  const bytes = fs.readFileSync("public/cad-engine/obim-cad-engine.wasm");
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const id = E.engineIdentity({ exports: instance.exports });
  console.log("  engine identity:", id, "size KiB", Math.round(bytes.length / 1024));
  const ok = JSON.parse(id).dwgRead === E.REQUIRED_ENGINE_DWG_READ;
  if (!ok) { console.log("  FAIL staged engine lacks dwgRead=" + E.REQUIRED_ENGINE_DWG_READ); process.exit(1); }
  // PE-12: enriched identity — source hash + build stamp from the manifest,
  // and the sha256 of the wasm bytes actually loaded (not just attested).
  const manifestMod = await import("../scripts/cad-engine-manifest.mjs");
  const manifest = manifestMod.readManifest(process.cwd());
  const actualWasmSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const enriched = JSON.parse(E.engineIdentity({ exports: instance.exports }, manifest, actualWasmSha256));
  console.log("  enriched identity:", JSON.stringify(enriched));
  assert.strictEqual(enriched.dwgRead, E.REQUIRED_ENGINE_DWG_READ, "enriched identity lost dwgRead");
  assert.strictEqual(enriched.bridge, manifest.bridgeVersion, "enriched identity bridge is not the manifest bridgeVersion");
  assert.strictEqual(enriched.rustSourceHash, manifest.rustSourceHash, "identity rustSourceHash is not the manifest value");
  assert.strictEqual(enriched.rustSourceHash, manifestMod.hashRustSource(process.cwd()), "identity rustSourceHash is not the current Rust source hash");
  assert.strictEqual(enriched.builtAt, manifest.builtAt, "identity builtAt is not the manifest build stamp");
  assert.ok(!Number.isNaN(Date.parse(enriched.builtAt)), "identity builtAt is not a timestamp");
  assert.strictEqual(enriched.wasmSha256, actualWasmSha256, "identity wasmSha256 is not the sha256 of the loaded bytes");
  assert.strictEqual(enriched.manifestWasmSha256, manifest.wasmSha256, "identity manifestWasmSha256 is not the manifest value");
  assert.strictEqual(enriched.wasmMatchesManifest, true, "loaded wasm does not match the manifest attestation");
  console.log("acad-engine-identity: 2 passed");
})();
