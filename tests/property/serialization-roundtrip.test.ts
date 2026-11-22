import fc from 'fast-check';
import { buildProjectFile, parseProjectFile } from '../../src/modules/projects/project-file';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

// Serialization round-trip (#98 invariant 7): a random project document
// plus random model blobs survive build → parse byte-for-byte — the doc
// deep-equals, every blob's bytes, name and order are preserved. Uses the
// real .obsproj container (src/modules/projects/project-file.ts), the same
// code the example-based tests/project-file.test.cjs exercises.

const text = fc.string({ minLength: 0, maxLength: 24 });

const doc = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  name: text,
  createdAt: fc.integer({ min: 0, max: 1_000_000_000 }),
  updatedAt: fc.integer({ min: 0, max: 1_000_000_000 }),
  elements: fc.array(
    fc.record({ id: fc.string({ minLength: 1, maxLength: 8 }), type: fc.constantFrom('wall', 'door', 'window', 'slab') }),
    { maxLength: 5 },
  ),
  models: fc.array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 8 }),
      name: fc.string({ minLength: 1, maxLength: 12 }),
      bytes: fc.integer({ min: 0, max: 1000 }),
    }),
    { maxLength: 3 },
  ),
  planDimensions: fc.array(fc.record({ x1: fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }) }), { maxLength: 3 }),
  planAnnotations: fc.record({
    tags: fc.array(fc.record({ text }), { maxLength: 3 }),
    notes: fc.array(text, { maxLength: 3 }),
  }),
});

const blobSpec = fc.record({
  modelId: fc.string({ minLength: 1, maxLength: 8 }),
  name: fc.string({ minLength: 1, maxLength: 12 }),
  bytes: fc.uint8Array({ minLength: 0, maxLength: 256 }),
});

await fc.assert(
  fc.asyncProperty(
    doc,
    fc.array(blobSpec, { maxLength: 3 }),
    async (d, blobs) => {
      const file = buildProjectFile(
        d as Parameters<typeof buildProjectFile>[0],
        blobs.map((b) => ({ modelId: b.modelId, name: b.name, blob: new Blob([b.bytes]) })),
      );
      const parsed = await parseProjectFile(file);
      if (JSON.stringify(parsed.doc) !== JSON.stringify(d)) return false;
      if (parsed.blobs.length !== blobs.length) return false;
      for (let i = 0; i < blobs.length; i++) {
        if (parsed.blobs[i].modelId !== blobs[i].modelId) return false;
        if (parsed.blobs[i].name !== blobs[i].name) return false;
        const bytes = new Uint8Array(await parsed.blobs[i].blob.arrayBuffer());
        if (bytes.length !== blobs[i].bytes.length) return false;
        if (!bytes.every((v, j) => v === blobs[i].bytes[j])) return false;
      }
      return true;
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

console.log(`PASS serialization-roundtrip (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
