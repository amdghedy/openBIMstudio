// CI check that the checked-in CAD-engine wasm matches the checked-in Rust
// source (PE-12 wasm staleness guard).
//
//   node scripts/check-cad-engine-wasm.mjs
//
// Verifies the manifest attestation in
// public/cad-engine/obim-cad-engine.manifest.json holds:
//   1. the manifest is present and well-formed, and
//   2. sha256(public/cad-engine/obim-cad-engine.wasm) == manifest.wasmSha256, and
//   3. the deterministic hash of cad-engine-rust/ == manifest.rustSourceHash.
//
// Exit 0 on pass, exit 1 (loud, with the fix) on any failure.
//
// HONEST LIMIT: this does not rebuild the wasm and does not byte-compare
// against a fresh build — no toolchain is available on the hosts that serve
// the checked-in artifact. A stale manifest paired with a stale wasm still
// passes. What fails is SOURCE DRIFT: Rust source changed without a rebuild
// + manifest regeneration. That is the failure mode that shipped a stale
// wasm in #257.
//
// Run this BEFORE any step that stages a fresh build (scripts/copy-cad-engine-
// wasm.mjs overwrites the checked-in wasm, so a check after staging would
// compare the fresh bytes against the checked-in manifest).
import fs from "node:fs";
import path from "node:path";
import {
  MANIFEST_REL,
  WASM_REL,
  hashRustSource,
  readManifest,
  repoRoot,
  sha256File,
} from "./cad-engine-manifest.mjs";

const root = repoRoot();
const failures = [];

let manifest;
try {
  manifest = readManifest(root);
} catch (e) {
  failures.push(e.message);
  manifest = {};
}

if (Object.keys(manifest).length) {
  const wasmAbs = path.join(root, WASM_REL);
  if (!fs.existsSync(wasmAbs)) {
    failures.push(`checked-in wasm missing: ${WASM_REL}`);
  } else {
    const actual = sha256File(wasmAbs);
    if (actual !== manifest.wasmSha256) {
      failures.push(
        `wasm mismatch: ${WASM_REL} sha256 is ${actual} but the manifest records ${manifest.wasmSha256} — ` +
          `the checked-in wasm was replaced without regenerating the manifest`,
      );
    }
  }
  try {
    const actualSource = hashRustSource(root);
    if (actualSource !== manifest.rustSourceHash) {
      failures.push(
        `Rust source drift: cad-engine-rust/ hashes to ${actualSource} but the manifest records ${manifest.rustSourceHash} — ` +
          `the Rust source changed without a rebuild + manifest regeneration`,
      );
    }
  } catch (e) {
    failures.push(e.message);
  }
}

if (failures.length) {
  for (const f of failures) console.error(`::error::[cad-engine-wasm] ${f}`);
  console.error(
    "[cad-engine-wasm] FAIL: the checked-in wasm does not match the checked-in Rust source. " +
      "Rebuild the wasm (cd cad-engine-rust && cargo build --release --target wasm32-unknown-unknown), " +
      "stage it (node scripts/copy-cad-engine-wasm.mjs — this regenerates the manifest), and commit both the wasm and the manifest.",
  );
  process.exit(1);
}

console.log(
  `[cad-engine-wasm] PASS: checked-in wasm matches the manifest ` +
    `(wasm sha256 ${String(manifest.wasmSha256).slice(0, 12)}…, ` +
    `rust source ${String(manifest.rustSourceHash).slice(0, 12)}…, ` +
    `bridge ${manifest.bridgeVersion}, builtAt ${manifest.builtAt})`,
);
