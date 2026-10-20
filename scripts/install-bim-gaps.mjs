#!/usr/bin/env node
/**
 * Installs the BIM-gaps package (Milestones 1, 2 and 3) into an OpenBIMStudio checkout.
 *
 *   node scripts/install-bim-gaps.mjs [projectRoot] [--dry-run]
 *
 * Copy the package's `src/modules/bim-gaps/` folder into the project first.
 * The script makes eleven small, idempotent edits (markers openbim-bim-gaps:v1 / :m2 / :m3):
 *   M1  1. src/critical-gaps-boot.ts              start the bim-gaps boot
 *       2. src/shell/file-menu.ts                 File > Export > Model > IFC4 / IFC2X3
 *       3. src/modules/export/native-twin-ifc.ts  valid IFC GlobalIds
 *   M2  4. src/features/authoring.ts              createMesh asks window.__obsMeshBuilders first
 *       5. src/modules/cost/quantities.ts         takeoff rows for the new element types
 *       6. src/features/bim-parity-bridge.ts    Place Stair / Railing / Curtain Wall buttons start the click tools
 *   M3  7. 8. src/modules/views/generators/plan.ts       drop base geometry of M2 types, then add poche, room tags, symbols, marks
 *       9. src/modules/views/generators/section.ts       real cut sections (poche, oblique cuts, openings)
 *       10. src/modules/views/generators/elevation.ts    real elevations (silhouettes with openings, roof slope)
 *       11. src/modules/export/pdf.ts                    filled polygons that actually appear in the sheet PDF
 * Originals are saved once in <projectRoot>/.bim-gaps-backup/. Line endings
 * (CRLF/LF) are preserved. Nothing is changed if an anchor is not found; the
 * script says so instead of guessing.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const MARK = "openbim-bim-gaps:v1";
const MARK2 = "openbim-bim-gaps:m2";
const MARK3 = "openbim-bim-gaps:m3";
const results = [];

function read(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  return { p, rel, bom, eol, text: body.replace(/\r\n/g, "\n") };
}
function write(f, text) {
  const out = (f.bom ? "\ufeff" : "") + text.replace(/\n/g, f.eol);
  if (dry) return;
  const bdir = path.join(root, ".bim-gaps-backup");
  fs.mkdirSync(bdir, { recursive: true });
  const b = path.join(bdir, f.rel.replace(/[\\/]/g, "__"));
  if (!fs.existsSync(b)) fs.copyFileSync(f.p, b);
  fs.writeFileSync(f.p, out, "utf8");
}
function patch(rel, name, fn, marker = MARK) {
  const f = read(rel);
  if (!f) return results.push({ name, state: "SKIPPED", why: `${rel} not found` });
  if (f.text.includes(marker)) return results.push({ name, state: "already installed" });
  const next = fn(f.text);
  if (!next) return results.push({ name, state: "NOT PATCHED", why: "anchor not found - apply by hand (see docs/BIM_GAPS_M1.md)" });
  write(f, next);
  results.push({ name, state: dry ? "would patch" : "patched" });
}

if (!fs.existsSync(path.join(root, "src/modules/bim-gaps/bim-gaps-boot.ts"))) {
  console.error("src/modules/bim-gaps/bim-gaps-boot.ts not found - copy the package's src/ folder into the project first.");
  process.exit(1);
}

// 1. boot hook
patch("src/critical-gaps-boot.ts", "boot hook", (t) => {
  const re = /^([ \t]*)console\.log\("\[critical-gaps-boot\] all critical gaps wired"\);/m;
  const m = re.exec(t);
  if (!m) return null;
  const i = m[1];
  const block =
    `${i}await safe("bim-gaps", async () => { // ${MARK}\n` +
    `${i}  const m: Any = await import("./modules/bim-gaps/bim-gaps-boot");\n` +
    `${i}  await m.setupBIMGaps?.();\n` +
    `${i}});\n\n`;
  return t.slice(0, m.index) + block + t.slice(m.index);
});

// 2. file menu
patch("src/shell/file-menu.ts", "file menu", (t) => {
  const re = /^([ \t]*)item\([^\n]*void exportGlb\(\)\)[^\n]*\n/m;
  const m = re.exec(t);
  if (!m) return null;
  const i = m[1];
  const add =
    `${i}item("\\u{1F3D7}", "Model \\u2192 IFC4 (authored)", () => void (window as any).__obsBIMGaps?.exportIfc?.("IFC4")), // ${MARK}\n` +
    `${i}item("\\u{1F3D7}", "Model \\u2192 IFC2X3 (BIM 2020)", () => void (window as any).__obsBIMGaps?.exportIfc?.("IFC2X3")), // ${MARK}\n`;
  return t.slice(0, m.index + m[0].length) + add + t.slice(m.index + m[0].length);
});

// 3. valid GlobalIds in the native-twin writer
patch("src/modules/export/native-twin-ifc.ts", "native twin GlobalId", (t) => {
  const re = /function guid\(\): string \{[\s\S]*?\n\}\n/;
  if (!re.test(t)) return null;
  const fn = `function guid(): string { // ${MARK}\n  return newIfcGuid(); // 22-char compressed GUID (the old code emitted random hex, which is not a valid IfcGloballyUniqueId)\n}\n`;
  return `import { newIfcGuid } from "../bim-gaps/ifc-guid"; // ${MARK}\n` + t.replace(re, fn);
});

// 4. M2: authored mesh builders hook (stairs, railings, ramps, curtain walls, roofs, ceilings)
patch("src/features/authoring.ts", "mesh builder hook", (t) => {
  const re = /^([ \t]*)if \(el\.type === "fitting"\) return buildFitting\(el\);[^\n]*\n/m;
  const m = re.exec(t);
  if (!m) return null;
  const i = m[1];
  const block =
    `${i}{ // ${MARK2}: element types with an external mesh builder (bim-gaps M2)\n` +
    `${i}  const mb = (window as any).__obsMeshBuilders?.[el.type];\n` +
    `${i}  if (mb) {\n` +
    `${i}    const mo = mb(el);\n` +
    `${i}    if (mo) { mo.traverse((m: any) => { if (m.isMesh) { m.userData.elementId = el.id; m.userData.baseColor = m.userData.baseColor || el.color || COLORS[el.type] || "#cccccc"; } }); return mo; }\n` +
    `${i}  }\n` +
    `${i}}\n`;
  return t.slice(0, m.index + m[0].length) + block + t.slice(m.index + m[0].length);
}, MARK2);

// 5. M2: cost takeoff quantities
patch("src/modules/cost/quantities.ts", "cost takeoff", (t) => {
  const re = /^([ \t]*)\} else if \(el\.type === "door" \|\| el\.type === "window"\) \{/m;
  const m = re.exec(t);
  if (!m) return null;
  const i = m[1];
  const block =
    `${i}} else if ((window as any).__obsM2Quantities?.(el)) { // ${MARK2}\n` +
    `${i}  const q = (window as any).__obsM2Quantities(el);\n` +
    `${i}  length = q.length; area = q.area; volume = q.volume; detailSuffix = q.detail;\n` +
    `${i}} else if (el.type === "door" || el.type === "window") {`;
  return t.slice(0, m.index) + block + t.slice(m.index + m[0].length);
}, MARK2);

// 6. M2: the parity buttons used to drop fixed-size objects at the origin
patch("src/features/bim-parity-bridge.ts", "parity buttons", (t) => {
  const heads = [
    [/^(async function placeStair\([^)]*\)[^{\n]*\{\n)/m, `  if ((window as any).__obsM2?.start) { (window as any).__obsM2.start("stairs", runType === "l-shape" ? "L" : runType === "u-shape" ? "U" : "straight"); return; } // ${MARK2}\n`],
    [/^(async function placeRailing\([^)]*\)[^{\n]*\{\n)/m, `  if ((window as any).__obsM2?.start) { (window as any).__obsM2.start("railing"); return; } // ${MARK2}\n`],
    [/^(async function placeCurtainWall\([^)]*\)[^{\n]*\{\n)/m, `  if ((window as any).__obsM2?.start) { (window as any).__obsM2.start("curtain-wall"); return; } // ${MARK2}\n`],
  ];
  let out = t;
  for (const [re, ins] of heads) {
    const m = re.exec(out);
    if (!m) return null;
    out = out.slice(0, m.index + m[0].length) + ins + out.slice(m.index + m[0].length);
  }
  return out;
}, MARK2);

// 7 + 8. M3: plan generator (two anchors in one file)
patch("src/modules/views/generators/plan.ts", "plan generator", (t) => {
  const a = /^([ \t]*)maxSegments: 250_000,\n[ \t]*\}\);\n/m.exec(t);
  const b = /^([ \t]*)scene\.generatedAt = Date\.now\(\);\n[ \t]*return scene;/m.exec(t);
  if (!a || !b) return null;
  const i1 = a[1].slice(0, -2) || "  ", i2 = b[1];
  const filterLine = `${i1}try { (window as any).__obsViewExt?.planFilter?.(planView, def); } catch { /* */ } // ${MARK3}\n`;
  const addLine = `${i2}try { await (window as any).__obsViewExt?.plan?.(def, scene); } catch { /* */ } // ${MARK3}\n`;
  // apply the later insertion first so the earlier index stays valid
  let out = t.slice(0, b.index) + addLine + t.slice(b.index);
  out = out.slice(0, a.index + a[0].length) + filterLine + out.slice(a.index + a[0].length);
  return out;
}, MARK3);

