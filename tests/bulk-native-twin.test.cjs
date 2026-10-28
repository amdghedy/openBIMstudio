/**
 * Unit tests for bulk Native Twin selection flattening / result accounting.
 * No WebGL — pure logic mirrors bulk-native-twin.ts helpers.
 */
const assert = require("assert");

function flattenSelection(map) {
  const out = [];
  for (const [modelId, ids] of Object.entries(map || {})) {
    if (!modelId) continue;
    const list = ids instanceof Set ? [...ids] : Array.from(ids);
    for (const raw of list) {
      const localId = Number(raw);
      if (!Number.isFinite(localId)) continue;
      out.push({ modelId, localId });
    }
  }
  return out;
}

async function runBulk(flat, { convertOne, isAlreadyTwin, signal } = {}) {
  const result = {
    total: flat.length,
    created: 0,
    skipped: 0,
    failed: 0,
    aborted: false,
    items: [],
    twins: [],
  };
  for (let i = 0; i < flat.length; i++) {
    if (signal?.aborted) {
      result.aborted = true;
      result.failed += flat.length - i;
      break;
    }
    const { modelId, localId } = flat[i];
    if (isAlreadyTwin?.(modelId, localId)) {
      result.skipped++;
      result.items.push({ modelId, localId, status: "skipped_existing" });
      continue;
    }
    try {
      const twin = await convertOne(modelId, localId);
      if (twin?.id) {
        result.created++;
        result.twins.push({ id: twin.id, modelId, localId });
        result.items.push({ modelId, localId, status: "created", twinId: twin.id });
      } else {
        result.failed++;
        result.items.push({ modelId, localId, status: "failed_no_geometry" });
      }
    } catch {
      result.failed++;
      result.items.push({ modelId, localId, status: "failed_unknown" });
    }
  }
  return result;
}

// Flatten Set + array
{
  const flat = flattenSelection({
    A: new Set([1, 2, 3]),
    B: [10, 11],
  });
  assert.strictEqual(flat.length, 5);
  assert.deepStrictEqual(flat[0], { modelId: "A", localId: 1 });
  assert.deepStrictEqual(flat[4], { modelId: "B", localId: 11 });
}

// Empty / invalid
{
  assert.strictEqual(flattenSelection({}).length, 0);
  assert.strictEqual(flattenSelection({ M: ["x", NaN] }).length, 0);
}

(async () => {
  // Mixed success / skip / fail
  {
    const flat = flattenSelection({ M: [1, 2, 3, 4] });
    const already = new Set(["M::2"]);
    const result = await runBulk(flat, {
      isAlreadyTwin: (m, id) => already.has(`${m}::${id}`),
      convertOne: async (m, id) => {
        if (id === 3) return null;
        if (id === 4) throw new Error("boom");
        return { id: `t-${id}` };
      },
    });
    assert.strictEqual(result.total, 4);
    assert.strictEqual(result.created, 1);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.failed, 2);
    assert.strictEqual(result.twins.length, 1);
    assert.strictEqual(result.twins[0].id, "t-1");
  }

  // Abort
  {
    const flat = flattenSelection({ M: [1, 2, 3] });
    const ac = { aborted: false };
    let calls = 0;
    const result = await runBulk(flat, {
      signal: ac,
      convertOne: async () => {
        calls++;
        if (calls === 1) ac.aborted = true;
        return { id: `t-${calls}` };
      },
    });
    assert.strictEqual(result.created, 1);
    assert.strictEqual(result.aborted, true);
    assert.ok(result.failed >= 1);
  }

  console.log("bulk-native-twin.test.cjs: ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
