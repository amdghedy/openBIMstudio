#!/usr/bin/env node
// import -> export -> re-import -> diff; writes interop-report.json; exit 1 on regression
import { IfcAPI } from 'web-ifc';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { diffModel } from '../src/core/interop/diff.js';
import { exportToIfc } from '../src/modules/ifc/export.js';

const CORPUS = 'test/fixtures/ifc-corpus';
const ifc = new IfcAPI();
await ifc.Init();

let failures = 0;
const report = [];
for (const name of readdirSync(CORPUS).filter((f) => f.endsWith('.ifc'))) {
  const bytes = readFileSync(CORPUS + '/' + name);
  const m1 = ifc.OpenModel(new Uint8Array(bytes), {});
  const reimported = ifc.OpenModel(toBytes(exportToIfc(ifc, m1)), {});
  const entry = { file: name, ...diffModel(ifc, m1, reimported) };
  // diffModel compares per-class entity counts, property-set key sets,
  // placement matrices (1e-6), unit assignments, and a normalized geometry hash.
  entry.pass = entry.classes.every((c) => c.missing === 0 && c.extra === 0)
            && entry.geomHashEqual && entry.unitsEqual;
  if (!entry.pass) failures++;
  report.push(entry);
  ifc.CloseModel(m1); ifc.CloseModel(reimported);
}
writeFileSync('interop-report.json', JSON.stringify(report, null, 2));
console.log('golden round-trip: ' + (report.length - failures) + '/' + report.length + ' pass');
process.exit(failures ? 1 : 0);
