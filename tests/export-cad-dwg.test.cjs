/* Views -> CAD, DWG path, in the real committed CAD WASM (Node, no mocks):
 * a Scene2D is converted by sceneToDxfDocument, written as DXF, converted to binary DWG by the real writer, read back by
 * the real reader. Also records what happens to a 3D DXF (3DFACE) so the dialog only offers what works.
 * Proves OUR converter keeps the content; it does not prove AutoCAD opens the file. */
const fs = require("fs"), path = require("path"), assert = require("assert");
const { execSync } = require("child_process");
const root = path.join(__dirname, "..");
const wasmPath = path.join(root, "public", "cad-engine", "obim-cad-engine.wasm");
if (!fs.existsSync(wasmPath)) { console.log("SKIP: CAD engine wasm missing"); process.exit(0); }
const out = fs.mkdtempSync(path.join(root, ".dwg-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
const cleanup = () => fs.rmSync(out, { recursive: true, force: true });
try {
  execSync(`npx tsc src/modules/export/view-to-cad.ts src/modules/export/model-to-dxf3d.ts src/modules/drawings/acad-engine.ts src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop --lib es2020,dom`, { cwd: root, stdio: "pipe" });
  const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
  const A = require(find(out, "acad-engine.js")), W = require(find(out, "dxf-writer.js")), V = require(find(out, "view-to-cad.js")), M = require(find(out, "model-to-dxf3d.js"));
  (async () => {
    let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
    const wasm = fs.readFileSync(wasmPath);
    ok(await A.setAcadEngineForTests(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)), "engine loads");
    const st = (c = "#111827", w = 0.5, d = null) => ({ color: c, widthPt: w, dash: d });
    const scene = { bounds: { minX: 0, minZ: 0, maxX: 10, maxZ: 5 }, generatedAt: 0, layers: {
      cut: [{ kind: "polyline", closed: true, points: [[0, 0], [4, 0], [4, 0.2], [0, 0.2]], stroke: st(), fill: { color: "#888888", opacity: 1 } }, { kind: "line", x1: 0, z1: 0, x2: 10, z2: 0, stroke: st("#ff0000", 0.35, [4, 2]) }],
      project: [{ kind: "arc", cx: 1, cz: 1, r: 0.5, a0: 0, a1: Math.PI / 2, stroke: st() }, { kind: "circle", cx: 2, cz: 2, r: 0.25, stroke: st() }],
      overhead: [], below: [], grid: [{ kind: "line", x1: 5, z1: -1, x2: 5, z2: 6, stroke: st("#00ff00", 0.18, [8, 2]) }],
      annotation: [{ kind: "text", x: 1, z: 3, text: "Room 101", anchor: "start", sizePt: 7, rotation: 0, color: "#000000" }],
      symbols: [{ kind: "hatch", polygon: [[0, 0], [1, 0], [1, 1]], pattern: "ANSI31", color: "#444444", scale: 1 }],
    } };
    const { doc } = V.sceneToDxfDocument(scene, { units: "mm", scale: 100, title: "Level 1" });
    const dxf = W.writeDxf(doc);
    const dwg = await A.exportDxfToDwg(dxf);
    ok(Buffer.from(dwg.subarray(0, 6)).toString().startsWith("AC10"), "binary DWG signature");
    const back = (await A.parseWithAcadEngine(dwg, "view.dwg")).doc;
    const names = back.layers.map((l) => l.name);
    ok(["A-CUT", "A-PROJ", "A-GRID", "A-ANNO", "A-SYMB"].every((l) => names.includes(l)), "layers survive: " + names.join(","));
    const cnt = (t) => back.entities.filter((e) => e.type === t).length;
    ok(cnt("LINE") >= 2 && cnt("ARC") === 1 && cnt("CIRCLE") === 1 && cnt("TEXT") >= 2, `entities survive (LINE ${cnt("LINE")} ARC ${cnt("ARC")} CIRCLE ${cnt("CIRCLE")} TEXT ${cnt("TEXT")})`);
    ok(back.entities.some((e) => e.hatch && e.hatch.solid) && back.entities.some((e) => e.hatch && !e.hatch.solid), "solid and patterned hatches survive");
    const room = back.entities.find((e) => e.type === "TEXT" && e.value === "Room 101");
    ok(room && Math.abs(room.height - 7 * 25.4 / 72 * 100) < 0.5, "text height survives (" + (room && room.height) + ")");
    const red = back.entities.find((e) => e.type === "LINE" && e.rgb === 0xff0000);
    ok(red && red.lineType === "DASHED", "true colour and dashed linetype survive");
    const l10 = back.entities.filter((e) => e.type === "LINE" && e.layer === "A-CUT")[0];
    ok(l10 && Math.abs(Math.max(l10.start.x, l10.end.x) - 10000) < 1e-6, "mm coordinates survive");
    // 3D DXF through the DWG writer: record the truth.
    const m3 = M.meshesToDxf3d([{ layer: "A-WALL", positions: [0,0,0, 1,0,0, 0,1,0], index: null }], { units: "mm" });
    let three = "unsupported";
    try { const d3 = await A.exportDxfToDwg(m3.dxf); const b3 = (await A.parseWithAcadEngine(d3, "m.dwg")).doc; three = b3.entities.length ? `converted, first entity points ${JSON.stringify((b3.entities[0].points||[]).map((p) => [p.x, p.y, p.z]))} (${b3.entities.length} entities read back: ${[...new Set(b3.entities.map((e) => e.type))].join(",")})` : "converted but empty"; } catch (e) { three = "failed: " + e.message; }
    console.log("  3D DXF -> DWG: " + three);
    console.log(`export-cad-dwg: ${n} assertions passed`);
    cleanup();
  })().catch((e) => { cleanup(); console.error(e); process.exit(1); });
} catch (e) { cleanup(); console.error(String(e.stdout || e)); process.exit(1); }
