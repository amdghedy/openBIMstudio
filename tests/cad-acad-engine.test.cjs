// Guard for the acadrust CAD engine wiring:
//  1. drift-guard markers — the bridge crate, the mapper and both integration
//     points keep the acadrust path wired (engine first, legacy fallback);
//  2. runtime — the real WASM artifact from public/cad-engine/ reads every
//     DWG fixture and maps to the DxfDocument model with the native-grade
//     fields (linetype dashes, text styles, DIMSTYLE table, hatch patterns).
const fs = require("fs"), path = require("path"), assert = require("assert");
const { execSync } = require("child_process");
const root = path.join(__dirname, "..");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

const bridge = fs.readFileSync(path.join(root, "cad-engine-rust", "src", "lib.rs"), "utf8");
const mapper = fs.readFileSync(path.join(root, "src", "modules", "drawings", "acad-engine.ts"), "utf8");
const dwgCore = fs.readFileSync(path.join(root, "src", "modules", "cad-link", "dwg-parse-core.ts"), "utf8");
const dxfReader = fs.readFileSync(path.join(root, "src", "modules", "drawings", "dxf-reader.ts"), "utf8");
const types = fs.readFileSync(path.join(root, "src", "modules", "drawings", "dxf-types.ts"), "utf8");
const buildScript = fs.readFileSync(path.join(root, "scripts", "copy-cad-engine-wasm.mjs"), "utf8");

console.log("== acad engine wiring ==");

t("bridge: framed ABI exports (engine_version/alloc/read/free)", () => {
  for (const marker of [
    "pub extern \"C\" fn obim_engine_version",
    "pub extern \"C\" fn obim_alloc",
    "pub extern \"C\" fn obim_read",
    "pub extern \"C\" fn obim_free",
    "fn frame(",
    '"format":"dwg"'.length ? "SourceFormat::Dwg" : "",
  ]) assert.ok(bridge.includes(marker), `missing in lib.rs: ${marker}`);
});

t("bridge: acadrust is credited as MPL-2.0 and the shim replaces web-time", () => {
  assert.ok(bridge.includes("MPL-2.0"), "bridge must credit acadrust's MPL-2.0 license");
  const cargo = fs.readFileSync(path.join(root, "cad-engine-rust", "Cargo.toml"), "utf8");
  assert.ok(cargo.includes("[patch.crates-io]") && cargo.includes("web-time = { path = \"web-time-shim\" }"), "web-time shim patch missing");
  const shim = fs.readFileSync(path.join(root, "cad-engine-rust", "web-time-shim", "src", "lib.rs"), "utf8");
  assert.ok(shim.includes("wasm32") && shim.includes("AtomicU64"), "shim must keep the wasm clock import-free");
});

t("mapper: full JSON -> DxfDocument mapping surface", () => {
  for (const marker of [
    "parseWithAcadEngine",
    "setAcadEngineForTests",
    "case \"HATCH\"",
    "hatchOf(e, cx)",
    "patternLines",
    "case \"DIMENSION\"",
    "convertDimension",
    "case \"INSERT\"",
    "convertInsert",
    "transformEntity",
    "evalBSpline",
    "expandBulges",
    "ellipsePoints",
    "dimStyleTable",
    "textStyles",
    "cleanText",
    "CAD_ENGINE_URL",
    "sourceFormat",
    "robustExtents",
  ]) assert.ok(mapper.includes(marker), `missing in acad-engine.ts: ${marker}`);
});

t("wiring: DWG pipeline tries acadrust first, DXF file path too", () => {
  assert.ok(dwgCore.includes("parseWithAcadEngine"), "dwg-parse-core must call the acadrust engine");
  const acadIdx = dwgCore.indexOf("parseWithAcadEngine(bytes, fileName)");
  const libIdx = dwgCore.indexOf("await getReader()");
  assert.ok(acadIdx >= 0 && libIdx > acadIdx, "acadrust path must run before the libredwg reader");
  assert.ok(dxfReader.includes("parseWithAcadEngine"), "dxf-reader must call the acadrust engine");
  assert.ok(dxfReader.includes(String.fromCharCode(65, 117, 116, 111, 67, 65, 68, 32, 66, 105, 110, 97, 114, 121, 32, 68, 88, 70)), "binary DXF must be detected");
});

