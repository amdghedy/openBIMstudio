#!/usr/bin/env node
/**
 * Ribbon draw-tool order — Revit 2D environment audit gap G6.
 *
 * Pins the Architecture Build group and the Structure Framing /
 * Foundations groups to Revit's order (audit §2 G6):
 *   Build:      Wall, Door, Window, Comp, Column, Roof, Ceiling, Floor,
 *               Curtain Wall, Railing, Ramp, Stair, Room, Model Line,
 *               Model Group
 *   Framing:    Beam, Brace, Column, Wall, Floor, Truss
 *   Foundations: Isolated, Wall, Slab, Pile
 *   Reinforcement group renamed from "Rebar".
 *
 * Two layers, same style as tests/ribbon-tab-order.test.cjs:
 *  1. The order model itself is EXECUTED: src/shell/ribbon-draw-order.ts
 *     is a pure, DOM-free module compiled with tsc and required here.
 *  2. Source pins prove src/shell/ribbon.ts matches that model group by
 *     group, that Beam left Architecture, that Door/Window moved (not
 *     copied), that Stair is a real placement tool, and that the tools
 *     the engine does not support (Beam System, Slab Edge, Area, Model
 *     Text, Area/Path/Fabric rebar) are absent rather than faked.
 *
 * Sensitivity: on the pre-G6 tree this fails — there is no
 * ribbon-draw-order.ts to compile, Build is Wall/Floor/Roof/Column/Beam/
 * Comp/Ceiling/Ramp, Door/Window sit in Openings, and Stairs/Winder/
 * Spiral call __obsStairs.buildStair at a fixed place.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const os = require("os");

const ROOT = path.join(__dirname, "..");
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { console.log("  FAIL " + name + ": " + e.message); throw e; } };

/* ── 1. Execute the order model ────────────────────────────────────────── */
const out = fs.mkdtempSync(path.join(os.tmpdir(), "rdo-"));
execSync(`npx tsc src/shell/ribbon-draw-order.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe", cwd: ROOT });
const model = require(path.join(out, "ribbon-draw-order.js"));
const BUILD = model.ARCHITECTURE_BUILD_ORDER;
const CIRC = model.CIRCULATION_STAIRS_ORDER;
const FRAMING = model.STRUCTURE_FRAMING_ORDER;
const FOUND = model.STRUCTURE_FOUNDATIONS_ORDER;

/* ── 2. Parse ribbon.ts ──────────────────────────────────────────────── */
const ribbonSrc = fs.readFileSync(path.join(ROOT, "src/shell/ribbon.ts"), "utf8");
// Full-line comments only (the G6 comments inside TABS must not count).
const noComments = ribbonSrc.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const t0 = noComments.indexOf("const TABS:");
const t1 = noComments.indexOf("\n];", t0);
assert.ok(t0 >= 0 && t1 > t0, "TABS array not found in ribbon.ts");
const region = noComments.slice(t0, t1);
const tabChunks = region.split(/^  \{$/m).slice(1);
const tabId = (c) => { const m = c.match(/^    id: "([^"]+)",$/m); assert.ok(m, "tab chunk without id"); return m[1]; };
const arch = tabChunks.find((c) => tabId(c) === "architecture");
const struct = tabChunks.find((c) => tabId(c) === "structure");
assert.ok(arch, "architecture tab missing from TABS");
assert.ok(struct, "structure tab missing from TABS");

/** Source between groupLabel("X") and the next groupLabel( in a tab chunk. */
function groupSegment(chunk, label) {
  const start = chunk.indexOf(`groupLabel("${label}")`);
  assert.ok(start >= 0, `group "${label}" not found`);
  const rest = chunk.slice(start + 1);
  const next = rest.search(/groupLabel\("/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/**
 * Draw-tool entries in a group segment, in source order.
 * toolBtn("icon", "Label", "tool"[, "KBD"]) -> { kind: "tool", ... }
 * m2Btn("icon", "Label", "kind"[, "KBD"][, "SHAPE"]) -> { kind: "m2", ... }
 * modelGroupButton() -> { kind: "button", label: "Model Group" }
 * bimObjectStudioButton() is a library launcher, not a draw tool: recorded
 * separately, skipped in the order.
 */
function parseEntries(seg) {
  const entries = [];
  const re = /toolBtn\("([^"]+)", "([^"]+)", "([^"]+)"(?:, "([^"]*)")?\)|m2Btn\("([^"]+)", "([^"]+)", "([^"]+)"(?:, "([^"]*)")?(?:, "([^"]*)")?\)|modelGroupButton\(\)|bimObjectStudioButton\(\)/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    if (m[0] === "modelGroupButton()") entries.push({ kind: "button", label: "Model Group" });
    else if (m[0] === "bimObjectStudioButton()") entries.push({ kind: "studio" });
    else if (m[1] !== undefined) entries.push({ kind: "tool", tool: m[3], label: m[2], kbd: m[4] || "" });
    else entries.push({ kind: "m2", tool: m[7], label: m[6], kbd: m[8] || "", shape: m[9] || "straight" });
  }
  return entries;
}

const norm = (entries) => entries.map((e) => {
  if (e.kind === "tool") return { kind: "tool", tool: e.tool, label: e.label };
  if (e.kind === "m2") return { kind: "m2", tool: e.tool, shape: e.shape, label: e.label };
  return { kind: "button", label: e.label };
});
const normModel = (entries) => entries.map((e) => {
  if (e.kind === "tool") return { kind: "tool", tool: e.tool, label: e.label };
  if (e.kind === "m2") return { kind: "m2", tool: e.tool, shape: e.shape ?? "straight", label: e.label };
  return { kind: "button", label: e.label };
});

/* ── 3. Model self-consistency ────────────────────────────────────────── */
t("Build model is the Revit order (Wall..Stair, then Room/Model Line/Model Group)", () => {
  assert.deepStrictEqual(BUILD.map((e) => e.label), ["Wall", "Door", "Window", "Comp", "Column",
    "Roof", "Ceiling", "Floor", "Curtain Wall", "Railing", "Ramp", "Stair",
    "Room", "Model Line", "Model Group"]);
});

t("Framing model is Beam, Brace, Column, Wall, Floor, Truss", () => {
  assert.deepStrictEqual(FRAMING.map((e) => e.label), ["Beam", "Brace", "Column", "Wall", "Floor", "Truss"]);
});

t("Foundations model is Isolated, Wall, Slab, Pile", () => {
  assert.deepStrictEqual(FOUND.map((e) => e.label), ["Isolated", "Wall", "Slab", "Pile"]);
});

t("every deviation in the model carries its reason", () => {
  assert.ok(model.G6_DEVIATIONS.length >= 8, "deviation list looks truncated");
  for (const d of model.G6_DEVIATIONS) assert.ok(d.length > 40, `deviation too short: ${d}`);
  assert.ok(model.G6_DEVIATIONS.some((d) => d.includes("Beam System")), "Beam System deviation missing");
  assert.ok(model.G6_DEVIATIONS.some((d) => d.includes("Model Text")), "Model Text deviation missing");
  assert.ok(model.G6_DEVIATIONS.some((d) => d.includes("Area")), "Area deviation missing");
});

/* ── 4. Architecture Build group matches the model ───────────────────── */
const buildSeg = groupSegment(arch, "Build");
const buildEntries = parseEntries(buildSeg);

t("Architecture Build group order matches the model", () => {
  const tools = buildEntries.filter((e) => e.kind !== "studio");
  assert.deepStrictEqual(norm(tools), normModel(BUILD),
    `Build order ${JSON.stringify(norm(tools))} != model ${JSON.stringify(normModel(BUILD))}`);
});

t("BIM Object Studio launcher kept in Build, exactly once, after Comp", () => {
  const studio = buildEntries.filter((e) => e.kind === "studio").length;
  assert.strictEqual(studio, 1, `Objects button appears ${studio} times in Build`);
  const idx = buildEntries.findIndex((e) => e.kind === "studio");
  const compIdx = buildEntries.findIndex((e) => e.label === "Comp");
  assert.ok(idx === compIdx + 1, "Objects button must sit directly after Comp");
});

t("Beam is gone from the whole Architecture tab", () => {
  assert.ok(!/toolBtn\("beam"/.test(arch), "Beam button still in Architecture");
  assert.ok(!/"Beam"/.test(buildSeg), "Beam label still in Build");
});

t("Door/Window moved to Build, not copied to Openings", () => {
  const openings = groupSegment(arch, "Openings");
  assert.ok(!/toolBtn\("door"/.test(openings), "Door still in Openings (copied, not moved)");
  assert.ok(!/toolBtn\("window"/.test(openings), "Window still in Openings (copied, not moved)");
  assert.ok(openings.includes('"Opening"'), "Openings lost the Opening tool");
  assert.ok(openings.includes('"Shaft"'), "Openings lost the Shaft tool");
  assert.ok(openings.includes('"Hosted Opening"'), "Openings lost Hosted Opening");
});

t("Stair is a placement tool (m2Btn), not instant-build", () => {
  const stair = buildEntries.find((e) => e.label === "Stair");
  assert.ok(stair && stair.kind === "m2" && stair.tool === "stairs" && stair.shape === "straight",
    "Build Stair must be m2Btn stairs/straight");
  assert.ok(!/__obsStairs\?\.buildStair\?\.\(\{\}\)/.test(arch),
    "instant straight-run buildStair({}) still in Architecture");
  assert.ok(ribbonSrc.includes('m2Btn("stairs", "Stair", "stairs", "ST", "straight")'),
    "Build Stair must carry the ST shortcut");
});

t("Curtain Wall + Railing are placement tools in Build", () => {
  const cw = buildEntries.find((e) => e.label === "Curtain Wall");
  const ra = buildEntries.find((e) => e.label === "Railing");
  assert.ok(cw && cw.kind === "tool" && cw.tool === "curtain-wall", "Curtain Wall must be the native curtain-wall tool");
  assert.ok(ra && ra.kind === "m2" && ra.tool === "railing", "Railing must be an M2 placement tool");
  assert.strictEqual(cw.kbd, "CW", "Curtain Wall must carry the CW shortcut");
  assert.strictEqual(ra.kbd, "RA", "Railing must carry the RA shortcut");
});

t("Ramp lost the wrong RM kbd label (RM is Room)", () => {
  const ramp = buildEntries.find((e) => e.label === "Ramp");
  assert.ok(ramp, "Ramp missing from Build");
  assert.strictEqual(ramp.kbd, "", "Ramp must not claim the RM shortcut");
  const room = buildEntries.find((e) => e.label === "Room");
  assert.ok(room && room.kbd === "RM", "Room must carry the RM shortcut");
});

t("Room / Model Line / Model Group close the Build group, in order", () => {
  const tail = buildEntries.filter((e) => e.kind !== "studio").slice(-3);
  assert.deepStrictEqual(tail.map((e) => e.label), ["Room", "Model Line", "Model Group"]);
  assert.ok(ribbonSrc.includes("createFromSelection"),
    "Model Group must group the current selection (createFromSelection)");
});

t("Circulation holds L/U stair placement; Winder/Spiral stay instant-build (documented)", () => {
  const circ = groupSegment(arch, "Circulation");
  const entries = parseEntries(circ);
  assert.deepStrictEqual(norm(entries.filter((e) => e.kind === "m2")), normModel(CIRC));
  assert.ok(/buildStair\?\.\(\{ runType: "winder" \}\)/.test(circ), "Winder instant-build lost (must be kept, not dropped)");
  assert.ok(/buildStair\?\.\(\{ runType: "spiral" \}\)/.test(circ), "Spiral instant-build lost (must be kept, not dropped)");
});

/* ── 5. Structure tab matches the model ──────────────────────────────── */
t("Structure Framing order matches the model", () => {
  const entries = parseEntries(groupSegment(struct, "Framing"));
  assert.deepStrictEqual(norm(entries), normModel(FRAMING));
});

t("Foundations group renamed, order + labels match the model", () => {
  assert.ok(struct.includes('groupLabel("Foundations")'), "Foundations group label missing");
  assert.ok(!/groupLabel\("Found"\)/.test(struct), "old Found group label still present");
  const entries = parseEntries(groupSegment(struct, "Foundations"));
  assert.deepStrictEqual(norm(entries), normModel(FOUND));
  assert.ok(!entries.some((e) => e.label === "Pad" || e.label === "Mat" || e.label === "Strip"),
    "old Pad/Mat/Strip labels still present");
});

t("Reinforcement group renamed from Rebar, tools kept", () => {
  assert.ok(struct.includes('groupLabel("Reinforcement")'), "Reinforcement group label missing");
  assert.ok(!/groupLabel\("Rebar"\)/.test(struct), "old Rebar group label still present");
  const rebar = groupSegment(struct, "Reinforcement");
  assert.ok(rebar.includes('"Generate Rebar"'), "Generate Rebar lost");
  assert.ok(rebar.includes('"Export BBS"'), "Export BBS lost");
  assert.ok(rebar.includes('"Clash Review"'), "Clash Review lost");
});

/* ── 6. Unsupported tools are absent, not faked ──────────────────────── */
t("Beam System / Slab Edge / Area / Model Text are not on the ribbon", () => {
  assert.ok(!/beam-system/i.test(region), "Beam System button exists without an engine");
  assert.ok(!/slab-edge/i.test(region), "Slab Edge button exists without an engine");
  assert.ok(!/toolBtn\("area"/.test(region), "Area tool button exists without a placement tool");
  assert.ok(!/toolBtn\("model-text"/.test(region), "Model Text button exists without an element type");
  assert.ok(!/area-rebar|path-rebar/.test(region), "Area/Path rebar buttons exist without an engine");
});

t("ribbon.ts points at the order model as source of truth", () => {
  assert.ok(ribbonSrc.includes("src/shell/ribbon-draw-order.ts"),
    "ribbon.ts must point at the order model as source of truth");
});

console.log(`\nribbon-draw-order: ${pass} assertions passed`);
