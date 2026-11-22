import fc from 'fast-check';
import { preflightStep } from '../../src/modules/ifc-semantics/step-preflight';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

// IFC rejection (#98 invariant 10), REPAIRED.
//
// The previous version of this file imported `src/modules/ifc/import`,
// which does not exist anywhere in the repo, so the file could never load.
// There is still no `importIfc`-shaped API: the real IFC entry points are
// the STEP preflight in src/modules/ifc-semantics/step-preflight.ts and
// the web-ifc-backed importer in src/features/importer.ts. The importer
// is browser-only (web-ifc WASM + DOM) and cannot run under Node/tsx, so
// this property covers the rejection boundary that guards it: the
// preflight is the gate untrusted bytes must pass before they reach the
// parser, and the property pins its contract — arbitrary bytes never
// throw, the verdict is deterministic, a rejection always carries a typed
// human-readable reason, a valid STEP file is accepted, and any truncation
// of it is rejected.

const VALID =
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('a','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);\n#2=IFCCARTESIANPOINT((0.,1.5,-2.));\nENDSEC;\nEND-ISO-10303-21;\n";

// (10a) Arbitrary bytes: preflight never throws, is deterministic, and
// returns a typed verdict (ok boolean; a string reason when rejected).
fc.assert(
  fc.property(fc.uint8Array({ minLength: 0, maxLength: 4096 }), (bytes) => {
    const a = preflightStep(bytes);
    const b = preflightStep(bytes);
    if (typeof a.ok !== 'boolean') return false;
    if (a.ok !== b.ok) return false;
    if (!a.ok && typeof a.reason !== 'string') return false;
    return true;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (10b) The valid STEP base is accepted; truncating it at any point is
// rejected (never silently accepted as complete).
fc.assert(
  fc.property(fc.integer({ min: 1, max: VALID.length - 2 }), (cut) => {
    if (!preflightStep(new TextEncoder().encode(VALID)).ok) return false;
    return preflightStep(new TextEncoder().encode(VALID.slice(0, cut))).ok === false;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

console.log(`PASS ifc-rejection (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
