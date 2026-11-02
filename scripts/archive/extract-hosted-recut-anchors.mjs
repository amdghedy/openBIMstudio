import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || process.cwd();

function full(rel) { return path.join(root, rel); }
function exists(rel) { try { fs.accessSync(full(rel)); return true; } catch { return false; } }
function read(rel) { try { return fs.readFileSync(full(rel), "utf8"); } catch { return null; } }

let printed = 0;
const CAP = 700;
function out(s) {
  if (printed >= CAP) return;
  const lines = String(s).split("\n");
  printed += lines.length;
  console.log(s);
}
function truncNote() {
  if (printed >= CAP) console.log("\n... [output capped at " + CAP + " lines; re-run with a larger CAP if needed] ...");
}

function toLines(src) { return src.split(/\r?\n/); }

// Return windows of +/- radius lines around every match of re, deduped by overlap.
function windows(src, re, radius) {
  const lines = toLines(src);
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) marks.push(i);
  }
  const ranges = [];
  for (const m of marks) {
    const a = Math.max(0, m - radius);
    const b = Math.min(lines.length - 1, m + radius);
    if (ranges.length && a <= ranges[ranges.length - 1].b + 1) {
      ranges[ranges.length - 1].b = Math.max(ranges[ranges.length - 1].b, b);
      ranges[ranges.length - 1].hits.push(m);
    } else {
      ranges.push({ a, b, hits: [m] });
    }
  }
  return ranges.map((r) => ({
    start: r.a + 1,
    end: r.b + 1,
    hits: r.hits.map((h) => h + 1),
    text: lines.slice(r.a, r.b + 1).map((l, k) => String(r.a + k + 1).padStart(5, " ") + "| " + l).join("\n"),
  }));
}

function printWindows(title, wins, max) {
  out("\n============================== " + title + " ==============================");
  if (!wins.length) { out("  (no matches)"); return; }
  const show = wins.slice(0, max);
  for (const w of show) {
    out("  --- lines " + w.start + "-" + w.end + "  (anchor hit(s) at line " + w.hits.join(", ") + ") ---");
    out(w.text);
    out("");
  }
  if (wins.length > max) out("  ... +" + (wins.length - max) + " more window(s) suppressed ...");
}

