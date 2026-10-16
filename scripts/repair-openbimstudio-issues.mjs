// Repair pass for Fix-OpenBIMStudio-Issues. Idempotent, CRLF-aware, granular markers.
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const FIX = "openbim-fix";

const stats = { patched: 0, noop: 0, skipped: 0, warned: 0, crlf: 0, lf: 0 };

function full(rel) { return path.join(root, rel); }
function exists(rel) { try { fs.accessSync(full(rel)); return true; } catch { return false; } }
function backup(rel) {
  if (!exists(rel)) return;
  fs.copyFileSync(full(rel), full(rel) + ".bak-" + stamp + "2");
}
function log(kind, name, note) {
  let tag;
  if (kind === "PATCH") { tag = "PATCH"; stats.patched++; }
  else if (kind === "NOOP") { tag = "NOOP "; stats.noop++; }
  else if (kind === "WARN") { tag = "WARN "; stats.warned++; }
  else { tag = "SKIP "; stats.skipped++; }
  console.log("  [" + tag + "] " + name + (note ? "  -- " + note : ""));
}

// -----------------------------------------------------------------------------
// CRLF-aware read/write. Returns { text, wasCRLF }.
// -----------------------------------------------------------------------------
function readNormalized(rel) {
  const raw = fs.readFileSync(full(rel), "utf8");
  const wasCRLF = raw.indexOf("\r\n") >= 0;
  const text = wasCRLF ? raw.split("\r\n").join("\n") : raw;
  if (wasCRLF) stats.crlf++; else stats.lf++;
  return { text, wasCRLF };
}
function writeRestored(rel, text, wasCRLF) {
  const out = wasCRLF ? text.split("\n").join("\r\n") : text;
  fs.writeFileSync(full(rel), out, "utf8");
}

// -----------------------------------------------------------------------------
// Diagnostic: print lines of `text` that contain `needle`, +/- radius.
// -----------------------------------------------------------------------------
function dumpContext(text, needle, radius) {
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].indexOf(needle) >= 0) hits.push(i);
  if (!hits.length) {
    console.log("    (diagnostic) no line contains: " + JSON.stringify(needle));
    return;
  }
  for (const h of hits.slice(0, 3)) {
    const a = Math.max(0, h - radius);
    const b = Math.min(lines.length - 1, h + radius);
    console.log("    (diagnostic) around line " + (h + 1) + ":");
    for (let i = a; i <= b; i++) {
      console.log("    " + String(i + 1).padStart(5, " ") + " | " + lines[i]);
    }
  }
  if (hits.length > 3) console.log("    (diagnostic) ... " + (hits.length - 3) + " more hit(s).");
}

