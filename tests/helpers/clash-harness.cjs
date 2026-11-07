// Compiles the pure clash modules with tsc and loads them in Node with a mini three.js.
const { execSync } = require("child_process"); const fs = require("fs"); const os = require("os"); const path = require("path"); const Module = require("module");
const root = path.join(__dirname, "..", "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "clash-"));
const srcs = ["src/modules/clash/clash-core.ts", "src/modules/clash/grouping.ts"].map((f) => path.join(root, f));
execSync(`npx tsc ${srcs.join(" ")} --outDir ${out} --rootDir ${root} --module commonjs --target es2020 --lib es2020,dom --skipLibCheck --noResolve false --moduleResolution node --ignoreDeprecations 5.0 --noEmitOnError false 2>/dev/null || true`, { cwd: root, shell: "/bin/bash", stdio: "ignore" });
const three = path.join(__dirname, "three-mini.cjs");
const ctxStub = path.join(out, "ctx-stub.js");
fs.writeFileSync(ctxStub, "exports.ctx={world:{scene:{three:{updateMatrixWorld(){}}}}};");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...r) {
  if (req === "three") return three;
  if (/core\/context$/.test(req)) return ctxStub;
  return orig.call(this, req, parent, ...r);
};
const load = (rel) => require(path.join(out, "src", rel));
module.exports = { THREE: require(three), core: () => load("modules/clash/clash-core.js"), grouping: () => load("modules/clash/grouping.js"), load, out };
