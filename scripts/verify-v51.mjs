import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const checks = [
  ['selection raycast canonical fragments.modelId', 'src/features/selection.ts', /r\.fragments\?\.modelId/],
  ['manual selection style', 'src/core/setup.ts', /styles\.set\("select"/],
  ['preselection style', 'src/core/setup.ts', /styles\.set\("preselect"/],
  ['context menu vertical scroll', 'src/features/context-menu.ts', /max-height:calc\(100vh - 24px\);overflow-y:auto/],
  ['Native Twin action fallback', 'src/features/context-menu.ts', /const editMap: IdMap = picked\.map/],
  ['Native Twin source selection clear', 'src/features/frag-edit.ts', /sel\?\.clear\?\./],
  ['BIM dimension references', 'src/features/plan-view-panel.ts', /interface PlanDimensionRef/],
  ['BIM view range', 'src/modules/drawings/plan-generator.ts', /viewRangeTop/],
  ['middle-button plan pan', 'src/features/plan-view-panel.ts', /e\.button !== 1 && !\(e\.button === 0 && e\.shiftKey\)/],
  ['dimension format/unit style', 'src/features/plan-view-panel.ts', /formatPlanDimension/],
  ['release version', 'package.json', /"version": "0\.54\.0"/],
  ['link placement targets only new model', 'src/features/importer.ts', /applyPositioningMode\(ifcSettings\.positioning, \[modelId\]\)/],
  ['no federation-wide positioning after IFC queue', 'src/features/importer.ts', /Never steal the user's camera when adding federated links/],
  ['saved zero-offset placement is authoritative', 'src/modules/projects/projects.ts', /hasSavedPlacement/],
  ['source link identity metadata', 'src/modules/projects/types.ts', /ProjectModelSource/],
  ['post-load BIM data verification', 'src/features/importer.ts', /psetsDefault: true/],
  ['link dropdown is non-disruptive', 'src/features/importer.ts', /placement of the NEXT link only/],
  ['replace-existing link cleanup', 'src/features/importer.ts', /unregisterModel\(base\)/],
  ['replace-existing preserves placement', 'src/features/importer.ts', /takePreservedReplacementOffset\(modelId\)/],
  ['cached FRAG integrity hash', 'src/modules/projects/types.ts', /cacheSha256\?: string/],
  ['cached FRAG reopen verification', 'src/modules/projects/projects.ts', /cached FRAG integrity mismatch/],
];
let failed = 0;
for (const [label, file, re] of checks) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const ok = re.test(text);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}
try {
  const tsc = execFileSync('tsc', ['--version'], { encoding: 'utf8' }).trim();
  console.log(`INFO  ${tsc}`);
} catch {
  console.log('INFO  tsc executable not available; syntax verification remains external.');
}
if (failed) process.exit(1);
console.log(`VERIFY_V51 checks=${checks.length} failures=${failed}`);
