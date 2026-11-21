// Every ribbon <button data-a=…> must have a handler registered in act/act2 (or a
// dedicated querySelector wiring), otherwise the button appears but does nothing.
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'src/features/cad-viewer.ts'), 'utf8');
const L = src.split('\n');
const iBar = L.findIndex((l) => /^\s{2}function buildBar\(\)/.test(l));
const iBar2 = L.findIndex((l) => /^\s{2}function buildBar2\(\)/.test(l));
assert(iBar > 0 && iBar2 > iBar, 'buildBar/buildBar2 not found');
const barSrc = L.slice(iBar, iBar2).join('\n');
const bar2End = L.findIndex((l, i) => i > iBar2 && /^\s{2}buildBar\(\);/.test(l));
const bar2Src = L.slice(iBar2, bar2End).join('\n');
const buttons = (t) => [...t.matchAll(/rb\([^`]*?`([^`]*)`/g)].flatMap((m) => [...m[1].matchAll(/data-a="([^"]+)"/g)].map((x) => x[1]));
const hasKey = (id) => new RegExp(`(^|[\\s,{])("${id}"|'${id}'|${/^[A-Za-z_$][\w$]*$/.test(id) ? id : '\u0000'})\\s*:`, 'm').test(src)
  || new RegExp(`(act2?)\\[["']${id}["']\\]\\s*=`).test(src)
  || new RegExp(`\\[data-a=${id}\\]`).test(src)
  || new RegExp(`\\bq\\(["']${id}["']\\)\\.onclick`).test(src);
const missing = [];
for (const id of new Set([...buttons(barSrc), ...buttons(bar2Src)])) if (!hasKey(id)) missing.push(id);
assert.deepStrictEqual(missing, [], 'ribbon buttons without a handler: ' + missing.join(', '));
console.log('cad-ribbon-wiring: ok', new Set([...buttons(barSrc), ...buttons(bar2Src)]).size, 'buttons');
