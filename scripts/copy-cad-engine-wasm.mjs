// Copies the acadrust WASM bridge next to the app (public/cad-engine/) so the
// native-grade DXF/DWG reader can load it from "/cad-engine/obim-cad-engine.wasm".
//
// The artifact is built from cad-engine-rust/ (MPL-2.0, wraps acadrust):
//   cd cad-engine-rust && cargo build --release --target wasm32-unknown-unknown
// If cargo is unavailable the checked-in copy in public/cad-engine/ is kept as-is,
// so installs and CI never fail because of this script.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const have = fs.existsSync(dest);
  console.log(
    `[cad-engine] no fresh build found (${path.relative(root, built)}); ` +
      (have
        ? "keeping the checked-in copy in public/cad-engine/."
        : "WARNING: no wasm artifact available - the CAD reader will fall back to libredwg."),
  );
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(built, dest);
const kb = Math.round(fs.statSync(dest).size / 1024);
console.log(`[cad-engine] copied obim-cad-engine.wasm (${kb} KiB) to ${path.relative(root, dest)}`);
