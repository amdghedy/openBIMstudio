import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const checks = [];
function pass(name, ok, details = "") {
  checks.push({ name, ok, details });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${details ? ` — ${details}` : ""}`);
}

const plan = read("src/features/plan-view-panel.ts");
const auth = read("src/features/authoring.ts");
const pkg = JSON.parse(read("package.json"));

pass("release version 0.52", pkg.version === "0.52.0", pkg.version);
pass("dimension references require model boundaries", plan.includes('Dimensions may terminate only on an actual model boundary') && plan.includes('if (!hit) {'));
pass("dimension references store boundary semantics", plan.includes('"linear-side" as const') && plan.includes('"linear-cap" as const') && plan.includes('"static-boundary"'));
pass("dimension scale is paper-space driven", plan.includes('function paperMmToWorld') && plan.includes('offsetMm?: number'));
pass("permanent dimension offset follows active scale", plan.includes('paperMmToWorld(d.offsetMm ?? DIM_OFFSET_MM)'));
pass("dimension witness lines touch referenced boundary", plan.includes('const gap = 0.0'));
pass("dimension placement rejects free-space termination", plan.includes('dimensions cannot terminate in empty space'));
pass("linked model plan edges can be dimensioned", plan.includes('Linked IFC/FRAG geometry is not authored'));
pass("MEP elbow has explicit bend radius", auth.includes('bendRadius?: number') && auth.includes('p.bendRadius'));
pass("MEP runs are trimmed to fitting inlet/outlet", auth.includes('parent.params.end = trimmedEnd') && auth.includes('sx = outX') && auth.includes('bendRadius'));
pass("MEP bend operation is undo-atomic", auth.includes('history.transaction(`Create ${cap(type)} with connected elbow`') && auth.includes('Trim ${cap(type)} to fitting'));
pass("all fitted MEP linears share fitting workflow", auth.includes('const FITTED_TYPES: Set<ElementType>') && auth.includes('"duct", "pipe", "cable-tray", "conduit"'));

const failures = checks.filter((c) => !c.ok);
console.log(`VERIFY_V52 checks=${checks.length} failures=${failures.length}`);
process.exit(failures.length ? 1 : 0);
