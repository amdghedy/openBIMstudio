// OpenCADStudio absorption guards — "grab more options and functions":
//  1. license boundary — the GPL-3.0 OpenCADStudio app code is NOT copied; the
//     absorbed pieces carry their own license credits (dwg-thumbnailer is
//     MIT OR Apache-2.0; the kernel approach informed only the algorithm);
//  2. runtime — the embedded-DWG-preview parser, the CTB/STB plot-style
//     reader (against real ezdxf-generated fixtures), the LandXML CgPoint
//     importer and the curve-aware polyline offset are exercised for real;
//  3. wiring — every absorbed function is reachable from the UI/UX
//     (Plot dialog pen table, open/drop accept list, commands, app menu,
//     Info dialog, load-time preview placeholder).
const fs = require("fs"), path = require("path"), assert = require("assert");
const { execSync } = require("child_process");
const os = require("os");
const root = path.join(__dirname, "..");
let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log("  PASS " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
};
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

console.log("== ocs absorption: license boundary ==");

t("dwg-preview credits the MIT/Apache-2.0 dwg-thumbnailer crate", () => {
  const src = read("src", "modules", "drawings", "dwg-preview.ts");
  assert.ok(src.includes("MIT OR Apache-2.0"), "must credit dwg-thumbnailer's license");
  assert.ok(src.includes("crates/dwg-thumbnailer"), "must name the absorbed crate");
  assert.ok(src.includes("GPL-3.0"), "must state the app itself is GPL and not copied");
});

t("no OpenCADStudio GPL source is vendored anywhere", () => {
  // The app shell is GPL-3.0 — its Rust sources must never appear in this repo.
  const absorbed = [
    read("src", "modules", "drawings", "dwg-preview.ts"),
    read("src", "modules", "drawings", "plot-styles.ts"),
    read("src", "modules", "drawings", "landxml.ts"),
  ];
  for (const s of absorbed) {
    assert.ok(!s.includes("iced::"), "iced framework references leaked in");
    assert.ok(!/fn\s+\w+\s*\(\s*path:\s*&Path/.test(s), "Rust-style Path signatures leaked in");
  }
});

t("plot-styles documents the independent implementation + format source", () => {
  const src = read("src", "modules", "drawings", "plot-styles.ts");
  assert.ok(src.includes("GPL-3.0"), "must state OCS is GPL and its code is not copied");
  assert.ok(src.includes("ezdxf"), "must credit the ezdxf MIT add-on used for fixtures/format");
  assert.ok(src.includes("PIAFILEVERSION_2.0"), "must parse the documented magic header");
});

console.log("== ocs absorption: compile the absorbed modules ==");

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-absorb-"));
execSync(
  `npx tsc src/modules/drawings/dwg-preview.ts src/modules/drawings/plot-styles.ts` +
  ` src/modules/drawings/landxml.ts src/modules/cad-viewer/modify-math.ts` +
  ` --module commonjs --target es2020 --lib es2020,dom --esModuleInterop --skipLibCheck` +
  ` --outDir ${outDir}`,
  { cwd: root, stdio: "pipe" },
);
const previewMod = require(path.join(outDir, "drawings/dwg-preview.js"));
const plotMod = require(path.join(outDir, "drawings/plot-styles.js"));
const landMod = require(path.join(outDir, "drawings/landxml.js"));
const X = require(path.join(outDir, "cad-viewer/modify-math.js"));

console.log("== embedded DWG preview (dwg-thumbnailer port) ==");

/** Build a synthetic DWG with an embedded preview container at `base`. */
function synthDwgWithPreview(dib) {
  const head = Buffer.alloc(0x20);
  head.write("AC1015", 0, "latin1");
  const descriptors = [];
  const images = [];
  const imgOff = 0x20 + 16 + 4 + 1 + 9; // sentinel + size + count + one descriptor
  descriptors.push(Buffer.from([2])); // code 2 = BMP
  const start = Buffer.alloc(4);
  start.writeUInt32LE(imgOff, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(dib.length, 0);
  descriptors.push(start, size);
  const body = Buffer.concat([...images, Buffer.from(dib)]);
  // overall = everything between the [sentinel+size] header and the end
  // sentinel: count(1) + descriptors(9) + image body
  const overall = 1 + 9 + body.length;
  const sentinel = Buffer.from([0x1f, 0x25, 0x6d, 0x07, 0xd4, 0x36, 0x28, 0x28, 0x9d, 0x57, 0xca, 0x3f, 0x9d, 0x44, 0x10, 0x2b]);
  const container = Buffer.concat([
    sentinel,
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(overall, 0); return b; })(),
    Buffer.from([1]),
    ...descriptors,
    body,
    sentinel,
  ]);
  const file = Buffer.concat([head, container]);
  // preview seeker at 0x0D → container base (0x20)
  file.writeInt32LE(0x20, 0x0d);
  return file;
}

