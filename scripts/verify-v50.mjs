import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { fileURLToPath as __fileURLToPath } from 'node:url';
const root = path.resolve(__fileURLToPath(new URL('..', import.meta.url)));
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
  ['release version', 'package.json', /"version":\s*"(?:0\.(?:5[4-9]|[6-9]\d|\d{3,})|[1-9]\d*)\./],
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
console.log(`VERIFY_V50_BASELINE checks=${checks.length} failures=${failed}`);