const GEOM_TOKENS = /new THREE\.Shape|\.holes|ExtrudeGeometry|BufferGeometry|setAttribute\(\s*["']position|Float32Array|makeGeometry|buildGeometry|toGeometry|extrude|lathe|revolve/i;
const OPEN_TOKEN = /openings/i;

// ---------------------------------------------------------------------------
// 1. authoring.ts : wall/beam geometry builder + openings consumption + move rebuild
// ---------------------------------------------------------------------------
const authRel = "src/features/authoring.ts";
const auth = read(authRel);

let geomHonorsOpenings = "unknown";
let geomEvidence = "";
let rebuildOnMove = "unknown";
let rebuildEvidence = "";

if (auth) {
  out("\n>>> Reading " + authRel + "  (" + auth.length + " bytes, " + toLines(auth).length + " lines)");

  // A) Where are openings referenced at all?
  const openWins = windows(auth, OPEN_TOKEN, 6);
  printWindows("AUTHORING :: openings references", openWins, 6);

  // B) Wall/beam geometry builder anchors
  const builderRe = /function\s+\w*(?:[Ww]all|[Bb]eam|[Ss]trip|[Mm]line|[Ee]lement|[Mm]esh|[Gg]eometry|rebuild)\w*\s*\(|(?:const|let|var)\s+\w*(?:[Ww]allGeom|buildWall|makeWall|wallGeometry|elementToMesh|buildElement|rebuildAuthored)\b|rebuildAuthored\s*[=:(]|markAuthoringDirty\s*[=:(]/;
  const builderWins = windows(auth, builderRe, 14);
  printWindows("AUTHORING :: geometry / rebuild builder anchors", builderWins, 8);

  // Verdict A: does any openings-window ALSO contain a geometry token?
  for (const w of openWins) {
    if (GEOM_TOKENS.test(w.text)) {
      geomHonorsOpenings = "YES";
      geomEvidence = "openings window at lines " + w.start + "-" + w.end + " contains a geometry-construction token";
      break;
    }
  }
  if (geomHonorsOpenings === "unknown") {
    // Maybe openings are read in a builder window instead
    for (const w of builderWins) {
      if (OPEN_TOKEN.test(w.text) && GEOM_TOKENS.test(w.text)) {
        geomHonorsOpenings = "YES";
        geomEvidence = "builder window at lines " + w.start + "-" + w.end + " references openings AND geometry";
        break;
      }
    }
  }
  if (geomHonorsOpenings === "unknown") {
    geomHonorsOpenings = "NO / NOT-VISIBLE";
    geomEvidence = "no window couples an openings reference with geometry construction (builder may ignore params.openings, or uses a token outside the scan set)";
  }

  // C) Move/copy/rotate op pipeline -> does it trigger a rebuild?
  const moveRe = /move-copy|PendingOp|applyMove|commitOp|setElementParams|updateElement|onElementsChanged|authoring-changed/;
  const moveWins = windows(auth, moveRe, 10);
  printWindows("AUTHORING :: move / op pipeline anchors", moveWins, 6);

  for (const w of moveWins) {
    if (/rebuildAuthored|markAuthoringDirty|authoring-changed|notifyAuthoringChange/.test(w.text)) {
      rebuildOnMove = "YES";
      rebuildEvidence = "op window at lines " + w.start + "-" + w.end + " triggers a rebuild/dirty/notify";
      break;
    }
  }
  if (rebuildOnMove === "unknown") {
    rebuildOnMove = "NOT-VISIBLE";
    rebuildEvidence = "no op window in the scanned set calls rebuildAuthored/markAuthoringDirty/notify (rebuild may be centralized elsewhere)";
  }
} else {
  out("\n!!! " + authRel + " NOT FOUND");
}

// ---------------------------------------------------------------------------
// 2. Cross-tree : is there an authored -> IFC export path at all?
// ---------------------------------------------------------------------------
out("\n>>> Scanning src/ for an authored->IFC export path ...");

const IFC_RE = /IfcWall|IfcBeam|IfcOpeningElement|IfcRelVoidsElement|IfcRelAggregates|exportIFC|writeIFC|toIFC|IFC2X3|IFC4|IFC4X3|ifcSerializer|serializeIFC|buildIFC|createIfc/i;
const ifcHits = [];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "public"]);

function walk(dir, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), acc);
    } else if (e.isFile() && /\.(ts|tsx|mts|js|mjs)$/.test(e.name)) {
      acc.push(path.relative(root, path.join(dir, e.name)).replace(/\\/g, "/"));
    }
  }
}
const files = [];
walk(path.join(root, "src"), files);

for (const rel of files) {
  if (rel === authRel) continue; // authoring.ts already inspected above
  const t = read(rel);
  if (!t) continue;
  if (IFC_RE.test(t)) {
    const wins = windows(t, IFC_RE, 4);
    ifcHits.push({ rel, count: wins.length, first: wins[0] });
  }
}

out("\n============================== IFC EXPORT CANDIDATES ==============================");
if (!ifcHits.length) {
  out("  NONE FOUND in src/ (excluding authoring.ts).");
  out("  => An authored->IFC void export likely does NOT exist yet; emitting IfcOpeningElement");
  out("     would be a NEW subsystem, not a small patch. Scope decision needed (see plan).");
} else {
  for (const h of ifcHits.slice(0, 12)) {
    out("  FILE: " + h.rel + "   (" + h.count + " ifc-token window(s))");
    if (h.first) out(h.first.text);
    out("");
  }
  if (ifcHits.length > 12) out("  ... +" + (ifcHits.length - 12) + " more candidate file(s) suppressed ...");
}

