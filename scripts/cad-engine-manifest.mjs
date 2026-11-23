// Shared helpers for the CAD-engine wasm staleness attestation (PE-12).
//
// The checked-in wasm (public/cad-engine/obim-cad-engine.wasm) cannot be
// rebuilt on hosts without a Rust toolchain (this VM, Vercel), so no check
// here rebuilds it or byte-compares against a fresh build. Instead the
// checked-in artifact carries a MANIFEST attestation
// (public/cad-engine/obim-cad-engine.manifest.json) recording the hash of
// the Rust source it was built from and the hash of the wasm itself.
// scripts/check-cad-engine-wasm.mjs verifies the attestation holds; if the
// Rust source changes without a rebuild + manifest regeneration, CI fails.
//
// The source hash covers every file under cad-engine-rust/ except target/
// (build output — hashing it would make every build look like source drift).
// Files are hashed in sorted relative-path order so the result is stable
// across checkouts and operating systems.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_FORMAT = "obim-cad-engine-manifest/1";
export const WASM_REL = path.join("public", "cad-engine", "obim-cad-engine.wasm");
export const MANIFEST_REL = path.join(
  "public",
  "cad-engine",
  "obim-cad-engine.manifest.json",
);
export const RUST_DIR_REL = "cad-engine-rust";
export const EXPECTED_WASM_FILE = "obim-cad-engine.wasm";

/** Repo root, resolved from this file's location (scripts/cad-engine-manifest.mjs). */
export function repoRoot() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function sha256File(absPath) {
  return createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}

function collectRustSourceFiles(rustDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "target") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(rustDir, full).split(path.sep).join("/"));
    }
  };
  walk(rustDir);
  out.sort();
  return out;
}

/**
 * Deterministic hash of the Rust source tree: sha256 over one line per file,
 * "<relative-posix-path>\0<sha256-of-file>\n", in sorted path order.
 * Changing, adding, removing or renaming any source file changes the hash;
 * build output under target/ is excluded.
 */
export function hashRustSource(root) {
  const rustDir = path.join(root, RUST_DIR_REL);
  if (!fs.existsSync(rustDir)) {
    throw new Error(`Rust source directory not found: ${RUST_DIR_REL}`);
  }
  const combined = createHash("sha256");
  for (const rel of collectRustSourceFiles(rustDir)) {
    const fileHash = sha256File(path.join(rustDir, ...rel.split("/")));
    combined.update(`${rel}\0${fileHash}\n`, "utf8");
  }
  return combined.digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Field-level validation of a parsed manifest. Returns error strings (empty = valid). */
export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest is not a JSON object"];
  }
  const m = manifest;
  if (m.format !== MANIFEST_FORMAT) {
    errors.push(`format must be "${MANIFEST_FORMAT}", got ${JSON.stringify(m.format)}`);
  }
  if (m.wasmFile !== EXPECTED_WASM_FILE) {
    errors.push(`wasmFile must be "${EXPECTED_WASM_FILE}", got ${JSON.stringify(m.wasmFile)}`);
  }
  if (typeof m.wasmSha256 !== "string" || !HEX64.test(m.wasmSha256)) {
    errors.push("wasmSha256 must be a 64-character lowercase hex sha256");
  }
  if (typeof m.rustSourceHash !== "string" || !HEX64.test(m.rustSourceHash)) {
    errors.push("rustSourceHash must be a 64-character lowercase hex sha256");
  }
  if (typeof m.bridgeVersion !== "string" || !m.bridgeVersion.trim()) {
    errors.push("bridgeVersion must be a non-empty string");
  }
  if (typeof m.builtAt !== "string" || Number.isNaN(Date.parse(m.builtAt))) {
    errors.push(`builtAt must be an ISO-8601 timestamp, got ${JSON.stringify(m.builtAt)}`);
  }
  return errors;
}

/** Read and parse the manifest, throwing a plain-English error when it is missing or malformed. */
export function readManifest(root) {
  const abs = path.join(root, MANIFEST_REL);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `missing ${MANIFEST_REL} — regenerate it with: node scripts/generate-cad-engine-manifest.mjs`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`cannot parse ${MANIFEST_REL}: ${e.message}`);
  }
  const errors = validateManifest(parsed);
  if (errors.length) {
    throw new Error(`invalid ${MANIFEST_REL}: ${errors.join("; ")}`);
  }
  return parsed;
}
