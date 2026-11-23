/* PE-12 wasm staleness guard: the manifest attestation holds for the current
   tree, the CI check fails on tampering, and the copy script fails loudly
   when no fresh build exists. All tampering happens in scratch copies under
   os.tmpdir() — the real tree is never modified by this test. */
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
let passed = 0;
let failed = 0;
const scratchDirs = [];

function check(name, fn) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  PASS ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${name}: ${e.message}`);
    }
  })();
}

function runNode(scriptRel, cwd, args = []) {
  return spawnSync(process.execPath, [scriptRel, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

/** Minimal repo-layout scratch copy: only what the wasm scripts resolve (scripts/.. = root). */
function makeScratch(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pe12-${tag}-`));
  scratchDirs.push(dir);
  const copyTree = (rel) => {
    fs.cpSync(path.join(root, rel), path.join(dir, rel), {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("target"),
    });
  };
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  for (const f of ["cad-engine-manifest.mjs", "check-cad-engine-wasm.mjs", "generate-cad-engine-manifest.mjs", "copy-cad-engine-wasm.mjs"]) {
    fs.copyFileSync(path.join(root, "scripts", f), path.join(dir, "scripts", f));
  }
  copyTree(path.join("public", "cad-engine"));
  copyTree("cad-engine-rust");
  return dir;
}

function readWasmIdentity(wasmBytes) {
  return WebAssembly.instantiate(wasmBytes, {}).then(({ instance }) => {
    const ex = instance.exports;
    const ptr = ex.obim_engine_version();
    const dv = new DataView(ex.memory.buffer);
    const len = dv.getUint32(ptr, true);
    return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr + 4, len));
  });
}

(async () => {
  console.log("== wasm staleness guard (PE-12) ==");
  const manifestMod = await import("../scripts/cad-engine-manifest.mjs");

  await check("manifest matches the checked-in wasm + current Rust source", async () => {
    const manifest = manifestMod.readManifest(root);
    const wasmAbs = path.join(root, "public", "cad-engine", "obim-cad-engine.wasm");
    const wasmBytes = fs.readFileSync(wasmAbs);
    assert.strictEqual(
      crypto.createHash("sha256").update(wasmBytes).digest("hex"),
      manifest.wasmSha256,
      "manifest wasmSha256 does not match the checked-in wasm",
    );
    assert.strictEqual(
      manifestMod.hashRustSource(root),
      manifest.rustSourceHash,
      "manifest rustSourceHash does not match cad-engine-rust/",
    );
    const raw = JSON.parse(await readWasmIdentity(wasmBytes));
    assert.strictEqual(raw.bridge, manifest.bridgeVersion, "manifest bridgeVersion is not what the live wasm reports");
    assert.strictEqual(raw.dwgRead, "failsafe");
    assert.ok(!Number.isNaN(Date.parse(manifest.builtAt)), "manifest builtAt is not a timestamp");
  });

  await check("CI check passes on the honest tree", () => {
    const r = runNode("scripts/check-cad-engine-wasm.mjs", root);
    assert.strictEqual(r.status, 0, `checker exit ${r.status}: ${r.stderr || r.stdout}`);
    assert.match(r.stdout, /PASS/);
  });

  await check("CI check FAILS on a tampered manifest hash", () => {
    const dir = makeScratch("tamper-manifest");
    const manifestPath = path.join(dir, "public", "cad-engine", "obim-cad-engine.manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    // Flip the first hex digit to a different one (never a no-op: the hash
    // may already start with the replacement digit).
    const first = manifest.wasmSha256[0] === "f" ? "0" : "f";
    manifest.wasmSha256 = `${first}${manifest.wasmSha256.slice(1)}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const r = runNode("scripts/check-cad-engine-wasm.mjs", dir);
    assert.notStrictEqual(r.status, 0, "checker passed on a tampered manifest");
    assert.match(r.stderr, /wasm mismatch/, `expected a wasm-mismatch error, got: ${r.stderr}`);
  });

  await check("CI check FAILS on Rust source drift (no rebuild)", () => {
    const dir = makeScratch("tamper-source");
    fs.appendFileSync(
      path.join(dir, "cad-engine-rust", "src", "lib.rs"),
      "\n// PE-12 probe: a one-line source change with no rebuild must fail the check.\n",
    );
    const r = runNode("scripts/check-cad-engine-wasm.mjs", dir);
    assert.notStrictEqual(r.status, 0, "checker passed on drifted Rust source");
    assert.match(r.stderr, /Rust source drift/, `expected a source-drift error, got: ${r.stderr}`);
  });

  await check("CI check FAILS when the manifest is missing", () => {
    const dir = makeScratch("no-manifest");
    fs.unlinkSync(path.join(dir, "public", "cad-engine", "obim-cad-engine.manifest.json"));
    const r = runNode("scripts/check-cad-engine-wasm.mjs", dir);
    assert.notStrictEqual(r.status, 0, "checker passed with no manifest");
    assert.match(r.stderr, /missing/, `expected a missing-manifest error, got: ${r.stderr}`);
  });

  await check("copy script FAILS loudly with no fresh build (checked-in wasm untouched)", () => {
    const dir = makeScratch("copy-nobuild");
    const wasmAbs = path.join(dir, "public", "cad-engine", "obim-cad-engine.wasm");
    const before = crypto.createHash("sha256").update(fs.readFileSync(wasmAbs)).digest("hex");
    const r = runNode("scripts/copy-cad-engine-wasm.mjs", dir);
    assert.notStrictEqual(r.status, 0, "copy script exited 0 with no fresh build");
    assert.match(r.stderr, /ERROR: no fresh build found/, `expected a loud no-fresh-build error, got: ${r.stderr}`);
    assert.match(r.stderr, /refusing to keep a possibly-stale checked-in copy/);
    const after = crypto.createHash("sha256").update(fs.readFileSync(wasmAbs)).digest("hex");
    assert.strictEqual(after, before, "copy script modified the checked-in wasm on failure");
  });

  await check("copy script succeeds with a fresh build and regenerates the manifest", async () => {
    const dir = makeScratch("copy-fresh");
    const builtDir = path.join(dir, "cad-engine-rust", "target", "wasm32-unknown-unknown", "release");
    fs.mkdirSync(builtDir, { recursive: true });
    // A stand-in fresh build: the checked-in wasm bytes (a valid wasm, so the
    // generator can read its bridge version). Proves the copy + verify +
    // manifest-regeneration mechanics, not a real cargo build.
    fs.copyFileSync(
      path.join(dir, "public", "cad-engine", "obim-cad-engine.wasm"),
      path.join(builtDir, "obim_cad_engine.wasm"),
    );
    const r = runNode("scripts/copy-cad-engine-wasm.mjs", dir);
    assert.strictEqual(r.status, 0, `copy script exit ${r.status}: ${r.stderr || r.stdout}`);
    assert.match(r.stdout, /copied obim-cad-engine\.wasm/);
    assert.match(r.stdout, /regenerated manifest attestation/);
    const after = runNode("scripts/check-cad-engine-wasm.mjs", dir);
    assert.strictEqual(after.status, 0, `checker failed after a copy + regen: ${after.stderr || after.stdout}`);
  });

  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(failed ? `wasm-staleness-guard: ${passed} passed, ${failed} failed` : `wasm-staleness-guard: ${passed} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  for (const d of scratchDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  }
  console.log(`wasm-staleness-guard: harness error: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
