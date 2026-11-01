#!/usr/bin/env node
// Every UI command must be catalogued; every status claim must have real test files.
import { readFileSync, existsSync, readdirSync } from 'fs';

const catalog = JSON.parse(readFileSync('documentation/tool-catalog.json', 'utf8'));
const commandIds = scanCommandRegistry('src/commands');  // parse registerCommand ids
const errors = [];

for (const id of commandIds)
  if (!catalog.tools.some((t) => t.id === id))
    errors.push('UI command not in catalog: ' + id);

for (const tool of catalog.tools) {
  if (['tested', 'runtime-verified'].includes(tool.status))
    for (const t of tool.tests ?? [])
      if (!existsSync(t))
        errors.push(tool.id + ' claims ' + tool.status + ' but missing test: ' + t);
  if (tool.status === 'partial' && !tool.knownLimitation)
    errors.push(tool.id + ' is partial but has no knownLimitation text');
}

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('tool catalog consistent: ' + commandIds.length + ' commands checked');
