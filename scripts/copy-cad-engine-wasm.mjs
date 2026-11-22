// Copies the acadrust WASM bridge next to the app (public/cad-engine/) so the
// native-grade DXF/DWG reader can load it from "/cad-engine/obim-cad-engine.wasm".
//
// The artifact is built from cad-engine-rust/ (MPL-2.0, wraps acadrust):
//   cd cad-engine-rust && cargo build --release --target wasm32-unknown-unknown
//
// PE-12: this script FAILS (non-zero exit, loud error) when no fresh build
// exists. It used to silently keep the checked-in copy, which is how a stale
// wasm reached users in #257 — the copy step looked green while serving an
// artifact built from older Rust source. A missing fresh build is now a hard
// error, not a warning.
//
// Wiring note: this script is therefore NOT run from the npm predev/prebuild
// hooks — those hooks also run on hosts without cargo (Vercel, cargo-less dev
// machines), where failing the build would be wrong and the checked-in wasm
// is the artifact by design (its attestation is verified by CI instead, see
// scripts/check-cad-engine-wasm.mjs). The script runs explicitly in CI and
// in the deploy workflow, after the cargo build step, where a missing fresh
// build is a real failure. Do not re-add it to prebuild without a cargo
// guard, or Vercel deploys will break.
//
// On success the script also regenerates the manifest attestation
// (public/cad-engine/obim-cad-engine.manifest.json) for the staged wasm, so
// a fresh build never lands with a stale manifest. Commit both the wasm and
// the manifest together.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./cad-engine-manifest.mjs";
import { generateCadEngineManifest } from "./generate-cad-engine-manifest.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = path.join(
  root,
  "cad-engine-rust",
  "target",
  "wasm32-unknown-unknown",
  "release",
  "obim_cad_engine.wasm",
);
const destDir = path.join(root, "public", "cad-engine");
const dest = path.join(destDir, "obim-cad-engine.wasm");

if (!fs.existsSync(built)) {
  console.error(
    `[cad-engine] ERROR: no fresh build found at ${path.relative(root, built)} — ` +
      `refusing to keep a possibly-stale checked-in copy in public/cad-engine/. ` +
      `Build it first: cd cad-engine-rust && cargo build --release --target wasm32-unknown-unknown — then re-run this script. ` +
      `Hosts without cargo (Vercel, cargo-less dev machines) must not run this script at all; they serve the checked-in wasm, whose manifest attestation CI verifies (node scripts/check-cad-engine-wasm.mjs).`,
  );
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(built, dest);
const builtHash = sha256File(built);
const destHash = sha256File(dest);
if (builtHash !== destHash) {
  console.error(
    `[cad-engine] ERROR: copied wasm hash mismatch (built ${builtHash}, copied ${destHash}) — the staged artifact is corrupt, refusing to continue.`,
  );
  process.exit(1);
}
const kb = Math.round(fs.statSync(dest).size / 1024);
console.log(`[cad-engine] copied obim-cad-engine.wasm (${kb} KiB, sha256 ${destHash.slice(0, 12)}…) to ${path.relative(root, dest)}`);

try {
  const manifest = await generateCadEngineManifest(root);
  console.log(
    `[cad-engine] regenerated manifest attestation (bridge ${manifest.bridgeVersion}, builtAt ${manifest.builtAt}) — commit the wasm and the manifest together.`,
  );
} catch (e) {
  console.error(
    `[cad-engine] ERROR: staged the wasm but failed to regenerate its manifest attestation: ${e.message} — ` +
      `the next CI check would fail; fix the manifest generation before committing.`,
  );
  process.exit(1);
}
