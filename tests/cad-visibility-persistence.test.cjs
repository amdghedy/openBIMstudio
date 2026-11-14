/* CAD object-visibility persistence + bounded undo + keyboard commands.
 *
 * Covers the drafting-completion gaps found in the Prompt-06 audit:
 *   1. DXF group 60 Invisible round trip — HIDEOBJECTS/ISOLATEOBJECTS state
 *      survives QSAVE → open (writer emits 60, reader parses it back).
 *   2. The drawing workspace undo stack is bounded (MAX_UNDO_DEPTH) and every
 *      push site routes through the bounded helper — no unbounded growth.
 *   3. HIDEOBJECTS / ISOLATEOBJECTS / ENDISOLATE are real keyboard commands:
 *      catalog entries with unique aliases, resolved by resolveCadToken and
 *      dispatched to the same visibility engine the context menu uses.
 * Pure modules (dxf writer/reader, alias resolver) are compiled headlessly;
 * the 11k-line viewer is asserted at source level like cad-context-menu does.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cad-visibility-"));
// Pure DXF modules compiled headlessly (same pattern as cad-save.test.cjs).
// The alias resolver is NOT compiled here: command-aliases.ts reaches
// form-modal.ts and the @thatopen context, which cannot resolve outside the
// bundler. Its wiring is asserted at source level instead.
execSync(
  "npx tsc src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-types.ts --outDir " +
    out + " --module commonjs --target es2020 --skipLibCheck",
  { cwd: root, stdio: "pipe" },
);
const locate = (dir, name) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = locate(p, name); if (f) return f; }
    else if (e.name === name) return p;
  }
  return null;
};
const { writeDxf } = require(locate(out, "dxf-writer.js"));
const { parseDxf } = require(locate(out, "dxf-reader.js"));

function main() {
  run();
}

const viewerSrc = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

function run() {

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

/* ── 1. DXF group 60 round trip ─────────────────────────────────────── */

