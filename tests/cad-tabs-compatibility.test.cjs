#!/usr/bin/env node
/* Drift-guard: the native 2D CAD engine carries the full Drafting ribbon —
 * 9 tabs (Home, Insert, Annotate, Parametric, View, Manage, Output, Express
 * Tools, Collaborate) with their related buttons and commands. */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const viewer = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
const params = fs.readFileSync(path.join(root, "src/features/cad-params.ts"), "utf8");
const types = fs.readFileSync(path.join(root, "src/modules/drawings/dxf-types.ts"), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};

console.log("cad-tabs-compatibility: Drafting ribbon compatibility in the native 2D engine");

/* 1 — the 9 ribbon tabs in Drafting workspace order */
ok(/id: "home"[\s\S]*id: "insert"[\s\S]*id: "annotate"[\s\S]*id: "parametric"[\s\S]*id: "view"[\s\S]*id: "manage"[\s\S]*id: "output"[\s\S]*id: "express"[\s\S]*id: "collaborate"/.test(viewer),
  "RIBBON_TABS: Home → Insert → Annotate → Parametric → View → Manage → Output → Express Tools → Collaborate");
ok(/label: "Parametric"/.test(viewer), "Parametric tab present");
ok(/label: "Express Tools"/.test(viewer), "Express Tools tab present");
ok(/label: "Collaborate"/.test(viewer), "Collaborate tab present");

/* 2 — CSS shows the new tabs' panel groups */
for (const t of ["parametric", "express", "collaborate"]) {
  ok(new RegExp(`data-ribbon-tab="${t}"\\] \\.cadrg\\[data-cadtab="${t}"`).test(viewer),
    `CSS filter shows ${t} panels when the ${t} tab is active`);
}

/* 3 — Parametric panels and buttons */
for (const [attr, label] of [
  ["con-auto", "Auto Constrain"], ["con-fix", "Fix"], ["con-hor", "Horizontal"],
  ["con-ver", "Vertical"], ["con-perp", "Perpendicular"], ["con-par", "Parallel"],
  ["con-tan", "Tangent"], ["con-conc", "Concentric"], ["con-coin", "Coincident"],
  ["con-sym", "Symmetric"], ["con-eq", "Equal"],
  ["dc-linear", "DC Linear"], ["dc-radius", "DC Radius"], ["dc-dia", "DC Diameter"], ["dc-ang", "DC Angular"],
  ["con-bar", "Constraint Bar"], ["con-unfixall", "Unfix All"],
]) {
  ok(viewer.includes(`data-a="${attr}"`) && viewer.includes(label), `Parametric button ${label} (${attr})`);
}

/* 4 — Express Tools panels and buttons */
for (const [tool, label] of [
  ["txt2mtxt", "TXT2MTXT"], ["explodetext", "ExplodeText"], ["textfit", "TextFit"],
  ["arctext", "ArcText"], ["textmask", "TextMask"], ["breakline", "Break-line"],
  ["laymrg", "LayMrg"], ["laydel", "LayDel"], ["matchlayer", "Layer Match"],
]) {
  ok(new RegExp(`tb\\("${tool}"`).test(viewer) && viewer.includes(label), `Express Tools button ${label} (${tool})`);
}
for (const [attr, label] of [
  ["flatten", "Flatten"], ["overkill", "Overkill"], ["laywalk", "LayWalk"],
  ["layfrz", "LayFrz"], ["laythw", "LayThw"], ["aliases", "Command Aliases"],
]) {
  ok(viewer.includes(`data-a="${attr}"`) && viewer.includes(label), `Express Tools action ${label} (${attr})`);
}

/* 5 — Collaborate panels and buttons */
for (const [attr, label] of [
  ["publish", "Publish All"], ["shareview", "Share View"], ["dwgversion", "DWG Version"],
  ["dwghistory", "Drawing History"], ["checkstd", "Check Standards"],
]) {
  ok(viewer.includes(`data-a="${attr}"`) && viewer.includes(label), `Collaborate button ${label} (${attr})`);
}