// 9. M3: section generator
patch("src/modules/views/generators/section.ts", "section generator", (t) => {
  const m = /^([ \t]*)if \(!def\.section\) return scene;[^\n]*\n/m.exec(t);
  if (!m) return null;
  const add = `${m[1]}{ const ext = await (window as any).__obsViewExt?.section?.(def).catch(() => null); if (ext) return ext; } // ${MARK3}\n`;
  return t.slice(0, m.index + m[0].length) + add + t.slice(m.index + m[0].length);
}, MARK3);

// 10. M3: elevation generator
patch("src/modules/views/generators/elevation.ts", "elevation generator", (t) => {
  const m = /^([ \t]*)if \(!def\.elevation\) return scene;[^\n]*\n/m.exec(t);
  if (!m) return null;
  const add = `${m[1]}{ const ext = await (window as any).__obsViewExt?.elevation?.(def).catch(() => null); if (ext) return ext; } // ${MARK3}\n`;
  return t.slice(0, m.index + m[0].length) + add + t.slice(m.index + m[0].length);
}, MARK3);

// 11. M3: polygon fills in the sheet PDF (drawSvgPath is y-down and was handed page y-up coordinates)
patch("src/modules/export/pdf.ts", "pdf polygon fill", (t) => {
  const re = /if \(e\.fill && pts\.length >= 3\) \{/;
  if (!re.test(t)) return null;
  return t.replace(re, `if (e.fill && pts.length >= 3 && !((window as any).__obsM3FillPolygon?.(ctx.page, pts, hexToRgb(e.fill.color), e.fill.opacity ?? 1))) { // ${MARK3}`);
}, MARK3);

console.log((dry ? "[dry run] " : "") + "BIM gaps install in " + root);
for (const r of results) console.log(`  ${r.state.padEnd(18)} ${r.name}${r.why ? "  - " + r.why : ""}`);
if (results.some((r) => r.state === "NOT PATCHED" || r.state === "SKIPPED")) process.exitCode = 2;
else console.log("Done. Run `npx tsc --noEmit`, then `npm run dev` and look for '[bim-gaps]' in the console (7/7 steps).");