// =============================================================================
// A. native-twin-ifc.ts
//    v1 partially applied: A1 (unit-id declarations) may already be in place.
//    A2 (IFCPROJECT + IFCUNITASSIGNMENT) and A3 (face-set typo) still to apply.
// =============================================================================
function fixNativeTwinIfc() {
  const rel = "src/modules/export/native-twin-ifc.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }

  const { text: src, wasCRLF } = readNormalized(rel);
  let s = src;
  let changed = false;

  const hasUnitsMarker = s.indexOf(FIX + ":native-twin-ifc:units") >= 0
                      || s.indexOf(FIX + ":native-twin-ifc -- IFC4 unit assignment ids") >= 0;
  const hasFacesMarker = s.indexOf(FIX + ":native-twin-ifc:faces") >= 0;

  // ---------- A1: declarations (only if v1 didn't already do it) ----------
  if (!hasUnitsMarker) {
    const a1 = "  const project = next();\n  const site = next();";
    if (s.indexOf(a1) >= 0) {
      s = s.split(a1).join(
        "  // " + FIX + ":native-twin-ifc:units -- IFC4 unit ids declared before project\n" +
        "  const lengthUnit = next();\n" +
        "  const areaUnit   = next();\n" +
        "  const volumeUnit = next();\n" +
        "  const angleUnit  = next();\n" +
        "  const unitAssign = next();\n" +
        "\n" +
        "  const project = next();\n" +
        "  const site = next();"
      );
      changed = true;
    } else {
      log("WARN", rel + " (A1 unit-id anchor not found)");
      dumpContext(s, "const project = next();", 3);
    }
  }

  // ---------- A2: replace the broken IFCPROJECT block ----------
  if (s.indexOf(FIX + ":native-twin-ifc:header") < 0) {
    // Structural search: find the line that starts with `  lines.push(\`#${project}=IFCPROJECT(`...
    const reStart = /lines\.push\(`#\$\{project\}=IFCPROJECT\([^\n]*\n/;
    const mStart = reStart.exec(s);
    // End anchor: the last comment in the broken block.
    const endAnchor = "// Simpler approach: minimal valid structure without full unit assignment complexity";
    const endIdx = s.indexOf(endAnchor);

    if (mStart && endIdx > mStart.index) {
      const replacement =
        "  // " + FIX + ":native-twin-ifc:header -- correct IFC4 unit + project header\n" +
        "  lines.push(`#${lengthUnit}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);\n" +
        "  lines.push(`#${areaUnit}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);`);\n" +
        "  lines.push(`#${volumeUnit}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);`);\n" +
        "  lines.push(`#${angleUnit}=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);`);\n" +
        "  lines.push(`#${unitAssign}=IFCUNITASSIGNMENT((#${lengthUnit},#${areaUnit},#${volumeUnit},#${angleUnit}));`);\n" +
        "  lines.push(`#${project}=IFCPROJECT('${guid()}',#${owner},'Native Twin Export',$,$,$,$,(#${unitAssign}),$);`);";
      s = s.slice(0, mStart.index) + replacement + s.slice(endIdx + endAnchor.length);
      changed = true;
    } else {
      log("WARN", rel + " (A2 IFCPROJECT block not located)");
      dumpContext(s, "IFCPROJECT", 4);
    }
  }

  // ---------- A3: face-set typo ----------
  if (!hasFacesMarker) {
    if (s.indexOf("IFCTRIANGULATEDFACESSET") >= 0) {
      s = s.split("IFCTRIANGULATEDFACESSET").join("IFCTRIANGULATEDFACESET");
      // Leave a marker so re-runs are no-ops.
      s = s.replace(
        /(\n[ \t]*lines\.push\(`#\$\{faces\}=IFCTRIANGULATEDFACESET)/,
        "\n    // " + FIX + ":native-twin-ifc:faces -- correct IFC4 entity name\n$1"
      );
      changed = true;
    } else if (s.indexOf("IFCTRIANGULATEDFACESET") < 0) {
      log("WARN", rel + " (A3 no triangulated face-set token found at all)");
      dumpContext(s, "FaceSet", 3);
    }
  }

  if (changed) {
    backup(rel);
    writeRestored(rel, s, wasCRLF);
    log("PATCH", rel, wasCRLF ? "(CRLF preserved)" : "(LF)");
  } else {
    log("NOOP", rel + " (nothing to do)");
  }
}

// =============================================================================
// B. units.ts -- suffix matchers + switch rewrites + regex widen
// =============================================================================
function fixUnitsSuffixes() {
  const rel = "src/core/units.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: src, wasCRLF } = readNormalized(rel);
  let s = src;
  let changed = false;

  const sq = String.fromCharCode(0x00B2);
  const cu = String.fromCharCode(0x00B3);
  const dg = String.fromCharCode(0x00B0);

  // -------- B1: helpers --------
  if (s.indexOf("function matchAreaSuffix") < 0) {
    // Anchor on the parseDimension function declaration, whitespace-tolerant.
    const re = /(^|\n)(function parseDimension\(input: string, unit: string\): number \| null \{)/;
    const m = re.exec(s);
    if (m) {
      const helpers =
        "// " + FIX + ":units.ts -- suffix matchers for non-length kinds\n" +
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
      s = s.slice(0, m.index + m[1].length) + helpers + s.slice(m.index + m[1].length);
      changed = true;
    } else {
      log("WARN", rel + " (B1 parseDimension anchor not found)");
      dumpContext(s, "parseDimension", 3);
    }
  }

  // -------- B2: switch-case rewrites (regex, whitespace tolerant) --------
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
    if (c.re.test(s)) {
      s = s.replace(c.re, c.repl);
      changed = true;
    }
  }

  // -------- B3: widen the parse regex to accept superscript 2/3 --------
  //   Match any `cleaned.match(/^...$/);` inside parseDimension and inject
  //   the two superscript characters into its character class.
  const reLine = /cleaned\.match\(\/(-?\[[^\]]*\]\+)\s\*\(\[a-zA-Z([^\]\n]*)\]\)\?\$\//;
  const m3 = reLine.exec(s);
  if (m3 && m3[2].indexOf(sq) < 0) {
    const inner = m3[2] + sq + cu;
    s = s.replace(m3[0], m3[0].replace("[a-zA-Z" + m3[2] + "]", "[a-zA-Z" + inner + "]"));
    changed = true;
  }

  if (changed) {
    backup(rel);
    writeRestored(rel, s, wasCRLF);
    log("PATCH", rel, wasCRLF ? "(CRLF preserved)" : "(LF)");
  } else {
    log("NOOP", rel + " (nothing to do)");
  }
}

// =============================================================================
// E. clash/geometry.ts -- 1-based idRanges fallback with warning
// =============================================================================
function fixClashGeometryIdRanges() {
  const rel = "src/modules/clash/geometry.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: src, wasCRLF } = readNormalized(rel);
  if (src.indexOf(FIX + ":clash/geometry.ts") >= 0) { log("NOOP", rel + " (already patched)"); return; }

  // Whitespace-tolerant: capture indent, tolerate `??` or `||`.
  const re = /([ \t]*)const\s+range\s*=\s*ranges\.get\(localId\)\s*\?\?\s*ranges\.get\(localId\s*\+\s*1\);/;
  const m = re.exec(src);
  if (!m) {
    log("WARN", rel + " (idRanges anchor not found)");
    dumpContext(src, "ranges.get", 3);
    return;
  }
  const indent = m[1];
  const repl =
    indent + "let range = ranges.get(localId);\n" +
    indent + "if (!range) {\n" +
    indent + "  const alt = ranges.get(localId + 1);\n" +
    indent + "  if (alt) {\n" +
    indent + "    // " + FIX + ":clash/geometry.ts -- 1-based idRanges fallback\n" +
    indent + "    console.warn(\"[geometry] 1-based idRanges fallback for localId=\" + localId);\n" +
    indent + "    range = alt;\n" +
    indent + "  }\n" +
    indent + "}";
  const s = src.replace(m[0], repl);
  backup(rel); writeRestored(rel, s, wasCRLF); log("PATCH", rel, wasCRLF ? "(CRLF preserved)" : "(LF)");
}

// =============================================================================
// F. authoring.ts -- refreshGrips requires the wall-handles overlay to be live
// =============================================================================
function fixAuthoringGripGuard() {
  const rel = "src/features/authoring.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: src, wasCRLF } = readNormalized(rel);
  if (src.indexOf(FIX + ":authoring.ts") >= 0) { log("NOOP", rel + " (already patched)"); return; }

  // Find the `const skip = (window as any).__obsWallHandlesActive === true` block.
  const re = /const\s+skip\s*=\s*\(window as any\)\.__obsWallHandlesActive\s*===\s*true\s*\n\s*\?\s*new Set\(\[[^\]]+\]\)\s*\n\s*:\s*null;/;
  const m = re.exec(src);
  if (!m) {
    log("WARN", rel + " (refreshGrips guard anchor not found)");
    dumpContext(src, "__obsWallHandlesActive", 4);
    return;
  }
  // Extract indent from the matched block.
  const lineStart = src.lastIndexOf("\n", m.index) + 1;
  const indent = src.slice(lineStart, m.index + (m[0].match(/^\s*/) || [""])[0].length);
  const baseIndent = (m[0].match(/^\s*/) || [""])[0];
  const repl =
    baseIndent + "// " + FIX + ":authoring.ts -- require the wall-handles overlay to be live\n" +
    baseIndent + "const handlesActive = (window as any).__obsWallHandlesActive === true\n" +
    baseIndent + "  && !!document.getElementById(\"obs-wall-handles\")?.isConnected;\n" +
    baseIndent + "const skip = handlesActive\n" +
    baseIndent + "  ? new Set([\"wall\", \"beam\", \"duct\", \"pipe\", \"cable-tray\", \"conduit\", \"strip\", \"mline\"])\n" +
    baseIndent + "  : null;";
  const s = src.replace(m[0], repl);
  void indent;
  backup(rel); writeRestored(rel, s, wasCRLF); log("PATCH", rel, wasCRLF ? "(CRLF preserved)" : "(LF)");
}

// =============================================================================
// G. navigation.ts -- wheel authority check before raycast
// =============================================================================
function fixNavigationWheelOrder() {
  const rel = "src/features/navigation.ts";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: src, wasCRLF } = readNormalized(rel);
  if (src.indexOf(FIX + ":navigation.ts") >= 0) { log("NOOP", rel + " (already patched)"); return; }

  // Whitespace-tolerant: find the wheel block, reorder the two lines.
  const re = /([ \t]*)const\s+focus\s*=\s*pickWorldPointUnderCursor\(g\.event\.clientX,\s*g\.event\.clientY\);\n([ \t]*)if\s*\(\(window as any\)\.__OBS_WHEEL_AUTHORITY\)\s*return\s+false;\n([ \t]*)zoomAtCursor\(g\.event\.deltaY,\s*mods,\s*focus\);/;
  const m = re.exec(src);
  if (!m) {
    log("WARN", rel + " (wheel block anchor not found)");
    dumpContext(src, "__OBS_WHEEL_AUTHORITY", 4);
    return;
  }
  const i1 = m[1];
  const i2 = m[2];
  const i3 = m[3];
  const repl =
    i1 + "// " + FIX + ":navigation.ts -- check wheel authority before raycasting\n" +
    i1 + "if ((window as any).__OBS_WHEEL_AUTHORITY) return false;\n" +
    i2 + "const focus = pickWorldPointUnderCursor(g.event.clientX, g.event.clientY);\n" +
    i3 + "zoomAtCursor(g.event.deltaY, mods, focus);";
  const s = src.replace(m[0], repl);
  backup(rel); writeRestored(rel, s, wasCRLF); log("PATCH", rel, wasCRLF ? "(CRLF preserved)" : "(LF)");
}

// =============================================================================
// J. Collect-Project.ps1 -- UTF-8 read
// =============================================================================
function fixCollectorEncoding() {
  const rel = "Collect-Project.ps1";
  if (!exists(rel)) { log("SKIP", rel + " (missing)"); return; }
  const { text: src, wasCRLF } = readNormalized(rel);
  if (src.indexOf(FIX + ":collector-utf8") >= 0) { log("NOOP", rel + " (already utf8)"); return; }
  if (src.indexOf("ReadAllText($f.FullName") >= 0) { log("NOOP", rel + " (ReadAllText already present)"); return; }

  // Whitespace-tolerant anchor.
  const re = /([ \t]*)\$content\s*=\s*Get-Content\s+-LiteralPath\s+\$f\.FullName\s+-Raw\s+-ErrorAction\s+Stop/;
  const m = re.exec(src);
  if (!m) {
    log("WARN", rel + " (Get-Content anchor not found)");
    dumpContext(src, "Get-Content", 3);
    return;
  }
  const indent = m[1];
  const repl =
    indent + "# " + FIX + ":collector-utf8 -- read as UTF-8 so the bundle is not mojibake\n" +
    indent + "$content = [System.IO.File]::ReadAllText($f.FullName, (New-Object System.Text.UTF8Encoding($false)))";
  const s = src.replace(m[0], repl);
  backup(rel); writeRestored(rel, s, wasCRLF); log("PATCH", rel, wasCRLF ? "(CRLF preserved)" : "(LF)");
}

// =============================================================================
// Run
// =============================================================================
console.log("");
console.log("Repair pass for Open BIM Studio code review fix pack...");
console.log("");
fixNativeTwinIfc();
fixUnitsSuffixes();
fixClashGeometryIdRanges();
fixAuthoringGripGuard();
fixNavigationWheelOrder();
fixCollectorEncoding();
console.log("");
console.log("Files scanned: " + (stats.crlf + stats.lf) +
            "  (CRLF: " + stats.crlf + "  LF: " + stats.lf + ")");
console.log("Summary: " + stats.patched + " patched, " + stats.noop + " no-op, " +
            stats.skipped + " skipped, " + stats.warned + " warned.");
console.log("");
if (stats.warned > 0) {
  console.log("WARN lines above print the surrounding 8 lines so you can copy them back");
  console.log("verbatim and I can produce exact anchors on the next pass.");
  console.log("");
}