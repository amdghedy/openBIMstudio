/**
 * verify-v71.mjs — v0.71 Group 1 Modify milestone checks.
 *
 * Asserts the Group 1 behavioral specification landed with the
 * expected shape:
 *   - docs/MODIFY_GROUP1_SPEC_V71.md (spec-first discipline, registers)
 *   - src/modules/selection/index.ts    (Selection engine, spec §2)
 *   - src/modules/references/index.ts   (Reference service, spec §3)
 *   - src/modules/modify/group1.ts      (Move/Rotate/Mirror catalogs, §4–§6)
 *   - required function catalogs per spec (exact names)
 *   - UI wiring: engine-ui dialogs + ribbon buttons + registers
 *   - tests/v71-modify-group1.test.cjs + CI wiring
 *
 * Run: `node scripts/verify-v71.mjs`
 * Exit code: 0 = pass, 1 = fail.
 */

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function check(label, file, regex) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { console.error(`  ✗ ${label}: file missing (${file})`); return false; }
  const content = fs.readFileSync(full, "utf8");
  if (!regex.test(content)) { console.error(`  ✗ ${label}: pattern not found in ${file}`); return false; }
  console.log(`  ✓ ${label}`); return true;
}

let pass = 0, fail = 0;
const track = (ok) => { ok ? pass++ : fail++; };

console.log("== scripts/verify-v71.mjs — Group 1 Modify milestone (v0.71)\n");

// ── Spec-first discipline ───────────────────────────────────────────────
track(check("spec doc exists with adaptation decisions", "docs/MODIFY_GROUP1_SPEC_V71.md", /ADAPTATION DECISIONS/));
track(check("spec pins internal units + tolerances (A3)", "docs/MODIFY_GROUP1_SPEC_V71.md", /Internal length unit: \*\*metre\*\*/));
track(check("spec defines diagnostic convention (A4)", "docs/MODIFY_GROUP1_SPEC_V71.md", /MOD-<CMD>-<NNN>/));
track(check("spec maps the C# interface to the existing TS contract (A1)", "docs/MODIFY_GROUP1_SPEC_V71.md", /existing `IModifyCommand` in `src\/modules\/modify\/command.ts`/));
track(check("spec continues the registers (A5)", "docs/MODIFY_GROUP1_SPEC_V71.md", /start at \*\*A-10\*\*.*D-13/s));
track(check("clean-room clause present (A6)", "docs/MODIFY_GROUP1_SPEC_V71.md", /No decompilation of Autodesk assemblies/));
track(check("performance budgets pinned (A7)", "docs/MODIFY_GROUP1_SPEC_V71.md", /10 000 elements ≤ 50 ms/));
track(check("coverage matrix marks unsupported explicitly", "docs/MODIFY_GROUP1_SPEC_V71.md", /unsupported in Group 1/));
track(check("evidence register classifies honestly (E5)", "docs/MODIFY_GROUP1_SPEC_V71.md", /E-M1-01/));
track(check("deviation register continued D-13..D-16", "docs/MODIFY_GROUP1_SPEC_V71.md", /D-16/));

// ── Selection engine (spec §2) ──────────────────────────────────────────
track(check("hit priority table vertex>edge>connector>datum>body", "src/modules/selection/index.ts", /vertex: 100,\s*\n\s*edge: 90,\s*\n\s*connector: 70,\s*\n\s*datum: 60,\s*\n\s*body: 40/s));
track(check("window inside vs crossing semantics", "src/modules/selection/index.ts", /SelectWindow\(a: \[number, number\], b: \[number, number\], mode: "inside" \| "crossing"\)/));
track(check("hidden default-invisible + force-select warning", "src/modules/selection/index.ts", /MOD-SEL-005/));
track(check("pinned selectable, edits blocked upstream", "src/modules/selection/index.ts", /MOD-SEL-002/));
track(check("hosted/connected/dependent/related expansion", "src/modules/selection/index.ts", /ExpandHosted[\s\S]*ExpandConnected[\s\S]*ExpandDependents[\s\S]*ExpandRelated/));
track(check("filter applies to every selection path", "src/modules/selection/index.ts", /visibility\/eligibility filter applies to EVERY selection path/));

// ── Reference service (spec §3) ─────────────────────────────────────────
track(check("all 12 reference kinds", "src/modules/references/index.ts", /"face"[\s\S]*"edge"[\s\S]*"vertex"[\s\S]*"centerline"[\s\S]*"location-line"[\s\S]*"reference-plane"[\s\S]*"grid"[\s\S]*"level"[\s\S]*"work-plane"[\s\S]*"connector"[\s\S]*"analytical-axis"[\s\S]*"host-surface"/));
track(check("acquired refs are non-persistent (spec §3.2)", "src/modules/references/index.ts", /persistent: false/));
track(check("stale on owner geometry change", "src/modules/references/index.ts", /MarkGeometryChanged/));
track(check("broken on owner deletion", "src/modules/references/index.ts", /MarkOwnerDeleted/));
track(check("command eligibility map", "src/modules/references/index.ts", /REFERENCE_ELIGIBILITY/));
track(check("orthonormal frame construction", "src/modules/references/index.ts", /orthonormalFrame/));

