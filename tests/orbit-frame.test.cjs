// orbit-frame: frame coalescing and upright restore (pure logic; no browser).
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "orbitframe-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
let src = fs.readFileSync(path.join(__dirname, "..", "src/core/orbit-frame.ts"), "utf8").replace(/^import \* as THREE.*$/m, "");
src = src.replace("const up = cam.up as THREE.Vector3;", "const up = cam.up as { x: number; y: number; z: number; set(x: number, y: number, z: number): void };");
fs.writeFileSync(path.join(out, "orbit-frame.ts"), src);
try { execSync(`npx tsc ${path.join(out, "orbit-frame.ts")} --module commonjs --target es2020 --skipLibCheck --lib es2020,dom`, { stdio: "pipe" }); } catch (e) { console.error(String(e.stdout)); throw e; }
const M = require(path.join(out, "orbit-frame.js"));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const frames = []; global.requestAnimationFrame = (f) => { frames.push(f); return frames.length; }; global.cancelAnimationFrame = () => {};
const calls = []; const c = M.frameCoalesced((a, b) => calls.push([a, b]));
for (let i = 0; i < 100; i++) c.push(i, -i);
ok(calls.length === 0 && frames.length === 1, "100 pointer events schedule one frame");
frames.shift()(0);
ok(calls.length === 1 && calls[0][0] === 99, "only the latest arguments are applied");
c.push(5, 5); c.flush(); ok(calls.length === 2 && calls[1][0] === 5, "flush applies immediately");
frames.length = 0; c.push(7, 7); c.cancel(); ok(calls.length === 2, "cancel drops pending");
const cam = { up: { x: 0, y: 0, z: -1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } } }; let rebuilt = 0;
ok(M.ensureUprightForOrbit(cam, { updateCameraUp: () => rebuilt++ }) && cam.up.y === 1 && cam.up.z === 0 && rebuilt === 1, "tilted up restored to +Y and basis rebuilt");
ok(M.ensureUprightForOrbit(cam, { updateCameraUp: () => rebuilt++ }) === false && rebuilt === 1, "already upright: no change");
fs.rmSync(out, { recursive: true, force: true });
console.log(`orbit-frame: ${n} assertions passed`);
