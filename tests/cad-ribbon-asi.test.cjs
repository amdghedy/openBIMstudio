// Guards the ribbon template against ASI gaps: a group closed with ")" and the next
// "rg(" starting a new line without "+" silently drops every later ribbon group.
const fs = require('fs'), path = require('path'), assert = require('assert');
const lines = fs.readFileSync(path.join(__dirname, '..', 'src/features/cad-viewer.ts'), 'utf8').split('\n');
const gaps = [];
for (let i = 1; i < lines.length; i++) if (/^\s+\)\s*$/.test(lines[i - 1]) && /^\s+rg\($/.test(lines[i])) gaps.push(i);
assert.deepStrictEqual(gaps, [], 'ribbon groups missing "+" before lines: ' + gaps.join(','));
console.log('cad-ribbon-asi: ok');
