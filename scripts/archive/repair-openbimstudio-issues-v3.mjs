// Open BIM Studio - v3 repair pass. Structural detection, CRLF-aware, idempotent.
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const V3 = "openbim-fix:v3";

const stats = { patched: 0, noop: 0, skipped: 0, warned: 0, repaired: 0, marked: 0 };

function full(rel) { return path.join(root, rel); }
function exists(rel) { try { fs.accessSync(full(rel)); return true; } catch { return false; } }

function readNormalized(rel) {
  const raw = fs.readFileSync(full(rel), "utf8");
  const wasCRLF = raw.indexOf("\r\n") >= 0;
  const text = wasCRLF ? raw.split("\r\n").join("\n") : raw;
  return { text, wasCRLF };
}
function writeRestored(rel, text, wasCRLF) {
  const out = wasCRLF ? text.split("\n").join("\r\n") : text;
  fs.writeFileSync(full(rel), out, "utf8");
}
function backup(rel, suffix) {
  if (!exists(rel)) return;
  const sfx = suffix || ("v3-" + stamp);
  fs.copyFileSync(full(rel), full(rel) + ".bak-" + sfx);
}
function findBackups(rel) {
  const dir = path.dirname(full(rel));
  const base = path.basename(rel);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const matches = entries.filter(f => f.startsWith(base + ".bak"));
  matches.sort((a, b) => {
    const sa = fs.statSync(path.join(dir, a)).mtimeMs;
    const sb = fs.statSync(path.join(dir, b)).mtimeMs;
    return sa - sb;
  });
  return matches.map(f => path.join(dir, f));
}
function log(kind, name, note) {
  let tag;
  if (kind === "PATCH") { tag = "PATCH "; stats.patched++; }
  else if (kind === "NOOP") { tag = "NOOP  "; stats.noop++; }
  else if (kind === "WARN") { tag = "WARN  "; stats.warned++; }
  else if (kind === "REPAIR") { tag = "REPAIR"; stats.repaired++; }
  else if (kind === "MARK") { tag = "MARK  "; stats.marked++; }
  else { tag = "SKIP  "; stats.skipped++; }
  console.log("  [" + tag + "] " + name + (note ? "  -- " + note : ""));
}
function hasV3(rel) {
  try { return fs.readFileSync(full(rel), "utf8").indexOf(V3) >= 0; }
  catch { return false; }
}
function markIfNeeded(rel) {
  const raw = fs.readFileSync(full(rel), "utf8");
  if (raw.indexOf(V3) >= 0) return false;
  const hasCRLF = raw.indexOf("\r\n") >= 0;
  const header = "// " + V3 + ":applied -- do not re-apply the earlier fix scripts\n";
  const out = hasCRLF ? header.replace(/\n/g, "\r\n") + raw : header + raw;
  fs.writeFileSync(full(rel), out, "utf8");
  return true;
}
function dumpContext(text, needle, radius) {
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].indexOf(needle) >= 0) hits.push(i);
  if (!hits.length) { console.log("    (diag) no line contains: " + JSON.stringify(needle)); return; }
  for (const h of hits.slice(0, 2)) {
    const a = Math.max(0, h - radius);
    const b = Math.min(lines.length - 1, h + radius);
    console.log("    (diag) around line " + (h + 1) + ":");
    for (let i = a; i <= b; i++) console.log("    " + String(i + 1).padStart(5, " ") + " | " + lines[i]);
  }
}

