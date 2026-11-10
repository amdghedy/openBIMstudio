// view-to-cad: Scene2D -> DXF document, real DXF text, ZIP store (pure logic; no browser).
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(root, ".vtc-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
try {
  execSync(`npx tsc src/modules/export/view-to-cad.ts src/modules/export/zip-store.ts src/modules/drawings/dxf-writer.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --lib es2020,dom --moduleResolution node`, { stdio: "pipe", cwd: root });
  const V = require(path.join(out, "export/view-to-cad.js"));
  const Z = require(path.join(out, "export/zip-store.js"));
  const W = require(path.join(out, "drawings/dxf-writer.js"));
  let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
  const near = (a, b, e = 1e-6) => ok(Math.abs(a - b) < e, `${a} ~ ${b}`);
  const st = (c = "#111827", w = 0.5, d = null) => ({ color: c, widthPt: w, dash: d });
  const scene = { bounds: { minX: 0, minZ: 0, maxX: 10, maxZ: 5 }, generatedAt: 0, layers: {
    cut: [{ kind: "polyline", closed: true, points: [[0, 0], [4, 0], [4, 0.2], [0, 0.2]], stroke: st(), fill: { color: "#888888", opacity: 1 } }, { kind: "line", x1: 0, z1: 0, x2: 10, z2: 0, stroke: st("#ff0000", 0.35, [4, 2]) }],
    project: [{ kind: "polyline", closed: false, points: [[0, 1], [2, 1], [2, 2]], stroke: st() }, { kind: "arc", cx: 1, cz: 1, r: 0.5, a0: 0, a1: Math.PI / 2, stroke: st() }, { kind: "arc", cx: 1, cz: 1, r: 0.5, a0: Math.PI / 2, a1: 0, stroke: st() }, { kind: "circle", cx: 2, cz: 2, r: 0.25, stroke: st() }],
    overhead: [], below: [], grid: [{ kind: "line", x1: 5, z1: -1, x2: 5, z2: 6, stroke: st("#00ff00", 0.18, [8, 2]) }],
    annotation: [{ kind: "text", x: 1, z: 3, text: "Room 101", anchor: "middle", sizePt: 7, rotation: 0, color: "#000000", leader: true, leaderTarget: [2, 2] }],
    symbols: [{ kind: "symbol", x: 3, z: 3, name: "door", size: 0.9, rotation: 0 }, { kind: "hatch", polygon: [[0, 0], [1, 0], [1, 1]], pattern: "ANSI31", color: "#444444", scale: 1 }],
  } };
  const mm = V.sceneToDxfDocument(scene, { units: "mm", scale: 100, title: "Level 1" });
  const m = V.sceneToDxfDocument(scene, { units: "m", scale: 100 });
  ok(mm.stats.entities === m.stats.entities + 1, "title adds one entity");
  const byType = (r, t) => r.doc.entities.filter((e) => e.type === t);
  const line = byType(mm, "LINE").find((e) => e.layer === "A-CUT");
  near(line.end.x, 10000); near(byType(m, "LINE").find((e) => e.layer === "A-CUT").end.x, 10);
  ok(line.rgb === 0xff0000 && line.lineType === "DASHED", "stroke colour true-colour, dashed linetype");
  near(line.lineweight, 0.12, 0.01);
  ok(mm.doc.layers.some((l) => l.name === "A-GRID") && !mm.doc.layers.some((l) => l.name === "A-OVHD"), "only used layers declared");
  const arcs = byType(mm, "ARC");
  ok(arcs.length === 2 && arcs.every((a) => Math.abs(a.startAngle) < 1e-6 && Math.abs(a.endAngle - 90) < 1e-6), "clockwise arc normalised to CCW");
  const fillPoly = byType(mm, "LWPOLYLINE").find((e) => e.hatch && e.hatch.solid);
  ok(fillPoly && fillPoly.closed && fillPoly.rgb === 0x888888, "filled polyline becomes a solid hatch");
  const txt = byType(mm, "TEXT").find((e) => e.value === "Room 101");
  near(txt.height, 7 * 25.4 / 72 * 100, 0.01); ok(txt.align === "center", "text height = paper size x scale (mm)");
  ok(byType(mm, "LINE").some((e) => e.layer === "A-ANNO"), "leader line written");
  ok(byType(mm, "CIRCLE").length === 2 && byType(mm, "TEXT").some((e) => e.value === "door"), "symbol -> circle + label");
  ok(mm.doc.entities.some((e) => e.type === "LWPOLYLINE" && e.hatch && e.hatch.pattern === "ANSI31"), "hatch pattern kept");
  const pref = V.sceneToDxfDocument(scene, { layerPrefix: "ARC-" });
  ok(pref.doc.layers.filter((l) => l.name !== "0").every((l) => l.name.startsWith("ARC-")), "layer prefix");
  const only = V.sceneToDxfDocument(scene, { include: { grid: false, annotation: false, symbols: false } });
  ok(!only.doc.entities.some((e) => e.layer === "A-GRID" || e.layer === "A-ANNO"), "layer include filter");
  const text = W.writeDxf(mm.doc, { version: "AC1027" });
  ok(/^\s*0\r?\nSECTION/.test(text) && /EOF\s*$/.test(text), "writes a complete DXF");
  ok(text.includes("A-CUT") && text.includes("Room 101") && text.includes("DASHED"), "DXF contains layers, text and the linetype");
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  ok(lines.includes("LWPOLYLINE") && lines.includes("HATCH") && lines.includes("ARC") && lines.includes("CIRCLE") && lines.includes("TEXT"), "DXF has LWPOLYLINE, HATCH, ARC, CIRCLE and TEXT entities");
  ok(V.cadFileName("Plan: Level 1/2", "dwg") === "Plan_Level_1_2.dwg", "safe file names");
  const used = new Set(); V.cadFileName("A", "dxf", used); ok(V.cadFileName("A", "dxf", used) === "A_2.dxf", "unique names");
  // zip
  const zip = Z.zipStore([{ name: "a.txt", data: new TextEncoder().encode("hello") }, { name: "b.dxf", data: new TextEncoder().encode("0\nEOF\n") }]);
  const dv = new DataView(zip.buffer, zip.byteOffset);
  ok(dv.getUint32(0, true) === 0x04034b50 && dv.getUint16(zip.length - 22 + 10, true) === 2, "zip signature and 2 entries");
  ok(Z.crc32(new TextEncoder().encode("123456789")) === 0xcbf43926, "crc32 check value");
  try { fs.writeFileSync(path.join(out, "t.zip"), zip); const r = execSync(`python3 -c "import zipfile;z=zipfile.ZipFile('${path.join(out, "t.zip")}');assert z.testzip() is None;print(z.read('a.txt').decode())"`).toString().trim(); ok(r === "hello", "python reads the zip back"); } catch (e) { if (!/python3/.test(String(e))) throw e; }
  console.log(`view-to-cad: ${n} assertions passed`);
} finally { fs.rmSync(out, { recursive: true, force: true }); }
