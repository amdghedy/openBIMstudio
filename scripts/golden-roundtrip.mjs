#!/usr/bin/env node
// import -> re-import -> diff -> compare against golden snapshots; exit 1 on regression.
// Writes interop-report.json (uploaded as a CI artifact).
//
// web-ifc 0.0.76 has no general model exporter, so the "export" leg of the original
// design is a second independent parse of the same bytes for now: the gate still
// catches parser nondeterminism and any snapshot drift across refactors. When a real
// exporter lands, replace the second OpenModel with exportToIfc() + OpenModel and the
// rest of the harness stays unchanged.
import { IfcAPI } from 'web-ifc';
import * as W from 'web-ifc';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';

const CORPUS = 'test/fixtures/ifc-corpus';
const SNAPSHOTS = CORPUS + '/snapshots';

const TYPE_IDS = Object.entries(W)
  .filter(([k, v]) => typeof v === 'number' && /^IFC[A-Z0-9_]+$/.test(k));

function metrics(ifc, model) {
  const classes = [];
  for (const [name, id] of TYPE_IDS) {
    const n = ifc.GetLineIDsWithType(model, id).size();
    if (n > 0) classes.push({ name, count: n });
  }
  classes.sort((a, b) => a.name.localeCompare(b.name));
  const schema = ifc.GetModelSchema(model);
  const geomHash = createHash('sha256')
    .update(JSON.stringify(classes) + '|' + schema)
    .digest('hex')
    .slice(0, 16);
  return { schema, classes, geomHash };
}

function diffMetrics(a, b) {
  const ma = new Map(a.classes.map((c) => [c.name, c.count]));
  const mb = new Map(b.classes.map((c) => [c.name, c.count]));
  const names = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const classes = names.map((name) => ({
    name,
    missing: Math.max(0, (ma.get(name) ?? 0) - (mb.get(name) ?? 0)),
    extra: Math.max(0, (mb.get(name) ?? 0) - (ma.get(name) ?? 0)),
  }));
  return {
    classes,
    geomHashEqual: a.geomHash === b.geomHash,
    schemaEqual: a.schema === b.schema,
  };
}

const ifc = new IfcAPI();
await ifc.Init();
mkdirSync(SNAPSHOTS, { recursive: true });

let failures = 0;
const report = [];
for (const name of readdirSync(CORPUS).filter((f) => f.endsWith('.ifc')).sort()) {
  const bytes = new Uint8Array(readFileSync(CORPUS + '/' + name));
  const m1 = ifc.OpenModel(bytes.slice(), {});
  const met1 = metrics(ifc, m1);
  ifc.CloseModel(m1);

  const m2 = ifc.OpenModel(bytes.slice(), {});
  const met2 = metrics(ifc, m2);
  ifc.CloseModel(m2);

  const entry = { file: name, schema: met1.schema, entities: met1.classes.reduce((s, c) => s + c.count, 0), ...diffMetrics(met1, met2) };
  entry.pass = entry.classes.every((c) => c.missing === 0 && c.extra === 0)
    && entry.geomHashEqual && entry.schemaEqual;

  const snap = SNAPSHOTS + '/' + name + '.json';
  if (!existsSync(snap)) {
    writeFileSync(snap, JSON.stringify(met1, null, 2));
    entry.snapshot = 'created';
  } else {
    const golden = JSON.parse(readFileSync(snap, 'utf8'));
    if (golden.geomHash !== met1.geomHash || golden.schema !== met1.schema) {
      entry.snapshot = 'MISMATCH';
      entry.pass = false;
      const gmc = new Map(golden.classes.map((c) => [c.name, c.count]));
      entry.snapshotDiff = met1.classes.filter((c) => gmc.get(c.name) !== c.count)
        .map((c) => ({ name: c.name, golden: gmc.get(c.name) ?? 0, now: c.count }));
    } else entry.snapshot = 'match';
  }

  if (!entry.pass) failures++;
  report.push(entry);
}

writeFileSync('interop-report.json', JSON.stringify(report, null, 2));
console.log('golden round-trip: ' + (report.length - failures) + '/' + report.length + ' pass');
process.exit(failures ? 1 : 0);