// =============================================================================
// A. native-twin-ifc.ts
// =============================================================================
function fixNativeTwinIfc() {
  const rel = "src/modules/export/native-twin-ifc.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }

  let raw = fs.readFileSync(full(rel), "utf8");
  const countLen = (raw.match(/const\s+lengthUnit\s*=\s*next\(\);/g) || []).length;
  const countAssign = (raw.match(/const\s+unitAssign\s*=\s*next\(\);/g) || []).length;
  const hasUnitAssign = raw.indexOf("IFCUNITASSIGNMENT") >= 0;
  const hasFaceSet = raw.indexOf("IFCTRIANGULATEDFACESET") >= 0;
  const hasFaceTypo = raw.indexOf("IFCTRIANGULATEDFACESSET") >= 0;
  const dup = countLen > 1 || countAssign > 1;

  const structurallyFixed =
    !dup && hasUnitAssign && hasFaceSet && !hasFaceTypo &&
    countLen === 1 && countAssign === 1;

  if (structurallyFixed && hasV3(rel)) {
    log("NOOP", rel + " (already fixed + marked)");
    return;
  }

  if (dup) {
    const backups = findBackups(rel);
    if (!backups.length) {
      log("WARN", rel + " (duplicates present; no backup to restore)");
      return;
    }
    const oldest = backups[0];
    console.log("    (repair) duplicate unit-id blocks: lengthUnit x" + countLen +
                ", unitAssign x" + countAssign);
    console.log("    (repair) restoring from " + path.basename(oldest));
    backup(rel, "pre-restore-" + stamp);
    fs.copyFileSync(oldest, full(rel));
    log("REPAIR", rel + " (restored from " + path.basename(oldest) + ")");
    raw = fs.readFileSync(full(rel), "utf8");
  }

  const { text: s0, wasCRLF } = readNormalized(rel);
  let s = s0;
  let changed = false;

  // ---- A1: unit-id declarations before the project id ----
  if (s.indexOf("const lengthUnit = next();") < 0) {
    const anchor = "const project = next();";
    const idx = s.indexOf(anchor);
    if (idx < 0) {
      log("WARN", rel + " (A1 `project = next()` not found)");
      dumpContext(s, "next()", 4);
      return;
    }
    const lineStart = s.lastIndexOf("\n", idx) + 1;
    const indent = s.slice(lineStart, idx);
    const block =
      indent + "const lengthUnit = next();\n" +
      indent + "const areaUnit   = next();\n" +
      indent + "const volumeUnit = next();\n" +
      indent + "const angleUnit  = next();\n" +
      indent + "const unitAssign = next();\n" +
      "\n";
    s = s.slice(0, lineStart) + block + s.slice(lineStart);
    changed = true;
  }

  // ---- A2: replace the broken IFCPROJECT block ----
  const startRe = /lines\.push\(`#\$\{project\}=IFCPROJECT\(/;
  const startM = startRe.exec(s);
  const endAnchor = "// Simpler approach: minimal valid structure without full unit assignment complexity";
  const endIdx = s.indexOf(endAnchor);
  if (!startM || endIdx < startM.index) {
    log("WARN", rel + " (A2 IFCPROJECT block anchor missing)");
    dumpContext(s, "IFCPROJECT", 4);
    return;
  }
  // Only replace if IFCUNITASSIGNMENT is not already emitted nearby.
  const lookAhead = s.slice(startM.index, Math.min(s.length, startM.index + 400));
  if (lookAhead.indexOf("IFCUNITASSIGNMENT") < 0) {
    const idxLineStart = s.lastIndexOf("\n", startM.index) + 1;
    const indent2 = s.slice(idxLineStart, startM.index);
    const replacement =
      indent2 + "lines.push(`#${lengthUnit}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);\n" +
      indent2 + "lines.push(`#${areaUnit}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);`);\n" +
      indent2 + "lines.push(`#${volumeUnit}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);`);\n" +
      indent2 + "lines.push(`#${angleUnit}=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);`);\n" +
      indent2 + "lines.push(`#${unitAssign}=IFCUNITASSIGNMENT((#${lengthUnit},#${areaUnit},#${volumeUnit},#${angleUnit}));`);\n" +
      indent2 + "lines.push(`#${project}=IFCPROJECT('${guid()}',#${owner},'Native Twin Export',$,$,$,$,(#${unitAssign}),$);`);\n";
    s = s.slice(0, idxLineStart) + replacement + s.slice(endIdx + endAnchor.length);
    changed = true;
  }

  // ---- A3: face-set typo ----
  if (s.indexOf("IFCTRIANGULATEDFACESSET") >= 0) {
    s = s.split("IFCTRIANGULATEDFACESSET").join("IFCTRIANGULATEDFACESET");
    changed = true;
  }

  // ---- mark ----
  if (s.indexOf(V3) < 0) s = "// " + V3 + ":applied\n" + s;

  if (changed || !hasV3(rel)) {
    backup(rel, "v3-" + stamp);
    writeRestored(rel, s, wasCRLF);
    log("PATCH", rel, wasCRLF ? "(CRLF preserved)" : "(LF)");
  } else {
    log("NOOP", rel + " (nothing to do)");
  }
}

