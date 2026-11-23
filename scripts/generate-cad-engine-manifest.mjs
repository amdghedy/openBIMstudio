// Generate the CAD-engine wasm manifest attestation (PE-12).
//
//   node scripts/generate-cad-engine-manifest.mjs [--built-at <ISO-8601>]
//
// Hash-only: no cargo is needed. It records, for the wasm currently in
// public/cad-engine/:
//   - wasmSha256: sha256 of the checked-in wasm bytes
//   - rustSourceHash: deterministic hash of cad-engine-rust/ (see
//     scripts/cad-engine-manifest.mjs; target/ excluded)
//   - bridgeVersion: the bridge version the wasm itself reports
//     (obim_engine_version), read by instantiating it — never hardcoded
//   - builtAt: when this manifest was generated. Run it immediately after a
//     cargo build + copy, so builtAt is effectively the build time; for the
//     checked-in artifact whose original build time was never recorded,
//     builtAt is the attestation time, and the manifest says so.
//
// This is an ATTESTATION, not a rebuild proof: a stale manifest paired with
// a stale wasm still passes. What it catches is SOURCE DRIFT — Rust source
// changed without a rebuild + manifest regeneration — which is exactly how
// the checked-in wasm went stale in #257. CI enforces it via
// scripts/check-cad-engine-wasm.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_WASM_FILE,
  MANIFEST_FORMAT,
  MANIFEST_REL,
  WASM_REL,
  hashRustSource,
  repoRoot,
  sha256File,
} from "./cad-engine-manifest.mjs";

/** Read the bridge version the wasm itself reports. Throws when the artifact is unreadable. */
export async function readWasmBridgeVersion(wasmAbs) {
  const bytes = fs.readFileSync(wasmAbs);
  let instance;
  try {
    ({ instance } = await WebAssembly.instantiate(bytes, {}));
  } catch (e) {
    throw new Error(`cannot instantiate ${path.basename(wasmAbs)}: ${e.message}`);
  }
  const ex = instance.exports;
  const versionFn = ex.obim_engine_version;
  if (typeof versionFn !== "function") {
    throw new Error(`${path.basename(wasmAbs)} has no obim_engine_version export`);
  }
  const ptr = versionFn();
  const dv = new DataView(ex.memory.buffer);
  const len = dv.getUint32(ptr, true);
  const text = new TextDecoder().decode(
    new Uint8Array(ex.memory.buffer, ptr + 4, len),
  );
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path.basename(wasmAbs)} reports a non-JSON identity: ${text}`);
  }
  const bridge = parsed?.bridge;
  if (typeof bridge !== "string" || !bridge.trim()) {
    throw new Error(`${path.basename(wasmAbs)} reports no bridge version: ${text}`);
  }
  return bridge;
}

export async function generateCadEngineManifest(root, opts = {}) {
  const wasmAbs = path.join(root, WASM_REL);
  if (!fs.existsSync(wasmAbs)) {
    throw new Error(
      `no wasm artifact at ${WASM_REL} — build it first: cd cad-engine-rust && cargo build --release --target wasm32-unknown-unknown`,
    );
  }
  const builtAt = opts.builtAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(builtAt))) {
    throw new Error(`--built-at must be an ISO-8601 timestamp, got ${JSON.stringify(builtAt)}`);
  }
  const bridgeVersion = await readWasmBridgeVersion(wasmAbs);
  const manifest = {
    format: MANIFEST_FORMAT,
    wasmFile: EXPECTED_WASM_FILE,
    wasmSha256: sha256File(wasmAbs),
    rustSourceHash: hashRustSource(root),
    bridgeVersion,
    builtAt,
    generator:
      "scripts/generate-cad-engine-manifest.mjs (hash-only; no cargo required — run immediately after a cargo build + copy)",
    note: "Attestation, not a rebuild proof: this manifest asserts the checked-in wasm was built from the Rust source with the recorded hash. It cannot prove a rebuild happened — a stale manifest paired with a stale wasm still passes. What it catches is source drift (Rust changed, wasm + manifest not regenerated). builtAt is the manifest-generation time; for a fresh build that is the build time. The checked-in artifact's original build time was never recorded.",
  };
  const outAbs = path.join(root, MANIFEST_REL);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const builtAtIdx = args.indexOf("--built-at");
  const builtAt = builtAtIdx >= 0 ? args[builtAtIdx + 1] : undefined;
  if (builtAtIdx >= 0 && !builtAt) {
    console.error("[cad-engine-manifest] ERROR: --built-at needs an ISO-8601 value.");
    process.exit(1);
  }
  generateCadEngineManifest(repoRoot(), builtAt ? { builtAt } : {})
    .then((manifest) => {
      console.log(
        `[cad-engine-manifest] wrote ${MANIFEST_REL} (bridge ${manifest.bridgeVersion}, ` +
          `wasm sha256 ${String(manifest.wasmSha256).slice(0, 12)}…, ` +
          `rust source ${String(manifest.rustSourceHash).slice(0, 12)}…, builtAt ${manifest.builtAt})`,
      );
    })
    .catch((e) => {
      console.error(`[cad-engine-manifest] ERROR: ${e.message}`);
      process.exit(1);
    });
}
