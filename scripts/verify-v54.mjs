import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const checks = [
  ['3D Ctrl+LeftClick remains multi-select', read('src/features/selection.ts').includes('Ctrl+LeftClick is multi-selection')],
  ['2D Ctrl+LeftClick selection set exists', read('src/features/plan-view-panel.ts').includes('const planSelectedIds = new Set<string>()')],
  ['1:100 plan scale persists and rerenders', /obs\.revit\.plan-scale\.v1[\s\S]*planViewScale/.test(read('src/features/plan-view-panel.ts'))],
  ['Pure cardinal camera command exists', read('src/features/camera-tools.ts').includes('export function gotoExactView')],
  ['Cube face uses exact cardinal camera commands', read('src/features/viewcube.ts').includes('gotoExactView("top")') && read('src/features/viewcube.ts').includes('gotoExactView("front")')],
  ['Dockable controls expose minimize/dock/close', read('src/features/dockable.ts').includes('makeControl("×"') && read('src/features/dockable.ts').includes('cycleDock()') && read('src/features/dockable.ts').includes('minimize(): void')],
  ['Native project geometry is persisted', read('src/modules/projects/types.ts').includes('nativeGeometry?: { positions: number[] }') && read('src/features/authoring.ts').includes('addNativeGeometryElement')],
  ['Native Twin stores IFC semantic identity', read('src/features/frag-edit.ts').includes('nativeElementId') && read('src/features/frag-edit.ts').includes('addNativeGeometryElement')],
  ['Native Twin transform sync avoids full rebuild on every frame', read('src/features/authoring.ts').includes('rebuildScene = false') && read('src/features/frag-edit.ts').includes('updateNativeGeometryElement')],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
process.exitCode = failed ? 1 : 0;