// =============================================================================
// B. units.ts
// =============================================================================
function fixUnits() {
  const rel = "src/core/units.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: src, wasCRLF } = readNormalized(rel);

  const structurallyFixed =
    src.indexOf("function matchAreaSuffix") >= 0 &&
    src.indexOf("function matchVolumeSuffix") >= 0 &&
    src.indexOf("function matchMassSuffix") >= 0 &&
    src.indexOf("function matchAngleSuffix") >= 0 &&
    src.indexOf("matchAreaSuffix(suffix)") >= 0 &&
    src.indexOf("matchVolumeSuffix(suffix)") >= 0 &&
    src.indexOf("matchMassSuffix(suffix)") >= 0 &&
    src.indexOf("matchAngleSuffix(suffix)") >= 0;

  if (structurallyFixed) {
    if (markIfNeeded(rel)) log("MARK", rel + " (structure ok, marker added)");
    else log("NOOP", rel + " (already fixed + marked)");
    return;
  }

  let s = src;
  let changed = false;

  // ---- B1: helper functions before parseDimension ----
  if (s.indexOf("function matchAreaSuffix") < 0) {
    const anchor = "function parseDimension(input: string, unit: string): number | null {";
    const idx = s.indexOf(anchor);
    if (idx < 0) {
      log("WARN", rel + " (B1 parseDimension not found)");
      dumpContext(s, "parseDimension", 5);
      return;
    }
    const sq = String.fromCharCode(0x00B2);
    const cu = String.fromCharCode(0x00B3);
    const dg = String.fromCharCode(0x00B0);
    const helpers =
      "// " + V3 + ":units.ts -- suffix matchers for non-length kinds\n" +
      "function matchAreaSuffix(s: string): AreaUnit | null {\n" +
      "  switch (s) {\n" +
      "    case \"mm2\": case \"mm" + sq + "\": return \"mm2\";\n" +
      "    case \"cm2\": case \"cm" + sq + "\": return \"cm2\";\n" +
      "    case \"m2\":  case \"m" + sq + "\":  return \"m2\";\n" +
      "    case \"ft2\": case \"ft" + sq + "\": return \"ft2\";\n" +
      "    case \"in2\": case \"in" + sq + "\": return \"in2\";\n" +
      "    default: return null;\n" +
      "  }\n" +
      "}\n" +
      "function matchVolumeSuffix(s: string): VolumeUnit | null {\n" +
      "  switch (s) {\n" +
      "    case \"mm3\": case \"mm" + cu + "\": return \"mm3\";\n" +
      "    case \"cm3\": case \"cm" + cu + "\": return \"cm3\";\n" +
      "    case \"m3\":  case \"m" + cu + "\":  return \"m3\";\n" +
      "    case \"ft3\": case \"ft" + cu + "\": return \"ft3\";\n" +
      "    case \"in3\": case \"in" + cu + "\": return \"in3\";\n" +
      "    case \"l\": case \"ltr\": return \"l\";\n" +
      "    default: return null;\n" +
      "  }\n" +
      "}\n" +
      "function matchMassSuffix(s: string): MassUnit | null {\n" +
      "  switch (s) {\n" +
      "    case \"g\": return \"g\";\n" +
      "    case \"kg\": return \"kg\";\n" +
      "    case \"t\": return \"t\";\n" +
      "    case \"lb\": case \"lbs\": return \"lb\";\n" +
      "    case \"oz\": return \"oz\";\n" +
      "    default: return null;\n" +
      "  }\n" +
      "}\n" +
      "function matchAngleSuffix(s: string): AngleUnit | null {\n" +
      "  switch (s) {\n" +
      "    case \"deg\": case \"" + dg + "\": return \"deg\";\n" +
      "    case \"rad\": return \"rad\";\n" +
      "    case \"grad\": return \"grad\";\n" +
      "    default: return null;\n" +
      "  }\n" +
      "}\n\n";
    s = s.slice(0, idx) + helpers + s.slice(idx);
    changed = true;
  }

  // ---- B2: switch case rewrites ----
  const cases = [
    {
      re: /case\s+"mm2"\s*:\s*case\s+"cm2"\s*:\s*case\s+"m2"\s*:\s*case\s+"ft2"\s*:\s*case\s+"in2"\s*:\s*\n\s*return\s+value\s*\*\s*AREA_TO_M2\[unit as AreaUnit\];/,
      repl: 'case "mm2": case "cm2": case "m2": case "ft2": case "in2": {\n' +
            '      const u = (suffix ? matchAreaSuffix(suffix) : null) ?? (unit as AreaUnit);\n' +
            '      return value * AREA_TO_M2[u];\n' +
            '    }'
    },
    {
      re: /case\s+"mm3"\s*:\s*case\s+"cm3"\s*:\s*case\s+"m3"\s*:\s*case\s+"ft3"\s*:\s*case\s+"in3"\s*:\s*case\s+"l"\s*:\s*\n\s*return\s+value\s*\*\s*VOLUME_TO_M3\[unit as VolumeUnit\];/,
      repl: 'case "mm3": case "cm3": case "m3": case "ft3": case "in3": case "l": {\n' +
            '      const u = (suffix ? matchVolumeSuffix(suffix) : null) ?? (unit as VolumeUnit);\n' +
            '      return value * VOLUME_TO_M3[u];\n' +
            '    }'
    },
    {
      re: /case\s+"g"\s*:\s*case\s+"kg"\s*:\s*case\s+"t"\s*:\s*case\s+"lb"\s*:\s*case\s+"oz"\s*:\s*\n\s*return\s+value\s*\*\s*MASS_TO_KG\[unit as MassUnit\];/,
      repl: 'case "g": case "kg": case "t": case "lb": case "oz": {\n' +
            '      const u = (suffix ? matchMassSuffix(suffix) : null) ?? (unit as MassUnit);\n' +
            '      return value * MASS_TO_KG[u];\n' +
            '    }'
    },
    {
      re: /case\s+"deg"\s*:\s*case\s+"rad"\s*:\s*case\s+"grad"\s*:\s*\n\s*return\s+value\s*\*\s*ANGLE_TO_RAD\[unit as AngleUnit\];/,
      repl: 'case "deg": case "rad": case "grad": {\n' +
            '      const u = (suffix ? matchAngleSuffix(suffix) : null) ?? (unit as AngleUnit);\n' +
            '      return value * ANGLE_TO_RAD[u];\n' +
            '    }'
    },
  ];
  for (const c of cases) {
    if (c.re.test(s)) { s = s.replace(c.re, c.repl); changed = true; }
  }

  // ---- B3: widen the parse regex ----
  const reLine = /cleaned\.match\(\/\^\(-?\[[^\]]*\]\+\)\s\*\(\[a-zA-Z([^\]\n]*)\]\)\?\$\//;
  const m3 = reLine.exec(s);
  if (m3) {
    const sq = String.fromCharCode(0x00B2);
    const cu = String.fromCharCode(0x00B3);
    if (m3[1].indexOf(sq) < 0) {
      const inner = m3[1] + sq + cu;
      s = s.replace(m3[0], m3[0].replace("[a-zA-Z" + m3[1] + "]", "[a-zA-Z" + inner + "]"));
      changed = true;
    }
  }

  if (!changed) {
    log("WARN", rel + " (no anchors matched; see diagnostic)");
    dumpContext(s, "parseDimension", 5);
    dumpContext(s, "cleaned.match", 3);
    return;
  }

  if (s.indexOf(V3) < 0) s = "// " + V3 + ":applied\n" + s;

  backup(rel, "v3-" + stamp);
  writeRestored(rel, s, wasCRLF);
  log("PATCH", rel, wasCRLF ? "(CRLF preserved)" : "(LF)");
}

