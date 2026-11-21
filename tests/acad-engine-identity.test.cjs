/* The wasm staged for this build must report the DWG failsafe capability the app requires.
   STRICT everywhere: hosts that do not run cargo (Vercel, Cloudflare Workers Builds) serve the checked-in wasm, so a stale copy here reaches users (user console: bridge 0.1.0 without dwgRead). */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
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
  console.log(ok ? "acad-engine-identity: 1 passed" : "acad-engine-identity: stale local wasm (not enforced outside CI)");
})();