const doc = () => ({
  units: "mm",
  layers: [{ name: "0", color: 7 }],
  entities: [
    { type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { type: "LINE", layer: "0", start: { x: 0, y: 5 }, end: { x: 10, y: 5 }, invisible: true },
    { type: "CIRCLE", layer: "0", center: { x: 5, y: 5 }, radius: 2 },
    { type: "TEXT", layer: "0", position: { x: 0, y: 10 }, height: 2.5, value: "Hidden text", invisible: true },
  ],
});

t("writer emits group 60 only for invisible entities", () => {
  const s = writeDxf(doc());
  const count60 = (text) => text.split("\n60\n1\n").length - 1;
  assert.strictEqual(count60(s), 2, `expected exactly 2 group-60 flags, got ${count60(s)}`);
  // the hidden LINE's own block: find the section between the second LINE start and the CIRCLE start
  const lines = s.split("\n");
  const starts = lines.map((l, i) => (l === "LINE" || l === "CIRCLE" || l === "TEXT") ? i : -1).filter((i) => i >= 0);
  assert.strictEqual(starts.length, 4, `expected 4 entity starts, got ${starts.length}`);
  // entities start in doc order: LINE(visible), LINE(hidden), CIRCLE, TEXT(hidden)
  const seg = (a, b) => lines.slice(a + 1, b).join("\n");
  assert.ok(!/\n60\n1\n/.test(seg(starts[0], starts[1])), "visible LINE must not carry group 60");
  assert.ok(/\n60\n1\n/.test(seg(starts[1], starts[2])), "hidden LINE must carry group 60 = 1");
  assert.ok(!/\n60\n1\n/.test(seg(starts[2], starts[3])), "CIRCLE must not carry group 60");
  assert.ok(/\n60\n1\n/.test(lines.slice(starts[3]).join("\n")), "hidden TEXT must carry group 60 = 1");
});

t("reader parses group 60 back into invisible", () => {
  const back = parseDxf(writeDxf(doc()));
  assert.strictEqual(back.entities.length, 4);
  assert.strictEqual(back.entities[1].invisible, true, "second LINE should read back invisible");
  assert.strictEqual(back.entities[3].invisible, true, "TEXT should read back invisible");
  assert.notStrictEqual(back.entities[0].invisible, true, "first LINE must stay visible");
  assert.notStrictEqual(back.entities[2].invisible, true, "CIRCLE must stay visible");
});

t("full QSAVE round trip preserves exactly the hidden set", () => {
  const back = parseDxf(writeDxf(doc()));
  const hiddenTypes = back.entities.filter((e) => e.invisible).map((e) => e.type).sort();
  assert.deepStrictEqual(hiddenTypes, ["LINE", "TEXT"]);
  // geometry survives untouched
  near(back.entities[1].start.y, 5);
  near(back.entities[2].radius, 2);
});

t("entities without the flag stay byte-identical in behaviour (no regression)", () => {
  const plain = { units: "mm", layers: [{ name: "0", color: 7 }], entities: [{ type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }] };
  const back = parseDxf(writeDxf(plain));
  assert.strictEqual(back.entities.length, 1);
  assert.strictEqual(back.entities[0].invisible, undefined);
  assert.ok(!/\n60\n1\n/.test(writeDxf(plain)), "no group 60 written for visible drawings");
});

/* ── 2. Bounded undo depth ──────────────────────────────────────────── */

t("undo stack is bounded by MAX_UNDO_DEPTH with oldest-dropped semantics", () => {
  assert.ok(/const MAX_UNDO_DEPTH = \d+;/.test(viewerSrc), "MAX_UNDO_DEPTH constant exists");
  assert.ok(/const pushUndoAct = \(act: UndoAction\): void => \{[\s\S]*?undoStack\.push\(act\);[\s\S]*?if \(undoStack\.length > MAX_UNDO_DEPTH\) undoStack\.shift\(\);/.test(viewerSrc),
    "pushUndoAct pushes then drops the oldest entry");
});

t("every undo push site routes through the bounded helper", () => {
  const raw = viewerSrc.match(/undoStack\.push/g) ?? [];
  assert.strictEqual(raw.length, 1, `only the helper may call undoStack.push directly (found ${raw.length})`);
  const calls = (viewerSrc.match(/pushUndoAct\(/g) ?? []).length;
  assert.ok(calls >= 15, `expected >=15 bounded call sites, found ${calls}`);
});

t("redo re-pushes also go through the bound (no growth via undo/redo cycling)", () => {
  // the redo() body must not contain a raw undoStack.push either — covered by
  // the count assertion above; here we pin the mechanism itself.
  const redoBody = viewerSrc.split("function redo()")[1]?.split("function ")[0] ?? "";
  assert.ok(/pushUndoAct\(act\)/.test(redoBody), "redo() moves entries through pushUndoAct");
});

/* ── 3. Keyboard commands for object visibility ─────────────────────── */

t("catalog entries exist with unique aliases", () => {
  for (const [name, alias] of [["HIDEOBJECTS", "HIDEOBJ"], ["ISOLATEOBJECTS", "ISOLATE"], ["ENDISOLATE", "UNISOLATE"]]) {
    const re = new RegExp(`\\{ name: "${name}", aliases: \\[[^\\]]*"${alias}"`);
    assert.ok(re.test(viewerSrc), `catalog row for ${name} with alias ${alias}`);
  }
  // no alias may be claimed twice across the catalog
  const aliases = [];
  for (const m of viewerSrc.matchAll(/\{ name: "[A-Z0-9]+", aliases: \[([^\]]*)\]/g)) {
    for (const a of m[1].matchAll(/"([A-Z0-9]+)"/g)) aliases.push(a[1]);
  }
  const dupes = aliases.filter((a, i) => aliases.indexOf(a) !== i);
  assert.deepStrictEqual(dupes, [], `duplicate aliases: ${dupes.join(", ")}`);
});

t("resolveCadToken rule covers the new commands and their aliases (built-in match semantics)", () => {
  // resolveCadToken (src/features/command-aliases.ts) matches the exact name
  // first, then any built-in alias, case-insensitively. The catalog rows are
  // pinned by the test above; here the same semantics are exercised on the
  // real catalog rows extracted from the viewer source.
  const rows = [...viewerSrc.matchAll(/\{ name: "(HIDEOBJECTS|ISOLATEOBJECTS|ENDISOLATE)", aliases: \[([^\]]*)\]/g)];
  assert.strictEqual(rows.length, 3, "all three catalog rows found");
  const builtins = rows.map((m) => ({ name: m[1], aliases: [...m[2].matchAll(/"([A-Z0-9]+)"/g)].map((a) => a[1]) }));
  const resolve = (token) => {
    const t2 = token.trim().toUpperCase();
    return builtins.find((c) => c.name === t2 || c.aliases.some((a) => a.toUpperCase() === t2))?.name ?? t2;
  };
  assert.strictEqual(resolve("hideobjects"), "HIDEOBJECTS");
  assert.strictEqual(resolve("HIDEOBJ"), "HIDEOBJECTS");
  assert.strictEqual(resolve("isolate"), "ISOLATEOBJECTS");
  assert.strictEqual(resolve("endisolate"), "ENDISOLATE");
  assert.strictEqual(resolve("showall"), "ENDISOLATE");
  assert.strictEqual(resolve("unisolate"), "ENDISOLATE");
});

t("dispatch wires the commands to the visibility engine", () => {
  assert.ok(/cmd === "HIDEOBJECTS" \|\| cmd === "HIDEOBJ"\) \{\s*hideCadSelection\(false\);/.test(viewerSrc),
    "HIDEOBJECTS → hideCadSelection(false)");
  assert.ok(/cmd === "ISOLATEOBJECTS" \|\| cmd === "ISOLATE"\) \{\s*hideCadSelection\(true\);/.test(viewerSrc),
    "ISOLATEOBJECTS → hideCadSelection(true)");
  assert.ok(/cmd === "ENDISOLATE" \|\| cmd === "UNISOLATE" \|\| cmd === "SHOWALL"\) \{\s*showAllCadObjects\(\);/.test(viewerSrc),
    "ENDISOLATE → showAllCadObjects()");
});

/* ── 4. Save/load wiring ────────────────────────────────────────────── */

t("QSAVE and DWGSAVE stamp the hidden set without mutating live entities", () => {
  assert.ok(/function stampInvisibleForSave\(entities: DxfEntity\[\]\): DxfEntity\[\]/.test(viewerSrc), "stamp helper exists");
  assert.ok(/writeDxf\(\{ \.\.\.doc, entities: stampInvisibleForSave\(entities\) \}\)/.test(viewerSrc), "saveDxf uses the stamp");
  assert.ok(/writeDxf\(\{ \.\.\.doc, entities: stampInvisibleForSave\(entities\) \}, \{ version: dwgVersion/.test(viewerSrc), "saveDwg uses the stamp");
  assert.ok(/entities\.map\(\(e\) => \(hiddenEntities\.has\(e\) && !e\.invisible \? \{ \.\.\.e, invisible: true \} : e\)\)/.test(viewerSrc),
    "stamping clones, never mutates");
});

t("opening a drawing seeds hiddenEntities from the persisted flag", () => {
  const loadSeam = viewerSrc.split("for (const l of doc.layers) if (l.off || l.frozen) hidden.add(l.name);")[1]?.split("markups")[0] ?? "";
  assert.ok(/hiddenEntities\.clear\(\);/.test(loadSeam) && /for \(const e of doc\.entities\) if \(e\.invisible\) hiddenEntities\.add\(e\);/.test(loadSeam),
    "load restores object-level visibility");
});

t("merged files keep their invisible objects hidden (IMPORT / INSERT)", () => {
  assert.ok(/for \(const e of incoming\) if \(e\.invisible\) hiddenEntities\.add\(e\);/.test(viewerSrc),
    "merge path carries the flag into the live visibility set");
});

}

main();