// =============================================================================
// E/F/G. Mark-only for the three files v1 already fixed.
// =============================================================================
function markOnly(rel, structural) {
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const src = fs.readFileSync(full(rel), "utf8");
  if (!structural(src)) {
    log("WARN", rel + " (structure missing; manual repair needed)");
    dumpContext(src, "openbim-fix", 3);
    return;
  }
  if (markIfNeeded(rel)) log("MARK", rel + " (structure ok, marker added)");
  else log("NOOP", rel + " (already fixed + marked)");
}

const isClashFixed = (src) =>
  /let\s+range\s*=\s*ranges\.get\(localId\);\s*\n\s*if\s*\(!range\)\s*\{/.test(src);

const isAuthoringFixed = (src) =>
  src.indexOf("handlesActive") >= 0 && src.indexOf("obs-wall-handles") >= 0;

const isNavigationFixed = (src) => {
  const a = src.indexOf("__OBS_WHEEL_AUTHORITY");
  const b = src.indexOf("pickWorldPointUnderCursor(g.event.clientX");
  return a >= 0 && b >= 0 && a < b;
};

// =============================================================================
// Run
// =============================================================================
console.log("");
console.log("v3 repair pass -- structural detection + duplicate cleanup...");
console.log("");
fixNativeTwinIfc();
fixUnits();
markOnly("src/modules/clash/geometry.ts", isClashFixed);
markOnly("src/features/authoring.ts", isAuthoringFixed);
markOnly("src/features/navigation.ts", isNavigationFixed);
console.log("");
console.log("Summary: " + stats.patched + " patched, " + stats.repaired + " repaired, " +
            stats.marked + " marked, " + stats.noop + " no-op, " +
            stats.skipped + " skipped, " + stats.warned + " warned.");
console.log("");
if (stats.warned > 0) {
  console.log("Copy any (diag) block above back verbatim so the next pass can be exact.");
  console.log("");
}