/* 6 — Manage / View tab additions */
ok(viewer.includes(`data-a="ribbon-min"`) && viewer.includes(`data-a="cleanscreen"`), "Manage: Customization panel (Ribbon / Clean Screen)");
ok(/"CAD Standards"[\s\S]{0,220}data-a="checkstd"/.test(viewer), "Manage: CAD Standards panel");
ok(/"Palettes"[\s\S]{0,900}data-a="cal"/.test(viewer), "View: Palettes panel (Properties / Layers / Linetypes / QSELECT / FIND / CAL)");

/* 7 — command definitions for the command line + alias editor */
for (const cmd of [
  "AUTOCONSTRAIN", "FIX", "UNFIX", "HORIZONTAL", "VERTICAL", "PERPENDICULAR", "PARALLEL",
  "TANGENT", "CONCENTRIC", "COINCIDENT", "SYMMETRIC", "EQUAL",
  "DCLINEAR", "DCRADIUS", "DCDIAMETER", "DCANGULAR", "CONSTRAINTBAR", "DELCONSTRAINT",
  "TXT2MTXT", "EXPLODETEXT", "TEXTFIT", "ARCTEXT", "TEXTMASK", "FLATTEN", "BREAKLINE",
  "LAYMRG", "LAYDEL", "LAYWALK", "LAYFRZ", "LAYTHW",
  "PUBLISH", "SHAREVIEW", "DWGHISTORY", "CHECKSTANDARDS",
]) {
  ok(new RegExp(`name: "${cmd}"`).test(viewer), `CAD_COMMANDS defines ${cmd}`);
}

/* 8 — command-line dispatch wires every new command */
for (const cmd of ["AUTOCONSTRAIN", "DCLINEAR", "TXT2MTXT", "LAYMRG", "LAYWALK", "PUBLISH", "CHECKSTANDARDS"]) {
  ok(new RegExp(`cmd === "${cmd}"`).test(viewer), `executeDraftingCommand dispatches ${cmd}`);
}

/* 9 — pure geometry helpers exist in cad-params.ts */
for (const fn of [
  "fixHorizontal", "fixVertical", "fixParallel", "fixPerpendicular", "fixTangent",
  "fixConcentric", "fixCoincident", "fixSymmetric", "fixEqual", "autoConstrain",
  "dimLinear", "dimRadius", "dimAngular",
  "textToMText", "mTextToText", "textFit", "textMaskToggle", "arcText",
  "flattenEnt", "breakline", "checkStandards",
]) {
  ok(new RegExp(`export function ${fn}\\(`).test(params), `cad-params exports ${fn}()`);
}

/* 10 — FIX gate: fixed objects refuse edits */
ok(/function commitModify[\s\S]{0,220}fixedEnts\.has/.test(viewer), "commitModify refuses fixed objects");
ok(/function commitReplace[\s\S]{0,260}fixedEnts\.has/.test(viewer), "commitReplace refuses fixed objects");
ok(/function eraseSelected[\s\S]{0,320}fixedEnts\.has/.test(viewer), "eraseSelected refuses fixed objects");
ok(/fixedEnts\.clear\(\)/.test(viewer), "FIX state resets on drawing load");

/* 11 — TEXTMASK visual support */
ok(/mask\?: boolean/.test(types), "TEXT entity carries the optional mask flag");
ok(/e\.mask && bl\.length/.test(viewer), "renderer paints the TEXTMASK background box");

/* 12 — pick flows armed for the new tools */
for (const t of ["con2p", "confix", "txt2mtxt", "explodetext", "textfit", "arctext", "textmask", "breakline", "laymrg", "laydel"]) {
  ok(new RegExp(`t === "${t}"`).test(viewer), `isPickTool arms ${t}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