// Also check authoring.ts itself for ifc tokens (maybe export lives there)
let authIfc = false;
if (auth) {
  const aw = windows(auth, IFC_RE, 4);
  if (aw.length) {
    authIfc = true;
    printWindows("AUTHORING :: ifc tokens inside authoring.ts", aw, 4);
  }
}

// ---------------------------------------------------------------------------
// 3. Project persistence : are openings saved/restored with the project JSON?
// ---------------------------------------------------------------------------
out("\n>>> Checking project persistence for openings round-trip ...");
const projRel = "src/modules/projects/projects.ts";
const proj = read(projRel);
if (proj) {
  const pw = windows(proj, /openings|serializeElement|elementToDoc|doc\.elements|params/i, 3);
  // We only need to know whether params (and thus params.openings) are persisted wholesale.
  const persistsWholeParams = /JSON\.stringify|spread|\.\.\.(?:el|element|e)\b|params:\s*\{?\s*\.\.\.|serialize/i.test(proj);
  out("  projects.ts present (" + proj.length + " bytes).");
  out("  Heuristic: persists whole element/params? " + (persistsWholeParams ? "LIKELY YES (openings ride along)" : "UNCERTAIN (verify serialize path)"));
  printWindows("PROJECTS :: serialize/params anchors (sample)", pw.slice(0, 3), 3);
} else {
  out("  " + projRel + " NOT FOUND");
}

// ---------------------------------------------------------------------------
// VERDICT + PATCH PLAN
// ---------------------------------------------------------------------------
out("");
out("############################## VERDICT ##############################");
out("GEOMETRY_HONORS_OPENINGS : " + geomHonorsOpenings);
out("  evidence: " + geomEvidence);
out("REBUILD_ON_MOVE          : " + rebuildOnMove);
out("  evidence: " + rebuildEvidence);
out("IFC_EXPORT_PATH          : " + (ifcHits.length || authIfc ? "FOUND (see candidates above)" : "NONE-FOUND (new subsystem required)"));
out("PROJECT_OPENINGS_PERSIST : see heuristic above");
out("");
out("############################## DERIVED PATCH PLAN ##############################");
if (geomHonorsOpenings === "YES") {
  out("  [SMALL PATH] The wall builder already cuts params.openings.");
  out("   -> Sub-patch 1: guarantee rebuild fires on wall move (wire REBUILD_ON_MOVE if NOT-VISIBLE).");
  out("   -> Sub-patch 2: ensure hosted-openings.ts recompute runs AFTER the move commits (not before).");
  out("   -> Sub-patch 3 (only if IFC_FOUND): emit IfcOpeningElement + IfcRelVoidsElement for hosted elems.");
  out("   -> Add 3-4 regression-guard checks: openings-loop feeds geometry; rebuild-on-move wired; ifc void present.");
} else {
  out("  [LARGE PATH] The wall builder does NOT visibly consume params.openings for geometry.");
  out("   -> Sub-patch 1: extend the wall/beam geometry builder to subtract opening volumes");
  out("        (THREE.Shape + .holes + ExtrudeGeometry, OR segment-between-openings loft).");
  out("        THIS TOUCHES THE PARAMETRIC HEART -> must be anchored to the EXACT builder function");
  out("        printed above, applied as a narrow, reviewed diff, never a blind regex.");
  out("   -> Sub-patch 2: wire rebuild-on-move (REBUILD_ON_MOVE).");
  out("   -> Sub-patch 3: IFC void export IF a path exists; otherwise DEFER (scope note).");
  out("   -> Add regression-guard checks for the new geometry contract.");
}
out("");
out("NEXT: paste this ENTIRE output back. I will then emit the feature patch");
out("tailored to the real anchors above (no guessing), in the same Node-backed,");
out("idempotent, ASCII, PS-5.1-safe style, and extend scripts/verify-input-focus.mjs");
out("with the new hosted re-cut checks so the guard keeps protecting it.");
out("");
truncNote();