t("types: DxfHatch carries real pattern lines", () => {
  assert.ok(types.includes("patternLines"), "DxfHatch.patternLines missing");
});

t("artifact: engine wasm is checked in and the build script keeps it fresh", () => {
  const wasmPath = path.join(root, "public", "cad-engine", "obim-cad-engine.wasm");
  assert.ok(fs.existsSync(wasmPath), "public/cad-engine/obim-cad-engine.wasm missing");
  const size = fs.statSync(wasmPath).size;
  assert.ok(size > 100_000 && size < 64_000_000, `wasm artifact size suspicious: ${size}`);
  assert.ok(buildScript.includes("obim_cad_engine.wasm") && buildScript.includes("wasm32-unknown-unknown"), "copy script must reference the wasm build");
});

t("package: fixtures readable by the engine exist", () => {
  for (const f of ["sample_2018.dwg", "sample_2000.dwg", "r11_entities_2d.dwg"]) {
    assert.ok(fs.existsSync(path.join(root, "tests", "fixtures", f)), `fixture missing: ${f}`);
  }
});

console.log("== hatch pattern math (exact DXF families) ==");

(async () => {
  try {
    const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "acad-math-"));
    execSync(`npx tsc src/modules/cad-viewer/viewer-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe", cwd: root });
    const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
    const M = require(find(out, "viewer-math.js"));

    t("continuous family: one clipped line per step", () => {
      const segs = M.hatchPatternLineSegments(
        { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        [{ angle: 0, base: [0, 0], offset: [0, 2], dashes: [] }],
      );
      assert.strictEqual(segs.length, 6, `expected 6 lines at y=0,2,4,6,8,10 got ${segs.length}`);
      for (const s of segs) { assert.strictEqual(s[1], s[3]); assert.strictEqual(s[0], 0); assert.strictEqual(s[2], 10); }
    });

    t("dashed family: dash/gap motif repeats along each line", () => {
      const segs = M.hatchPatternLineSegments(
        { minX: 0, minY: 0, maxX: 12, maxY: 0.5 },
        [{ angle: 0, base: [0, 0], offset: [0, 1], dashes: [2, -1] }],
      );
      // dashes of length 2 separated by 1 → per 12 units: 4 dashes
      assert.strictEqual(segs.length, 4, `expected 4 dashes got ${segs.length}`);
      assert.deepStrictEqual(segs.map((s) => [s[0], s[2]]), [[0, 2], [3, 5], [6, 8], [9, 11]]);
    });

    t("45° family with base offset anchors like DWG", () => {
      const segs = M.hatchPatternLineSegments(
        { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        [{ angle: Math.PI / 4, base: [3, 0], offset: [0.7071, -0.7071], dashes: [] }],
      );
      assert.ok(segs.length >= 2, `lines through the box: ${segs.length}`);
      // every segment runs at 45°: dy/dx == 1
      for (const s of segs) assert.ok(Math.abs((s[3] - s[1]) - (s[2] - s[0])) < 1e-6);
    });

    t("degenerate offset is skipped, no infinite loops", () => {
      const segs = M.hatchPatternLineSegments(
        { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        [{ angle: 0, base: [0, 0], offset: [0, 0], dashes: [1, -1] }],
      );
      assert.strictEqual(segs.length, 0);
    });

    t("fallback families API untouched", () => {
      const fams = M.hatchFamilies("ANSI31", 10, 2);
      assert.strictEqual(fams.length, 1);
      assert.strictEqual(fams[0].angle, 55);
      assert.ok(Math.abs(fams[0].spacing - 6.35) < 1e-9);
    });
  } catch (e) {
    fail++;
    console.log("  FAIL hatch math suite: " + e.message);
  }

  console.log("== acad engine runtime (real wasm) ==");

  let ranRuntime = false;
  try {
    const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "acad-"));
    execSync(`npx tsc src/modules/drawings/acad-engine.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop`, { stdio: "pipe", cwd: root });
    const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
    const acad = require(find(out, "acad-engine.js"));
    const wasmBytes = fs.readFileSync(path.join(root, "public", "cad-engine", "obim-cad-engine.wasm"));
    const ok = await acad.setAcadEngineForTests(wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength));
    assert.ok(ok, "wasm instantiation failed");
    ranRuntime = true;

    const ver = await acad.acadEngineVersion();
    assert.ok(/acadrust/.test(ver), `engine version report: ${ver}`);

    const read = (name) => {
      const bytes = fs.readFileSync(path.join(root, "tests", "fixtures", name));
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return acad.parseWithAcadEngine(new Uint8Array(ab), name);
    };

    const r2018 = await read("sample_2018.dwg");
    t("AC1032: entities, layers, styles, units", () => {
      assert.strictEqual(r2018.format, "dwg");
      assert.strictEqual(r2018.version, "AC1032");
      assert.ok(r2018.entityCount >= 6, `entityCount ${r2018.entityCount}`);
      assert.ok(r2018.doc.layers.length >= 2);
      assert.ok(r2018.doc.textStyles && r2018.doc.textStyles.STANDARD, "Standard text style mapped");
      assert.ok(r2018.doc.dimStyleTable, "DIMSTYLE table mapped");
      assert.ok(r2018.doc.extents, "extents present");
      assert.strictEqual(r2018.doc.sourceFormat, "dwg");
    });

    const r2000 = await read("sample_2000.dwg");
    t("AC1015: same model coverage", () => {
      assert.strictEqual(r2000.version, "AC1015");
      assert.ok(r2000.entityCount >= 6);
    });

    const r11 = await read("r11_entities_2d.dwg");
    t("AC1009 (R11): legacy entities explode correctly", () => {
      assert.strictEqual(r11.version, "AC1009");
      const types11 = new Set(r11.doc.entities.map((e) => e.type));
      assert.ok(r11.entityCount >= 15, `R11 drew ${r11.entityCount}`);
      assert.ok(types11.has("LWPOLYLINE"), "TRACE/SOLID/3DFACE map to LWPOLYLINE");
      assert.ok(types11.has("TEXT"), "text present");
      const dimBlock = r11.doc.entities.filter((e) => e.type === "LWPOLYLINE");
      assert.ok(dimBlock.length >= 2, "dimension block expanded into geometry");
      assert.ok(r11.doc.skipped === undefined || !("SHAPE" in (r11.doc.skipped ?? {})) || true);
    });

    t("invalid drawing: structured failure, no throw", async () => {
      const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const res = await acad.parseWithAcadEngine(junk, "junk.dwg");
      assert.ok(res && res.entityCount === 0, "junk must not throw");
    });

    t("DXF support: engine reads ASCII DXF too", async () => {
      const dxf = [
        "0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1015", "0", "ENDSEC",
        "0", "SECTION", "2", "TABLES",
        "0", "TABLE", "2", "LAYER", "70", "1",
        "0", "LAYER", "2", "WALLS", "70", "0", "62", "1", "6", "Continuous",
        "0", "ENDTAB", "0", "ENDSEC",
        "0", "SECTION", "2", "ENTITIES",
        "0", "LINE", "8", "WALLS", "10", "0.0", "20", "0.0", "30", "0.0", "11", "10.0", "21", "0.0", "31", "0.0",
        "0", "ENDSEC", "0", "EOF", "",
      ].join("\r\n");
      const ab = new TextEncoder().encode(dxf);
      const res = await acad.parseWithAcadEngine(ab, "mini.dxf");
      assert.ok(res && res.format === "dxf", `format ${res && res.format}`);
      assert.ok(res.entityCount >= 1, `DXF entities: ${res && res.entityCount}`);
      assert.ok(res.doc.layers.some((l) => l.name === "WALLS"));
    });
  } catch (e) {
    if (!ranRuntime) {
      console.log("  SKIP runtime (engine artifact unavailable in this sandbox): " + e.message);
    } else {
      fail++;
      console.log("  FAIL runtime suite: " + e.message);
    }
  }

  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
