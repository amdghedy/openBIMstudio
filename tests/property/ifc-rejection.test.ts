import fc from 'fast-check';
import { importIfc } from '../../src/modules/ifc/import';

fc.assert(
  fc.asyncProperty(
    fc.uint8Array({ minLength: 0, maxLength: 4096 }),
    async (bytes) => {
      const result = await importIfc(bytes);
      if (result.ok) return true;
      return typeof result.error.code === 'string';  // typed, reportable error
    },
  ),
  { numRuns: 300, timeout: 2000 },
);
