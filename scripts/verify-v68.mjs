/**
 * verify-v68.mjs — v0.68 milestone checks (authoring core package).
 *
 * Asserts the MASTER PROMPT authoring engines landed with the expected
 * shape:
 *   - src/modules/dependency-graph  (Module 1.1–1.3)
 *   - src/modules/parameter-engine  (Module 1.6 / 2.3)
 *   - src/modules/object-hierarchy  (Module 2.1–2.2)
 *   - src/modules/solid-kernel      (Module 2.7–2.9, 2.12)
 *   - src/modules/hosting           (Module 1.5)
 *   - src/modules/snapping          (Module 2B.1–2B.4)
 *   - src/modules/relationships     (Module 2B.5–2B.6)
 *   - src/modules/mep/connectors.ts (Module 2B.7)
 *   - src/modules/modify            (Module 2C)
 *   - src/modules/properties-panel  (Module 2D: schema/lifecycle/dimensions)
 *   - tests: v68-engine-core, v68-solid-hosting, v68-authoring-interaction, v68-acceptance
 *   - Boot wiring via v68-register + critical-gaps-boot
 *
 * Run: `node scripts/verify-v68.mjs`
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

console.log("\n=== verify-v68 — authoring core milestone ===\n");

console.log("version + scripts:");
track(check("version 0.68", "package.json", /"version":\s*"0\.68\./));
track(check("test:v68-core script", "package.json", /test:v68-core/));
track(check("test:v68-solids script", "package.json", /test:v68-solids/));
track(check("test:v68-interaction script", "package.json", /test:v68-interaction/));
track(check("test:v68-acceptance script", "package.json", /test:v68-acceptance/));
track(check("verify:v68 script", "package.json", /verify:v68/));

console.log("\nModule 1 — parametric relationship engine:");
track(check("dependency graph functions", "src/modules/dependency-graph/index.ts", /addNode[\s\S]*addDependency[\s\S]*detectCycles[\s\S]*topologicalSort[\s\S]*recompute/));
track(check("Tarjan SCC cycle classification", "src/modules/dependency-graph/index.ts", /classifyCycle/));
track(check("simultaneous-constraint-system recognized", "src/modules/dependency-graph/index.ts", /simultaneous-constraint-system/));
track(check("parameter engine EffectiveValue", "src/modules/parameter-engine/index.ts", /effectiveValue/));
track(check("unit conversion", "src/modules/parameter-engine/index.ts", /convertUnits/));
track(check("circular reference detection", "src/modules/parameter-engine/index.ts", /detectCircularReferences/));

console.log("\nModule 2 — hierarchy + solids:");
track(check("BimRegistry identity", "src/modules/object-hierarchy/index.ts", /class IdentityService/));
track(check("duplication semantics", "src/modules/object-hierarchy/index.ts", /duplicate\(/));
track(check("B-Rep topology", "src/modules/solid-kernel/brep.ts", /buildEdges/));
track(check("extrude/revolve/sweep/blend", "src/modules/solid-kernel/forms.ts", /export function extrude[\s\S]*export function revolve[\s\S]*export function sweep[\s\S]*export function blend/));
track(check("convex-clipping booleans", "src/modules/solid-kernel/csg.ts", /splitAgainstConvex/));
track(check("void cutting with AABB tree", "src/modules/solid-kernel/voids.ts", /class AabbTree/));
track(check("validation diagnostics", "src/modules/solid-kernel/validate.ts", /commitEligible/));

console.log("\nModule 2B — snapping + relationships + MEP:");
track(check("modeling state machine", "src/modules/snapping/state-machine.ts", /beginModelingCommand[\s\S]*commitModelingCommand[\s\S]*cancelModelingCommand/));
track(check("snap ranking + hysteresis", "src/modules/snapping/engine.ts", /resolveSnapAmbiguity/));
track(check("wall-column connection", "src/modules/snapping/wall-column.ts", /calculateWallEndpoint/));
track(check("alignment residuals", "src/modules/snapping/alignment.ts", /computeAlignmentResidual/));
track(check("relationship registry", "src/modules/relationships/index.ts", /evaluateRelationshipAfterGeometryChange/));
track(check("reconnection policies", "src/modules/relationships/index.ts", /defaultPolicyFor/));
track(check("MEP connector compatibility", "src/modules/mep/connectors.ts", /evaluateConnectorCompatibility/));
track(check("MEP topology validation", "src/modules/mep/connectors.ts", /validateMepNetworkTopology/));

console.log("\nModule 2C — modify engine:");
track(check("IModifyCommand contract", "src/modules/modify/command.ts", /CanExecute[\s\S]*UpdatePreview[\s\S]*Validate[\s\S]*Commit[\s\S]*Cancel/));
track(check("Rodrigues rotation", "src/modules/modify/transform.ts", /rotateAboutAxis/));
track(check("offset + trim/extend + split", "src/modules/modify/edit.ts", /offsetPolyline[\s\S]*trimExtendSegment[\s\S]*class SplitCommand/));
track(check("copy/array/mirror", "src/modules/modify/duplicate.ts", /class CopyCommand[\s\S]*class ArrayLinearCommand[\s\S]*class MirrorCommand/));

console.log("\nModule 2D — property panel engine:");
track(check("21-field definitions", "src/modules/properties-panel/schema.ts", /sharedParameterId/));
track(check("13+ category schemas", "src/modules/properties-panel/schema.ts", /coveredCategories/));
track(check("editing lifecycle", "src/modules/properties-panel/lifecycle.ts", /BuildPropertyChangeSet[\s\S]*PreviewPropertyChange[\s\S]*CommitPropertyChange/));
track(check("editable dimensions", "src/modules/properties-panel/dimensions.ts", /ResolveDimensionEdit[\s\S]*CommitDimensionEdit/));

console.log("\nModule 1.5 — hosting:");
track(check("host parameterization", "src/modules/hosting/index.ts", /evaluateHost/));
track(check("opening placement + overlaps", "src/modules/hosting/index.ts", /placeOpening[\s\S]*findOverlappingOpenings/));
track(check("host-change propagation", "src/modules/hosting/index.ts", /evaluateHostedOpeningsAfterHostChange/));

console.log("\nModule 2E — acceptance tests:");
track(check("engine-core suite", "tests/v68-engine-core.test.cjs", /dependency graph|EffectiveValue/i));
track(check("solid+hosting suite", "tests/v68-solid-hosting.test.cjs", /cutVoids|AabbTree/i));
track(check("interaction suite", "tests/v68-authoring-interaction.test.cjs", /state machine|relationships/i));
track(check("acceptance suite", "tests/v68-acceptance.test.cjs", /2E\.1|2E\.10/i));

console.log("\nBoot wiring:");
track(check("v68-register module", "src/modules/v68-register.ts", /setupV68Engines/));
track(check("boot integration", "src/critical-gaps-boot.ts", /v68-register/));

console.log(`\n=== verify-v68: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
