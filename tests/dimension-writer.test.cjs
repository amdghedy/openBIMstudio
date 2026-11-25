// DIMENSION writer (AutoCAD parity A5) — node test.
//
// The DXF writer had no DIMENSION branch: dimensions survived a save only as
// LINE/TEXT/LWPOLYLINE geometry, so associativity, dimension style and the
// DIMENSION entity itself were lost. The fix writes a real DIMENSION entity
// per dimension (definition points, style reference, measurement text) plus
// its drawn geometry in an anonymous *D<n> block, and a DIMSTYLE table for
// the referenced styles. The tagged geometry must then NOT also appear as
// plain entities, or the dimension would draw twice on re-import.
//
// Strategy (repo precedent: cad-dimension-system.test.cjs for the builders,
// cad-save.test.cjs for the writer/reader round trip):
//   1. Build a dimensioned drawing in memory with the real dimension
//      builders (linear horizontal + vertical, aligned, diameter, radius)
//      plus plain control entities and one angular dimension (out of scope:
//      it must stay plain geometry).
//   2. Write it with the real writer and parse the DXF text: the DIMENSION
//      records, their groups, the *D blocks and the DIMSTYLE table are all
//      asserted structurally.
//   3. Read it back with the real reader: every measurement text appears
//      exactly once (no duplication), the block geometry — not the native
//      fallback — is what comes back, and nothing is skipped.
//   4. Strip the *D blocks from the written text and read again: the native
//      fallback (reader nativeDimension) must regenerate the same
//      measurements from the definition points alone — that proves the
//      writer/reader defpoint contract, not just the block.
//   5. Guard the old behaviour: without DIMENSION entities the output has
//      no DIMENSION / *D / DIMSTYLE records and the tagged geometry stays
//      plain; invalid or duplicate DIMENSION entities degrade gracefully.
//   6. Source markers prove the CAD viewer wires the records into both
//      save paths (saveDxf + saveDwg) — the viewer itself is DOM-heavy and
//      cannot be compiled headlessly.
//
// No mocks: the builders, writer and reader under test are the shipped ones.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-dim-writer-"));
fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, a + "!=" + b);
try {
  execSync(
    "npx tsc src/modules/cad-viewer/dimension-system.ts src/modules/cad-viewer/dimension-tools.ts " +
      "src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts --outDir " + out +
      " --module commonjs --target es2020 --skipLibCheck --esModuleInterop",
    { cwd: root, stdio: "pipe" },
  );
  const locate = (dir, name) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = locate(p, name); if (found) return found; }
      else if (entry.name === name) return p;
    }
    return null;
  };
  const sys = require(locate(out, "dimension-system.js"));
  const { writeDxf } = require(locate(out, "dxf-writer.js"));
  const { parseDxf } = require(locate(out, "dxf-reader.js"));

  // ── DXF text helpers: split into code/value pairs, then records.
  // DXF values may be empty (BLOCK group 1, STYLE group 4), so lines are
  // paired strictly by position — filtering empty lines would shift every
  // pair after the first empty value.
  const pairsOf = (text) => {
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline
    assert.strictEqual(lines.length % 2, 0, "odd line count in DXF text");
    const pairs = [];
    for (let i = 0; i < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);
    return pairs;
  };
  const recordsOf = (text) => {
    const recs = [];
    let cur = null;
    for (const [code, value] of pairsOf(text)) {
      if (code === "0") { cur = { type: value.trim(), pairs: [] }; recs.push(cur); }
      else if (cur) cur.pairs.push([code, value]);
    }
    return recs;
  };
  const recVal = (rec, code, n = 0) => {
    const hits = rec.pairs.filter(([c]) => c === String(code)).map(([, v]) => v);
    return hits[n];
  };
  const recNum = (rec, code, n = 0) => {
    const v = recVal(rec, code, n);
    return v === undefined ? undefined : parseFloat(v);
  };
  const pt = (rec, xCode) => {
    const yCode = String(Number(xCode) + 10), zCode = String(Number(xCode) + 20);
    return recVal(rec, xCode) === undefined ? undefined : { x: recNum(rec, xCode), y: recNum(rec, yCode), z: recNum(rec, zCode) };
  };
  const dimsOf = (text) => recordsOf(text).filter((r) => r.type === "DIMENSION");
  const textsOf = (doc) => doc.entities.filter((e) => e.type === "TEXT").map((e) => e.value);

  // ── Build a dimensioned drawing with the real builders ──
  const style = sys.defaultDimStyles()[0]; // ISO-25, text 2.5 / arrow 2.5 / 2 decimals
  const mkRec = (id, mode, p1, p2, placement) => ({ id, styleName: "ISO-25", mode, layer: "DIMS", p1, p2, placement });
  const recLinear = mkRec("dim-linear", "linear", { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 20 });
  const recVert = mkRec("dim-vert", "linear", { x: 200, y: 0 }, { x: 200, y: 80 }, { x: 220, y: 40 });
  const recAligned = mkRec("dim-aligned", "aligned", { x: 300, y: 0 }, { x: 330, y: 40 }, { x: 315, y: 40 });
  const recDia = mkRec("dim-dia", "diameter", { x: 500, y: 500 }, { x: 530, y: 500 }, { x: 530, y: 500 });
  const recRad = mkRec("dim-rad", "radial", { x: 600, y: 500 }, { x: 625, y: 500 }, { x: 625, y: 500 });
  const recAng = mkRec("dim-ang", "angular", { x: 700, y: 100 }, { x: 750, y: 100 }, { x: 700, y: 150 });
  const geom = (rec, text) => sys.buildDimEntities(rec, style, text);
  const gLinear = geom(recLinear, "100.00"), gVert = geom(recVert, "80.00"), gAligned = geom(recAligned, "50.00");
  const gDia = geom(recDia, "⌀60.00"), gRad = geom(recRad, "R25.00"), gAng = geom(recAng, "90.00°");
  // DIMENSION entities, exactly as the viewer's save path synthesises them
  // from DimRecords (see dimensionEntitiesForSave in cad-viewer.ts).
  const dimEnt = (rec, dimType, textEnt) => ({
    type: "DIMENSION", layer: rec.layer, dimId: rec.id, dimType, styleName: rec.styleName,
    defPoint: dimType === 3 || dimType === 4 ? { ...rec.p1 } : { ...rec.placement },
    ...(dimType === 3 || dimType === 4
      ? { curvePoint: { ...rec.p2 } }
      : { extOrigin1: { ...rec.p1 }, extOrigin2: { ...rec.p2 } }),
    ...(textEnt ? { text: textEnt.value, textPoint: { ...textEnt.position } } : {}),
  });
  const textOf = (g) => g.find((e) => e.type === "TEXT");
  const plainLine = { type: "LINE", layer: "0", start: { x: 0, y: -50 }, end: { x: 50, y: -50 } };
  const plainText = { type: "TEXT", layer: "0", position: { x: 0, y: -60 }, height: 2.5, value: "NOTE" };
  const doc = {
    units: "mm",
    layers: [{ name: "0", color: 7 }, { name: "DIMS", color: 3 }],
    entities: [
      plainLine, plainText,
      ...gLinear, ...gVert, ...gAligned, ...gDia, ...gRad, ...gAng,
      dimEnt(recLinear, 0, textOf(gLinear)),
      dimEnt(recVert, 0, textOf(gVert)),
      dimEnt(recAligned, 1, textOf(gAligned)),
      dimEnt(recDia, 3, textOf(gDia)),
      dimEnt(recRad, 4, textOf(gRad)),
    ],
    dimStyleTable: { "ISO-25": { textHeight: 2.5, arrowSize: 2.5, decimals: 2 } },
  };
  const dxf = writeDxf(doc);

  t("writer emits one DIMENSION per dimension (5, no more)", () => {
    assert.strictEqual(dimsOf(dxf).length, 5);
  });
  t("DIMENSION types are 0/0/1/3/4 with the exclusive-block bit", () => {
    const types = dimsOf(dxf).map((r) => recNum(r, 70));
    assert.deepStrictEqual(types, [32, 32, 33, 35, 36]);
    assert.deepStrictEqual(types.map((v) => v & 7), [0, 0, 1, 3, 4]);
  });
  t("DIMENSION style reference, block reference and measurement text", () => {
    for (const r of dimsOf(dxf)) {
      assert.strictEqual(recVal(r, 3), "ISO-25");
      assert.ok(/^\*D\d+$/.test(recVal(r, 2)), "block " + recVal(r, 2));
    }
    assert.deepStrictEqual(
      dimsOf(dxf).map((r) => recVal(r, 1)),
      ["100.00", "80.00", "50.00", "⌀60.00", "R25.00"],
    );
  });
  t("DIMENSION definition points match the records", () => {
    const [lin, vert, al, dia, rad] = dimsOf(dxf);
    assert.deepStrictEqual(pt(lin, 10), { x: 50, y: 20, z: 0 });
    assert.deepStrictEqual(pt(lin, 13), { x: 0, y: 0, z: 0 });
    assert.deepStrictEqual(pt(lin, 14), { x: 100, y: 0, z: 0 });
    assert.deepStrictEqual(pt(vert, 10), { x: 220, y: 40, z: 0 });
    assert.deepStrictEqual(pt(al, 13), { x: 300, y: 0, z: 0 });
    assert.deepStrictEqual(pt(al, 14), { x: 330, y: 40, z: 0 });
    assert.deepStrictEqual(pt(dia, 10), { x: 500, y: 500, z: 0 });
    assert.deepStrictEqual(pt(dia, 15), { x: 530, y: 500, z: 0 });
    assert.deepStrictEqual(pt(rad, 10), { x: 600, y: 500, z: 0 });
    assert.deepStrictEqual(pt(rad, 15), { x: 625, y: 500, z: 0 });
  });
  t("DIMENSION rotation: 0 horizontal, 90 vertical, true angle aligned", () => {
    const [lin, vert, al] = dimsOf(dxf);
    assert.strictEqual(recNum(lin, 50), 0);
    assert.strictEqual(recNum(vert, 50), 90);
    near(recNum(al, 50), (Math.atan2(40, 30) * 180) / Math.PI);
    const [, , , dia, rad] = dimsOf(dxf);
    assert.strictEqual(recVal(dia, 50), undefined, "diameter carries no rotation");
    assert.strictEqual(recVal(rad, 50), undefined, "radius carries no rotation");
  });
  t("anonymous *D blocks hold the drawn geometry (+ BLOCK_RECORD entries)", () => {
    const blocks = recordsOf(dxf).filter((r) => r.type === "BLOCK");
    const names = blocks.map((r) => recVal(r, 2)).filter((n) => n && n.startsWith("*D")).sort();
    assert.deepStrictEqual(names, ["*D1", "*D2", "*D3", "*D4", "*D5"]);
    // Block contents are separate records between BLOCK and ENDBLK: walk the
    // record stream tracking the current block and collect its TEXT values.
    const recs = recordsOf(dxf);
    const blockTexts = [];
    let curBlock = null;
    for (const r of recs) {
      if (r.type === "BLOCK") curBlock = recVal(r, 2);
      else if (r.type === "ENDBLK") curBlock = null;
      else if (r.type === "TEXT" && curBlock && curBlock.startsWith("*D")) blockTexts.push(recVal(r, 1));
    }
    for (const v of ["100.00", "80.00", "50.00", "⌀60.00", "R25.00"]) assert.ok(blockTexts.includes(v), v + " in a *D block");
    const blockRecs = recordsOf(dxf).filter((r) => r.type === "BLOCK_RECORD").map((r) => recVal(r, 2));
    for (const n of names) assert.ok(blockRecs.includes(n), n + " in BLOCK_RECORD");
  });
  t("DIMSTYLE table is written for the referenced style", () => {
    const recs = recordsOf(dxf).filter((r) => r.type === "DIMSTYLE");
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recVal(recs[0], 2), "ISO-25");
    assert.strictEqual(recNum(recs[0], 140), 2.5);
    assert.strictEqual(recNum(recs[0], 41), 2.5);
    assert.strictEqual(recNum(recs[0], 271), 2);
  });

  // ── Round trip through the real reader ──
  const back = parseDxf(dxf);
  t("round trip: nothing skipped, no DIMENSION lost to the skip count", () => {
    assert.ok(!back.skipped?.DIMENSION, "DIMENSION skipped: " + JSON.stringify(back.skipped));
  });
  t("round trip: each measurement text appears exactly once (no double draw)", () => {
    const texts = textsOf(back);
    for (const v of ["100.00", "80.00", "50.00", "⌀60.00", "R25.00", "90.00°", "NOTE"]) {
      assert.strictEqual(texts.filter((x) => x === v).length, 1, v + " count " + texts.filter((x) => x === v).length);
    }
  });
  t("round trip: entity count is plain + dimension geometry, nothing duplicated", () => {
    const expected = 2 + gLinear.length + gVert.length + gAligned.length + gDia.length + gRad.length + gAng.length;
    assert.strictEqual(back.entities.length, expected, "got " + back.entities.length + ", want " + expected);
  });
  t("round trip: block geometry comes back verbatim (diameter line through centre)", () => {
    const diaLine = back.entities.find((e) => e.type === "LINE" && e.start.x === 530 && e.start.y === 500 && e.end.x === 470 && e.end.y === 500);
    assert.ok(diaLine, "diameter dim line edge->far edge present");
    const ext = back.entities.find((e) => e.type === "LINE" && e.start.x === 0 && e.start.y === 0);
    assert.ok(ext, "linear extension line from the measured origin present");
  });
  t("round trip: in-memory meta never leaks into the file", () => {
    assert.ok(!dxf.includes("dimId") && !dxf.includes("dim-linear") && !dxf.includes("dim-dia"), "meta leaked");
  });

  // ── Native fallback: strip the *D blocks; the definition points alone must re-measure ──
  // This doc has no user blocks: its whole BLOCKS section is the *D blocks.
  const stripBlocks = (text) => {
    const lines = text.split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);
    const keep = [];
    let inBlocks = false;
    for (let i = 0; i < pairs.length; i++) {
      const [c, v] = pairs[i];
      if (c === "0" && v === "SECTION") inBlocks = pairs[i + 1] && pairs[i + 1][1] === "BLOCKS";
      if (inBlocks) {
        if (c === "0" && v === "ENDSEC") inBlocks = false;
        continue; // drop the whole BLOCKS section, wrappers included
      }
      keep.push(pairs[i]);
    }
    return keep.map(([c, v]) => c + "\n" + v).join("\n") + "\n";
  };
  const stripped = stripBlocks(dxf);
  t("native fallback: stripped of blocks, defpoints still re-measure every dimension", () => {
    assert.strictEqual(dimsOf(stripped).length, 5, "DIMENSION records survive the strip");
    assert.ok(!recordsOf(stripped).some((r) => r.type === "BLOCK" && (recVal(r, 2) || "").startsWith("*D")), "no *D block left");
    const fb = parseDxf(stripped);
    assert.ok(!fb.skipped?.DIMENSION, "fallback skipped a DIMENSION: " + JSON.stringify(fb.skipped));
    const texts = textsOf(fb);
    for (const v of ["100.00", "80.00", "50.00", "⌀60.00", "R25.00"]) {
      assert.strictEqual(texts.filter((x) => x === v).length, 1, v + " missing/wrong in fallback");
    }
  });

  // ── Old behaviour guards ──
  t("no DIMENSION entities: output has no DIMENSION/*D/DIMSTYLE, geometry stays plain", () => {
    const plain = writeDxf({
      units: "mm",
      layers: doc.layers,
      entities: [plainLine, plainText, ...gLinear, ...gVert, ...gAligned, ...gDia, ...gRad, ...gAng],
      dimStyleTable: doc.dimStyleTable,
    });
    assert.strictEqual(dimsOf(plain).length, 0);
    assert.ok(!recordsOf(plain).some((r) => r.type === "BLOCK" && (recVal(r, 2) || "").startsWith("*D")), "*D block without a DIMENSION");
    assert.strictEqual(recordsOf(plain).filter((r) => r.type === "DIMSTYLE").length, 0, "DIMSTYLE without dimensions");
    const texts = textsOf(parseDxf(plain));
    for (const v of ["100.00", "80.00", "50.00", "⌀60.00", "R25.00", "90.00°", "NOTE"]) assert.ok(texts.includes(v), v + " lost");
    assert.ok(!plain.includes("dim-linear"), "meta leaked without DIMENSION entities");
  });
  t("dimensions but no dimStyleTable: DIMENSIONs written, no DIMSTYLE table", () => {
    const noStyles = writeDxf({ units: "mm", layers: doc.layers, entities: doc.entities });
    assert.strictEqual(dimsOf(noStyles).length, 5);
    assert.strictEqual(recordsOf(noStyles).filter((r) => r.type === "DIMSTYLE").length, 0);
  });
  t("invalid DIMENSION (linear without extension origins) is skipped, geometry stays plain", () => {
    const bad = writeDxf({
      units: "mm", layers: doc.layers,
      entities: [
        ...gLinear,
        { type: "DIMENSION", layer: "DIMS", dimId: "dim-linear", dimType: 0, defPoint: { x: 50, y: 20 }, extOrigin1: { x: 0, y: 0 } },
      ],
    });
    assert.strictEqual(dimsOf(bad).length, 0, "unmeasurable DIMENSION written");
    assert.ok(textsOf(parseDxf(bad)).includes("100.00"), "geometry lost with the invalid DIMENSION");
  });
  t("two DIMENSIONs sharing one dimId: one block, second keeps defpoints only", () => {
    const dup = writeDxf({
      units: "mm", layers: doc.layers,
      entities: [
        ...gLinear,
        { type: "DIMENSION", layer: "DIMS", dimId: "dim-linear", dimType: 0, defPoint: { x: 50, y: 20 }, extOrigin1: { x: 0, y: 0 }, extOrigin2: { x: 100, y: 0 } },
        { type: "DIMENSION", layer: "DIMS", dimId: "dim-linear", dimType: 0, defPoint: { x: 50, y: 30 }, extOrigin1: { x: 0, y: 0 }, extOrigin2: { x: 100, y: 0 } },
      ],
    });
    const ds = dimsOf(dup);
    assert.strictEqual(ds.length, 2);
    assert.strictEqual(ds.filter((r) => recVal(r, 2)).length, 1, "geometry written twice");
    assert.strictEqual(recordsOf(dup).filter((r) => r.type === "BLOCK" && (recVal(r, 2) || "").startsWith("*D")).length, 1);
    assert.strictEqual(textsOf(parseDxf(dup)).filter((v) => v === "100.00").length, 2, "second DIMENSION must still re-measure via fallback");
  });
  t("angular dimension stays plain geometry (out of scope, no DIMENSION written for it)", () => {
    assert.strictEqual(dimsOf(dxf).length, 5, "angular must not gain a DIMENSION record");
    assert.ok(textsOf(back).includes("90.00°"), "angular text lost");
  });
  t("viewer wires the records into both save paths (source markers)", () => {
    const viewer = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
    assert.ok(viewer.includes("function dimensionEntitiesForSave"), "dimensionEntitiesForSave missing");
    assert.ok(viewer.includes('rec.mode !== "linear" && rec.mode !== "aligned" && rec.mode !== "radial" && rec.mode !== "diameter"'), "mode filter missing");
    const saveDxf = viewer.indexOf("Save the edited drawing back to DXF");
    assert.ok(viewer.slice(saveDxf, saveDxf + 1500).includes("dimensionEntitiesForSave(stamped)"), "saveDxf does not pass dimensions");
    assert.ok(viewer.includes("dimensionEntitiesForSave(stamped)"), "saveDwg does not pass dimensions");
    assert.ok(viewer.includes("dimStyleTableForSave()"), "dim styles not passed to the writer");
  });

  console.log(`\ndimension-writer: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