function makeDib(w, h) {
  // 24bpp BITMAPINFOHEADER DIB, bottom-up rows padded to 4 bytes
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const px = rowSize * h;
  const dib = Buffer.alloc(40 + px);
  dib.writeUInt32LE(40, 0);          // biSize
  dib.writeInt32LE(w, 4);            // biWidth
  dib.writeInt32LE(h, 8);            // biHeight
  dib.writeUInt16LE(1, 12);          // biPlanes
  dib.writeUInt16LE(24, 14);         // biBitCount
  dib.writeUInt32LE(px, 20);         // biSizeImage
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const at = 40 + y * rowSize + x * 3;
      dib[at] = 0xff; dib[at + 1] = 0x00; dib[at + 2] = 0x00; // red
    }
  return dib;
}

t("extracts a BMP preview from a synthetic DWG (seeker 0x0D → container)", () => {
  const dib = makeDib(4, 3);
  const dwg = synthDwgWithPreview(dib);
  const hit = previewMod.extractDwgPreview(new Uint8Array(dwg));
  assert.ok(hit, "preview must be found");
  assert.strictEqual(hit.format, "bmp");
  // DIB + 14-byte BITMAPFILEHEADER
  assert.strictEqual(hit.data.length, 14 + dib.length);
  assert.strictEqual(hit.data[0], 0x42); // "B"
  assert.strictEqual(hit.data[1], 0x4d); // "M"
  const view = Buffer.from(hit.data.buffer, hit.data.byteOffset, hit.data.byteLength);
  assert.strictEqual(view.readUInt32LE(10), 14 + 40, "pixel data offset = header + BITMAPINFOHEADER");
});

t("extracts the embedded preview from the REAL fixture DWGs", () => {
  const bmp = previewMod.extractDwgPreview(new Uint8Array(fs.readFileSync(path.join(root, "tests", "fixtures", "sample_2000.dwg"))));
  assert.ok(bmp && bmp.format === "bmp", "AC1015 sample must carry a BMP DIB preview");
  const view = Buffer.from(bmp.data.buffer, bmp.data.byteOffset, bmp.data.byteLength);
  assert.strictEqual(view.readUInt32LE(14), 40, "DIB starts with BITMAPINFOHEADER");
  const png = previewMod.extractDwgPreview(new Uint8Array(fs.readFileSync(path.join(root, "tests", "fixtures", "sample_2018.dwg"))));
  assert.ok(png && png.format === "png", "AC1032 sample must carry a PNG preview");
  assert.strictEqual(png.data[0], 0x89);
  assert.strictEqual(Buffer.from(png.data.slice(1, 4)).toString("latin1"), "PNG");
});

t("returns null for non-DWG bytes, bad seeker or no container", () => {
  assert.strictEqual(previewMod.extractDwgPreview(new Uint8Array(Buffer.from("some dxf text"))), null);
  const noPreview = Buffer.alloc(0x20);
  noPreview.write("AC1015", 0, "latin1");
  noPreview.writeInt32LE(0, 0x0d); // seeker → 0 = no preview
  assert.strictEqual(previewMod.extractDwgPreview(new Uint8Array(noPreview)), null);
});

console.log("== CTB/STB plot style tables (real ezdxf-generated fixtures) ==");

const fixture = (...p) => new Uint8Array(fs.readFileSync(path.join(root, "tests", "fixtures", ...p)));

const loadTable = async (name) => plotMod.parsePlotStyleTable(fixture(name));

