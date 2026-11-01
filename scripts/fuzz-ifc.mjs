#!/usr/bin/env node
// Mutate corpus bytes; the parser may fail, but only in a controlled way.
import { readFileSync } from 'fs';
import { importIfcIsolated } from '../src/modules/ifc/importWorker';

const seeds = ['test/fixtures/ifc-corpus/wall-demo.ifc',
               'test/fixtures/ifc-corpus/synth-minimal.ifc'];

for (let i = 0; i < 500; i++) {
  const bytes = Buffer.from(readFileSync(seeds[i % seeds.length]));
  for (let k = 0; k < 20; k++) bytes[(i * 31 + k * 7) % bytes.length] ^= 1 << (k % 8);
  const outcome = await runWithTimeout(() => importIfcIsolated(bytes), 10000);
  if (outcome !== 'ok' && outcome !== 'typed-error') {
    console.error('uncontrolled failure at iteration ' + i + ': ' + outcome);
    process.exit(1);   // hang, OOM kill, or worker crash = release blocker
  }
}
console.log('fuzz: 500 mutations, all outcomes controlled');