// ── Move catalog (spec §4) ──────────────────────────────────────────────
for (const fn of ["BeginMove", "AcquireMoveBasePoint", "ResolveMoveTarget", "CalculateMoveVector",
  "GenerateMovePreview", "EvaluateMoveDependencies", "ValidateMove", "CommitMove", "CancelMove", "UndoMove", "RedoMove"]) {
  track(check(`Move catalog: ${fn}`, "src/modules/modify/group1.ts", new RegExp(`${fn}\\(`)));
}
track(check("axis-constrained projection Δ'=(Δ·â)â", "src/modules/modify/group1.ts", /if \(opts\?\.axis === "x"\) dy = 0;/));
track(check("hosted rigid follow + MOD-MOV-011", "src/modules/modify/group1.ts", /MOD-MOV-011/));
track(check("locked alignment blocks move MOD-MOV-010", "src/modules/modify/group1.ts", /MOD-MOV-010/));
track(check("undo without txn reported MOD-MOV-020", "src/modules/modify/group1.ts", /MOD-MOV-020/));

// ── Rotate catalog (spec §5) ────────────────────────────────────────────
for (const fn of ["BeginRotate", "AcquireRotationAxis", "AcquireRotationPivot", "ResolveRotationAngle",
  "GenerateRotationPreview", "ValidateRotation", "UpdateDependentOrientations", "CommitRotation", "CancelRotation"]) {
  track(check(`Rotate catalog: ${fn}`, "src/modules/modify/group1.ts", new RegExp(`${fn}\\(`)));
}
track(check("angular snap θ'=round(θ/s)·s", "src/modules/modify/group1.ts", /Math\.round\(theta \/ opts\.snapStep\) \* opts\.snapStep/));
track(check("zero-angle no-op rejection MOD-ROT-021", "src/modules/modify/group1.ts", /MOD-ROT-021/));
track(check("out-of-plane axis rejected MOD-ROT-022 (D-16)", "src/modules/modify/group1.ts", /MOD-ROT-022/));
track(check("pivot-coincident invariance MOD-ROT-020", "src/modules/modify/group1.ts", /MOD-ROT-020/));

// ── Mirror catalog (spec §6) ────────────────────────────────────────────
for (const fn of ["BeginMirror", "AcquireMirrorPlane", "CalculateMirrorTransform", "GenerateMirrorPreview",
  "ResolveMirroredOrientation", "CloneRelationships", "ValidateMirror", "CommitMirror"]) {
  track(check(`Mirror catalog: ${fn}`, "src/modules/modify/group1.ts", new RegExp(`${fn}\\(`)));
}
track(check("reflection matrix M = 2ddᵀ − I (m11 has the −1)", "src/modules/modify/group1.ts", /const m11 = 2 \* d\[1\] \* d\[1\] - 1;/));
track(check("orientation mapping θ' = 2φ − θ", "src/modules/modify/group1.ts", /2 \* phi - theta/));
track(check("hand/facing flip", "src/modules/modify/group1.ts", /params\.hand = params\.hand === 0 \? 1 : 0/));
track(check("temporary-snap records never cloned", "src/modules/modify/group1.ts", /rec\.type === "temporary-snap"\) continue/));
track(check("host-not-mirrored detach warning MOD-MIR-010", "src/modules/modify/group1.ts", /MOD-MIR-010/));
track(check("transaction double-apply guard", "src/modules/modify/group1.ts", /initial forward apply already performed by the tool/));

// ── Global exposure + UI wiring ─────────────────────────────────────────
track(check("__obsModify exposes Group 1 tools", "src/modules/v68-register.ts", /MoveTool, RotateTool, MirrorTool/));
track(check("__obsSelection registered", "src/modules/v68-register.ts", /w\.__obsSelection = selectionApi/));
track(check("__obsReferences registered", "src/modules/v68-register.ts", /w\.__obsReferences = referencesApi/));
track(check("engine-ui Move/Rotate/Mirror/Selection/Reference dialogs", "src/features/engine-ui.ts", /openGroup1MoveDialog[\s\S]*openGroup1RotateDialog[\s\S]*openGroup1MirrorDialog[\s\S]*openSelectionInspectorDialog[\s\S]*openReferencePickerDialog/s));
track(check("engine-ui persistent transaction + undo/redo exports", "src/features/engine-ui.ts", /export function group1Undo[\s\S]*export function group1Redo/s));
track(check("store adapter implements remove (undo of copies)", "src/features/engine-ui.ts", /remove: \(id: string\): boolean/));
track(check("ribbon Group 1 buttons", "src/shell/ribbon.ts", /Group 1 Tools \(v71\)[\s\S]*Move\+[\s\S]*Rotate\+[\s\S]*Mirror\+[\s\S]*Undo G1[\s\S]*Redo G1[\s\S]*Sel Inspector[\s\S]*Ref Picker/s));

// ── Tests + CI ──────────────────────────────────────────────────────────
track(check("closed-form test suite exists", "tests/v71-modify-group1.test.cjs", /mirror: reflection across y=x/));
track(check("performance budget test (spec §13.25)", "tests/v71-modify-group1.test.cjs", /hit-test over 10k elements/));
track(check("CI runs test:v71", ".github/workflows/unit-tests.yml", /test:v71/));
track(check("CI runs verify:v71", ".github/workflows/unit-tests.yml", /verify:v71/));
track(check("package version 0.71.0", "package.json", /"version": "0\.71\.0"/));

console.log(`\n${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
