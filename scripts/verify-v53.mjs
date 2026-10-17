import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
let files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(p);
  }
}
walk(path.join(root, 'src'));

const fragEdit = fs.readFileSync(path.join(root, 'src/features/frag-edit.ts'), 'utf8');
const checks = [
  ['getItemsGeometry primary path', /getItemsGeometry/],
  ['localId passed to getItemsGeometry', /getter\.call\(model, \[localId\]\)/],
  ['indexed geometry support', /if \(indices && indices\.length >= 3\)/],
  ['non-indexed geometry support', /for \(let i = 0; i \+ 2 < vertexCount; i \+= 3\)/],
  ['renderer fallback retained', /getElementTrianglesExact\(model\.object, localId\)/],
  ['source metadata retained', /getItemsData\(\[localId\]/],
];
let passed = 0;
for (const [name, re] of checks) {
  if (re.test(fragEdit)) passed++;
  else console.error(`FAIL: ${name}`);
}

console.log(`Source inventory: ${files.length} TypeScript file(s)`);
console.log(`Native Twin regression checks: ${passed}/${checks.length} pass`);
if (passed !== checks.length) process.exit(1);
