
const fs = require("fs");
const path = require("path");
const src = path.join(__dirname, "..", "node_modules", "web-ifc");
const dest = path.join(__dirname, "..", "public", "web-ifc");
if (!fs.existsSync(src)) {
  console.warn("[copy-wasm] node_modules/web-ifc missing — run npm install");
  process.exit(0);
}
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(src)) {
  const from = path.join(src, f);
  if (!fs.statSync(from).isFile()) continue;
  if (/\.(wasm|js|mjs|data)$/i.test(f) || f.startsWith("web-ifc")) {
    fs.copyFileSync(from, path.join(dest, f));
  }
}
const wasm = path.join(dest, "web-ifc.wasm");
console.log(fs.existsSync(wasm) ? "[copy-wasm] OK " + wasm : "[copy-wasm] FAILED — web-ifc.wasm not found");
