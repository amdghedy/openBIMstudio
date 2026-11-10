const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cad-array-modes-"));
process.on("exit", () => { try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* */ } });

execSync(
  "npx tsc src/modules/cad-viewer/modify-math.ts --outDir " + JSON.stringify(OUT) + " --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0",
  { cwd: ROOT, stdio: "pipe" },
);
const find = (dir, name) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const hit = find(p, name); if (hit) return hit; }
    else if (entry.name === name) return p;
  }
};
const X = require(find(OUT, "modify-math.js"));
const line = { type: "LINE", layer: "A-WALL", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } };
const close = (a, b, eps = 1e-7) => assert.ok(Math.abs(a - b) <= eps, String(a) + " != " + String(b));

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (error) { fail++; console.error("  FAIL " + name + ": " + error.message); }
};

test("rectangular array places row and column copies without mutating its source", () => {
  const copies = X.rectangularArrayCopies([line], 2, 3, 5, 20);
  assert.strictEqual(copies.length, 5);
  close(copies[0].start.x, 20);
  close(copies[0].start.y, 0);
  close(copies[1].start.x, 40);
  close(copies[2].start.x, 0);
  close(copies[2].start.y, 5);
  close(line.start.x, 0);
});

test("rectangular array supports negative spacing and validates limits", () => {
  const copies = X.rectangularArrayCopies([line], 1, 2, 0, -15);
  close(copies[0].start.x, -15);
  assert.throws(() => X.rectangularArrayCopies([line], 1.5, 2, 1, 1), /positive integers/);
  assert.throws(() => X.rectangularArrayCopies([line], 1, 1, 1, 1), /at least 2/);
  assert.throws(() => X.rectangularArrayCopies([line], 10001, 1, 1, 1), /safety limit/);
});

test("full-circle polar array omits the duplicate 360-degree placement", () => {
  const copies = X.polarArrayCopies([line], { x: 0, y: 0 }, { x: 5, y: 0 }, 4, 360, false);
  assert.strictEqual(copies.length, 3);
  close(copies[0].start.x, -5);
  close(copies[0].start.y, 5);
  close(copies[1].start.x, -10);
  close(copies[2].start.x, -5);
  close(copies[2].start.y, -5);
});

test("polar array can keep source orientation or rotate copies around the center", () => {
  const source = { ...line, start: { x: 10, y: 0 }, end: { x: 12, y: 0 } };
  const center = { x: 0, y: 0 }, base = { x: 10, y: 0 };
  const kept = X.polarArrayCopies([source], center, base, 3, 180, false);
  close(kept[0].start.x, 0); close(kept[0].start.y, 10);
  close(kept[0].end.x, 2); close(kept[0].end.y, 10);
  const rotated = X.polarArrayCopies([source], center, base, 3, 180, true);
  close(rotated[0].start.x, 0); close(rotated[0].start.y, 10);
  close(rotated[0].end.x, 0); close(rotated[0].end.y, 12);
  close(rotated[1].start.x, -10); close(rotated[1].start.y, 0);
});

test("polar array rejects invalid centers, counts, sweeps and oversized output", () => {
  assert.throws(() => X.polarArrayCopies([line], { x: NaN, y: 0 }, { x: 0, y: 0 }, 3), /finite/);
  assert.throws(() => X.polarArrayCopies([line], { x: 0, y: 0 }, { x: 0, y: 0 }, 1), /at least 2/);
  assert.throws(() => X.polarArrayCopies([line], { x: 0, y: 0 }, { x: 0, y: 0 }, 3, 720), /no more than 360/);
  assert.throws(() => X.polarArrayCopies(Array(4000).fill(line), { x: 0, y: 0 }, { x: 0, y: 0 }, 4), /safety limit/);
});

test("path array samples corners at true distance along an open polyline", () => {
  const route = { type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
  const copies = X.pathArrayCopies([line], route, 5, false);
  assert.strictEqual(copies.length, 3);
  close(copies[0].start.x, 5); close(copies[0].start.y, 0);
  close(copies[1].start.x, 10); close(copies[1].start.y, 0);
  close(copies[2].start.x, 10); close(copies[2].start.y, 5);
});

test("path array rotates each copy to follow the local path tangent when enabled", () => {
  const route = { type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
  const copies = X.pathArrayCopies([line], route, 12, true);
  assert.strictEqual(copies.length, 1);
  close(copies[0].start.x, 10); close(copies[0].start.y, 2);
  close(copies[0].end.x, 10); close(copies[0].end.y, 12);
});

test("closed path array avoids duplicating the path origin", () => {
  const square = { type: "LWPOLYLINE", layer: "0", closed: true, points: [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
  ] };
  const copies = X.pathArrayCopies([line], square, 10, false);
  assert.strictEqual(copies.length, 3);
  close(copies[2].start.x, 0); close(copies[2].start.y, 10);
});

test("path array validates spacing, unsupported boundaries and output limits", () => {
  const route = { type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
  assert.throws(() => X.pathArrayCopies([line], route, 0), /positive finite/);
  assert.throws(() => X.pathArrayCopies([line], route, 20), /longer than the path/);
  assert.throws(() => X.pathArrayCopies([line], { ...route, hatch: { solid: true, loops: [] } }, 2), /requires/);
  assert.throws(() => X.pathArrayCopies(Array(4000).fill(line), route, 1), /safety limit/);
});

test("command registry, dispatcher and ribbon expose all array modes", () => {
  const viewer = fs.readFileSync(path.join(ROOT, "src/features/cad-viewer.ts"), "utf8");
  for (const token of [
    '{ name: "ARRAY", aliases: ["AR"]',
    '{ name: "ARRAYPOLAR", aliases: ["ARRAYCIRCULAR", "AP"]',
    '{ name: "ARRAYPATH", aliases: ["PATHARRAY", "APATH"]',
    'arrayCommand(parts[1])',
    'arrayCommand(cmd === "ARRAYPOLAR" ? "POLAR" : "PATH")',
    'data-a="array"',
    'array: () => arrayCommand()',
    'X.rectangularArrayCopies',
    'X.polarArrayCopies',
    'X.pathArrayCopies',
  ]) assert.ok(viewer.includes(token), "missing CAD array wiring: " + token);
});

console.log("cad-array-modes: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