(async () => {
  let asyncFail = 0;
  const ta = async (n, f) => {
    try { await f(); pass++; console.log("  PASS " + n); }
    catch (e) { fail++; asyncFail++; console.log("  FAIL " + n + ": " + e.message); }
  };

  await ta("colors.ctb parses with the ACI↔style mapping (i ↔ aci i+1)", async () => {
    const tbl = await loadTable("colors.ctb");
    assert.ok(tbl, "must parse");
    assert.strictEqual(tbl.kind, "ctb");
    const red = tbl.styles.find((s) => s.index === 1);
    const yellow = tbl.styles.find((s) => s.index === 2);
    const blue = tbl.styles.find((s) => s.index === 5);
    assert.deepStrictEqual(red.color, [255, 0, 0]);
    assert.deepStrictEqual(yellow.color, [255, 255, 0]);
    assert.deepStrictEqual(blue.color, [0, 0, 255]);
    assert.strictEqual(yellow.screen, 60, "yellow screens at 60%");
    assert.strictEqual(blue.screen, 35, "blue screens at 35%");
    assert.strictEqual(red.name, "red");
  });

  await ta("mono.ctb forces every ACI to black at full screen", async () => {
    const tbl = await loadTable("mono.ctb");
    for (const aci of [1, 7, 9, 30, 255]) {
      const st = plotMod.plotStyleForAci(tbl, aci);
      assert.ok(st, `style for aci ${aci} missing`);
      assert.deepStrictEqual(st.color, [0, 0, 0]);
      assert.strictEqual(st.screen, 100);
    }
  });

  await ta("gray.ctb sets the grayscale color policy", async () => {
    const tbl = await loadTable("gray.ctb");
    const st = plotMod.plotStyleForAci(tbl, 1);
    assert.strictEqual(st.colorPolicy & plotMod.POLICY_GRAYSCALE, plotMod.POLICY_GRAYSCALE);
    const r = plotMod.resolvePlotStyle(tbl, st);
    assert.strictEqual(r.grayscale, true);
  });

  await ta("lineweight table applies pen assignments (index 4 ≈ 0.13mm)", async () => {
    const tbl = await loadTable("colors.ctb");
    const st = plotMod.plotStyleForAci(tbl, 1);
    const r = plotMod.resolvePlotStyle(tbl, st);
    assert.ok(Math.abs(r.lineweightMm - 0.13) < 0.01, `expected ~0.13mm, got ${r.lineweightMm}`);
    // index 0 = use object lineweight
    const mono = await loadTable("mono.ctb");
    const m0 = plotMod.resolvePlotStyle(mono, plotMod.plotStyleForAci(mono, 7));
    assert.strictEqual(m0.lineweightMm, null);
  });

  await ta("named.stb parses styles by name (Normal / Bold / Thin)", async () => {
    const tbl = await loadTable("named.stb");
    assert.strictEqual(tbl.kind, "stb");
    const bold = plotMod.plotStyleByName(tbl, "bold"); // case-insensitive
    const thin = plotMod.plotStyleByName(tbl, "Thin");
    assert.ok(bold && thin, "named styles must resolve");
    assert.deepStrictEqual(thin.color, [0, 0, 255]);
    assert.strictEqual(thin.screen, 40);
    const normal = plotMod.plotStyleByName(tbl, "Normal");
    const rn = plotMod.resolvePlotStyle(tbl, normal);
    assert.strictEqual(rn.color, null, "Normal leaves the object colour as drawn");
  });

  await ta("garbage bytes return null instead of throwing", async () => {
    assert.strictEqual(await plotMod.parsePlotStyleTable(new Uint8Array([1, 2, 3])), null);
    assert.strictEqual(await plotMod.parsePlotStyleTable(new TextEncoder().encode("hello world plotstyle")), null);
  });

  console.log("== LandXML CgPoints import ==");

  t("parses CgPoint elements with northing→Y, easting→X", () => {
    const xml = `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" units="metre">
  <Units><Metric areaUnit="squareMeter" linearUnit="meter"/></Units>
  <CgPoints>
    <CgPoint name="101" desc="CP 1">634398.190 163842.795 12.5</CgPoint>
    <CgPoint name="102">634,512.330 163,900.110</CgPoint>
    <CgPoint oID="x" desc="no name">100.0 200.0</CgPoint>
    <CgPoint name="bad">not numbers here</CgPoint>
  </CgPoints>
</LandXML>`;
    assert.strictEqual(landMod.isLandXml(xml), true);
    const pts = landMod.parseLandXmlPoints(xml);
    assert.strictEqual(pts.length, 3, "3 parseable points");
    assert.strictEqual(pts[0].x, 163842.795);
    assert.strictEqual(pts[0].y, 634398.19);
    assert.strictEqual(pts[0].z, 12.5);
    assert.strictEqual(pts[1].x, 163900.11, "thousands separators stripped");
    assert.strictEqual(pts[1].y, 634512.33);
    assert.strictEqual(pts[2].name, "", "no name attr → empty");
    assert.strictEqual(pts[2].desc, "no name");
  });

  t("non-LandXML text is rejected", () => {
    assert.strictEqual(landMod.isLandXml("<html><body>x</body></html>"), false);
    assert.strictEqual(landMod.parseLandXmlPoints("<html></html>").length, 0);
  });

  console.log("== curve-aware polyline offset (kernel-style) ==");

  const P = (x, y) => ({ x, y });
  const square = (at = 10) => ({
    type: "LWPOLYLINE", layer: "0",
    points: [P(-at, -at), P(at, -at), P(at, at), P(-at, at)],
    closed: true,
  });

  t("closed square grows by d outward on each side", () => {
    const out = X.offsetEnt(square(), 5, P(0, -20)); // side below → outward
    assert.ok(out, "outer offset must succeed");
    const xs = out.points.map((p) => p.x), ys = out.points.map((p) => p.y);
    assert.ok(Math.abs(Math.max(...xs) - 15) < 1e-9, `max x = 15, got ${Math.max(...xs)}`);
    assert.ok(Math.abs(Math.min(...ys) + 15) < 1e-9, `min y = -15, got ${Math.min(...ys)}`);
  });

  t("inner offset shrinks and refuses to collapse past the centroid", () => {
    const in5 = X.offsetEnt(square(), 5, P(0, 0)); // side inside → inward
    assert.ok(in5, "valid inner offset must succeed");
    const xs = in5.points.map((p) => p.x);
    assert.ok(Math.abs(Math.max(...xs) - 5) < 1e-9, `shrunk to 5, got ${Math.max(...xs)}`);
    const in25 = X.offsetEnt(square(), 25, P(0, 0)); // 20-wide square − 25 → collapse
    assert.strictEqual(in25, null, "collapse must be refused (DWG 'cannot offset')");
  });

  t("open chain keeps its free ends exactly d away", () => {
    const line = { type: "LWPOLYLINE", layer: "0", points: [P(0, 0), P(100, 0)], closed: false };
    const off = X.offsetEnt(line, 7, P(50, -5)); // side below the chain
    assert.ok(off);
    assert.ok(Math.abs(off.points[0].y + 7) < 1e-9, `first vertex y = -7, got ${off.points[0].y}`);
    assert.ok(Math.abs(off.points[1].y + 7) < 1e-9);
  });

  t("corner join is the exact intersection (extended/trimmed like DWG)", () => {
    // L-shape: offset outward must extend both legs to a sharp corner at 15,15
    const l = {
      type: "LWPOLYLINE", layer: "0",
      points: [P(0, 0), P(10, 0), P(10, 10)],
      closed: false,
    };
    const out = X.offsetEnt(l, 5, P(15, -5)); // outside the corner
    assert.ok(out, "L offset must succeed");
    // The middle vertex (10,0) joins to the intersection of both offset legs → (15,-5)
    const mid = out.points[1];
    assert.ok(Math.abs(mid.x - 15) < 1e-9 && Math.abs(mid.y + 5) < 1e-9,
      `corner join at (15,-5), got (${mid.x},${mid.y})`);
  });

  t("line/circle/arc offsets still behave (no regression)", () => {
    const line = { type: "LINE", layer: "0", start: P(0, 0), end: P(10, 0) };
    const l = X.offsetEnt(line, 3, P(5, -1));
    assert.ok(Math.abs(l.start.y + 3) < 1e-9);
    const circ = { type: "CIRCLE", layer: "0", center: P(0, 0), radius: 10 };
    assert.strictEqual(X.offsetEnt(circ, 12, P(0, 0)), null, "inner offset past r=0 refused");
    const grow = X.offsetEnt(circ, 2, P(0, 15));
    assert.strictEqual(grow.radius, 12);
  });

  console.log("== UI/UX wiring: every absorbed function is reachable ==");

  const viewer = read("src", "features", "cad-viewer.ts");

  t("PLOT dialog carries a Load CTB/STB pen table control", () => {
    for (const m of [
      'data-p="ctbload"', "Load CTB / STB…", "loadPlotStyleFile",
      "Pen table loaded:", 'cmode = o.mono ? "bw" : plotStyle ? "style" : "layer"',
    ]) assert.ok(viewer.includes(m), `missing: ${m}`);
  });

  t("plot styles drive colour, screening and lineweight while plotting", () => {
    for (const m of [
      "resolvePlotStyle(plotStyle.table, plotEntryOf(e))",
      "grayscaleChannel",
      "r.lineweightMm != null) mm = r.lineweightMm",
      "a = Math.min(a, r.alpha)",
    ]) assert.ok(viewer.includes(m), `missing: ${m}`);
  });

  t("embedded preview shows while reading and is listed in Info", () => {
    for (const m of [
      "readDwgPreview(file)", "showPreviewPlaceholder(previewInfo)", "hidePreviewPlaceholder()",
      "Embedded Preview:", "native DWG thumbnail shown while reading",
    ]) assert.ok(viewer.includes(m), `missing: ${m}`);
  });

  t("BAK / SV$ backups and LandXML .xml are accepted on open and drop", () => {
    for (const m of [
      '".dxf,.dwg,.bak,.sv$,.xml"',
      "/\\.(dwg|dxf|bak|sv\\$|xml)$/i.test(f.name)",
      "host.importLandXml(file)",
    ]) assert.ok(new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(viewer) || viewer.includes(m), `missing: ${m}`);
  });

  t("readCadFile opens .bak/.sv$ as DWG with a recovery note", () => {
    const core = read("src", "modules", "cad-link", "index.ts");
    for (const m of [
      'e === "dwg" || e === "bak" || e === "sv$"',
      "recovered from DWG",
    ]) assert.ok(core.includes(m), `missing: ${m}`);
  });

  t("DATAEXTRACT + LANDXMLIN commands, app menu entries and exec actions", () => {
    for (const m of [
      '{ name: "DATAEXTRACT", aliases: ["EATTEXT", "DX"]',
      '{ name: "LANDXMLIN", aliases: ["XMLIN"]',
      'cmd === "DATAEXTRACT" || cmd === "EATTEXT" || cmd === "DX"',
      'cmd === "LANDXMLIN" || cmd === "XMLIN"',
      'dataextract: () => extractEntityCsv()',
      'landxmlin: () => xmlPicker?.click()',
      'item("Export Entity Data (CSV)"',
      'item("Import LandXML CgPoints…"',
      "importLandXml: (f: File) => importLandXml(f)",
      `${"${base()}-entities.csv"}`,
    ]) assert.ok(viewer.includes(m), `missing: ${m}`);
  });

  t("LandXML import creates the LandXML Points layer with labels", () => {
    for (const m of [
      '"LandXML Points"',
      "north → CAD Y, east → CAD X",
      "parseLandXmlPoints(text)",
    ]) assert.ok(viewer.includes(m), `missing: ${m}`);
  });

  console.log("== compile-clean absorb surface (drift guard) ==");

  t("dwg-preview keeps the faithful container constants", () => {
    const src = read("src", "modules", "drawings", "dwg-preview.ts");
    for (const m of [
      "0x1f, 0x25, 0x6d, 0x07, 0xd4, 0x36, 0x28, 0x28",
      "64 * 1024 * 1024",
      "dibToBmp",
      "createImageBitmap",
    ]) assert.ok(src.includes(m), `missing: ${m}`);
  });

  fs.rmSync(outDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
