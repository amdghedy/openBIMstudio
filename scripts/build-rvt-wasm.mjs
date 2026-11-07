// Builds the Revit reader (rvt-rs, Apache-2.0) to WebAssembly into public/rvt/.
//   node scripts/build-rvt-wasm.mjs        (npm run build:rvt)
// Needs: git, Rust (stable) with the wasm32-unknown-unknown target, and wasm-pack
// (cargo install wasm-pack --locked). Output: public/rvt/rvt.js + rvt_bg.wasm.
// The pinned commit is the one the viewer feature was written against; bump it
// deliberately and re-test with a real .rvt file (docs/RVT-VIEWER.md).
// Missing tools are reported and the script exits 0 unless --strict is given,
// so a plain `npm run build` never fails because of this optional feature.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RVT_RS_REPO = "https://github.com/DrunkOnJava/rvt-rs";
export const RVT_RS_COMMIT = "ab5f8e1c07a1549da31454dd834d07100b667974";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "rvt");
const strict = process.argv.includes("--strict");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  return r.status === 0;
}
function have(cmd, args = ["--version"]) {
  return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
}
function skip(msg) {
  console.log(`[rvt] ${msg}`);
  console.log("[rvt] The Revit viewer will report itself as not installed on this build. See docs/RVT-VIEWER.md.");
  process.exit(strict ? 1 : 0);
}

if (!have("git")) skip("git not found.");
if (!have("cargo")) skip("Rust (cargo) not found.");
if (!have("wasm-pack")) skip("wasm-pack not found (cargo install wasm-pack --locked).");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "rvt-rs-"));
try {
  const ok =
    run("git", ["init", "-q", work]) &&
    run("git", ["-C", work, "fetch", "-q", "--depth", "1", RVT_RS_REPO, RVT_RS_COMMIT]) &&
    run("git", ["-C", work, "checkout", "-q", "FETCH_HEAD"]);
  if (!ok) skip(`could not fetch ${RVT_RS_REPO} at ${RVT_RS_COMMIT}.`);
  const head = spawnSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  if (head !== RVT_RS_COMMIT) skip(`fetched ${head}, expected ${RVT_RS_COMMIT}.`);
  fs.mkdirSync(out, { recursive: true });
  const built = run("wasm-pack", ["build", "rvt-wasm", "--release", "--target", "web", "--out-dir", out, "--out-name", "rvt"], { cwd: work });
  if (!built) skip("wasm-pack build failed.");
  for (const f of ["rvt.js", "rvt_bg.wasm"]) if (!fs.existsSync(path.join(out, f))) skip(`${f} missing after build.`);
  console.log(`[rvt] built rvt-rs ${RVT_RS_COMMIT.slice(0, 7)} -> public/rvt/ (${(fs.statSync(path.join(out, "rvt_bg.wasm")).size / 1024).toFixed(0)} KB wasm)`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
