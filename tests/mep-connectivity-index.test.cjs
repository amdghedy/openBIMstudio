/* MEP connectivity index — equivalence of the grid index with the brute-force O(n^2) scan.
 *
 * connectedPairs / connectivityAdjacency / expandConnected / connectedSelection
 * must return EXACTLY what the old pairwise double loop over areConnected
 * returned. The grid only prunes pairs whose touch regions cannot overlap;
 * every surviving candidate is still decided by areConnected.
 *
 * Property test: seeded random models (ducts, pipes, trays, conduits,
 * fittings, equipment, non-MEP distractors) at many seeds/sizes, compared
 * against an independent brute-force reference implemented here.
 *
 * Run: `node tests/mep-connectivity-index.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "mci-"));
execSync(`npx tsc src/modules/mep/connectivity.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`, { stdio: "inherit" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const m = require(find(out, "connectivity.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

// mulberry32 — deterministic PRNG, seed in the test name for replay.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LINEAR = ["duct", "pipe", "cable-tray", "conduit"];
const KINDS = ["elbow", "tee", "cross", "cap", "transition", "union", "wye"];

function randomModel(seed, count, spread) {
  const r = rng(seed);
  const els = [];
  for (let i = 0; i < count; i++) {
    const roll = r();
    const id = "e" + i;
    if (roll < 0.55) {
      const type = LINEAR[Math.floor(r() * LINEAR.length)];
      const x = (r() - 0.5) * spread, z = (r() - 0.5) * spread;
      const ang = r() * Math.PI * 2, len = 0.5 + r() * 6;
      els.push({
        id, type,
        params: {
          start: [x, z], end: [x + Math.cos(ang) * len, z + Math.sin(ang) * len],
          elevation: Math.floor(r() * 4) * 3, endElevation: Math.floor(r() * 4) * 3,
          height: 0.2 + r() * 0.4, thickness: 0.1 + r() * 0.5,
        },
      });
    } else if (roll < 0.8) {
      els.push({
        id, type: "fitting",
        params: {
          point: [(r() - 0.5) * spread, (r() - 0.5) * spread],
          elevation: Math.floor(r() * 4) * 3, height: 0.3, thickness: 0.2 + r() * 0.4,
          fittingKind: KINDS[Math.floor(r() * KINDS.length)],
          angleIn: r() * Math.PI * 2, angleOut: r() * Math.PI * 2,
          bendRadius: 0.3 + r() * 0.4, parentType: r() < 0.5 ? "duct" : "pipe",
        },
      });
    } else if (roll < 0.9) {
      els.push({
        id, type: "equipment",
        params: {
          point: [(r() - 0.5) * spread, (r() - 0.5) * spread],
          elevation: Math.floor(r() * 4) * 3, height: 0.6, thickness: 0.6, depth: 0.6,
        },
      });
    } else {
      // Non-MEP distractor — must never appear in pairs.
      els.push({
        id, type: "wall",
        params: { start: [0, 0], end: [3, 0], elevation: 0, height: 3, thickness: 0.2 },
      });
    }
  }
  return els;
}

/** Independent brute-force reference: every i<j pair decided by areConnected. */
function brutePairs(els) {
  const mep = els.filter(m.isMepElement);
  const out = [];
  for (let i = 0; i < mep.length; i++) {
    for (let j = i + 1; j < mep.length; j++) {
      if (m.areConnected(mep[i], mep[j])) out.push([mep[i].id, mep[j].id]);
    }
  }
  return out;
}

/** Brute-force BFS reference for expandConnected / connectedSelection. */
function bruteExpand(startIds, els) {
  const byId = new Map(els.map((e) => [e.id, e]));
  const mep = els.filter((e) => m.isMepElement(e) && !e.properties?.pinned);
  const seen = new Set();
  const queue = [];
  for (const id of startIds) {
    const e = byId.get(id);
    if (!e) continue;
    seen.add(id);
    if (m.isMepElement(e) && !e.properties?.pinned) queue.push(e);
  }
  while (queue.length) {
    const cur = queue.pop();
    for (const other of mep) {
      if (seen.has(other.id) || !m.areConnected(cur, other)) continue;
      seen.add(other.id);
      if (other.type !== "equipment") queue.push(other);
    }
  }
  return [...seen].sort();
}

for (const seed of [1, 7, 42, 123, 2026]) {
  for (const count of [0, 1, 5, 40, 120]) {
    t(`seed ${seed} count ${count}: connectedPairs == brute force`, () => {
      const els = randomModel(seed, count, 40);
      const got = m.connectedPairs(els.filter(m.isMepElement)).map(([a, b]) => [a.id, b.id]);
      assert.deepStrictEqual(got, brutePairs(els));
    });
  }
}

t("dense cluster: overlapping runs in a 4 m box agree with brute force", () => {
  const els = randomModel(99, 60, 4);
  const got = m.connectedPairs(els.filter(m.isMepElement)).map(([a, b]) => [a.id, b.id]);
  assert.deepStrictEqual(got, brutePairs(els));
  assert.ok(got.length > 0, "dense fixture should contain connections");
});

t("oversize elements (long runs > 256 cells) still match brute force", () => {
  const els = randomModel(5, 30, 40);
  // A 600 m run spans 300 cells at 2 m — forced onto the oversize path.
  els.push({ id: "long", type: "duct", params: { start: [-300, 0], end: [300, 0], elevation: 0, height: 0.3, thickness: 0.3 } });
  els.push({ id: "cross", type: "duct", params: { start: [0, -3], end: [0, 0], elevation: 0, height: 0.3, thickness: 0.3 } });
  const got = m.connectedPairs(els.filter(m.isMepElement)).map(([a, b]) => [a.id, b.id]);
  assert.deepStrictEqual(got, brutePairs(els));
  assert.ok(got.some(([a, b]) => (a === "long" && b === "cross") || (a === "cross" && b === "long")));
});

t("expandConnected matches brute-force BFS on random models", () => {
  for (const seed of [3, 17, 42]) {
    const els = randomModel(seed, 80, 30);
    const mepIds = els.filter(m.isMepElement).map((e) => e.id);
    const starts = mepIds.filter((_, i) => i % 7 === 0);
    assert.deepStrictEqual([...m.expandConnected(starts, els)].sort(), bruteExpand(starts, els));
  }
});

t("connectedSelection (network + branch) matches the indexed adjacency", () => {
  // Reference: BFS over the brute-force pair list, same junction rule.
  const els = randomModel(42, 80, 30);
  const mep = els.filter(m.isMepElement);
  const pairs = brutePairs(els);
  const adj = new Map(mep.map((e) => [e.id, []]));
  for (const [a, b] of pairs) { adj.get(a).push(b); adj.get(b).push(a); }
  const isJunction = (e) => e.type === "fitting" && m.fittingPortAngles(e.params).length >= 3;
  const byId = new Map(mep.map((e) => [e.id, e]));
  for (const mode of ["network", "branch"]) {
    for (const start of mep.slice(0, 10)) {
      const seen = new Set([start.id]);
      const queue = [start];
      while (queue.length) {
        const cur = queue.pop();
        for (const nid of adj.get(cur.id) ?? []) {
          const o = byId.get(nid);
          if (seen.has(o.id)) continue;
          if (mode === "branch" && !isJunction(cur) && !isJunction(o) &&
              mep.some((j) => j !== cur && j !== o && isJunction(j) && m.areConnected(j, cur) && m.areConnected(j, o))) continue;
          seen.add(o.id);
          if (o.type === "equipment") continue;
          if (mode === "branch" && isJunction(o)) continue;
          queue.push(o);
        }
      }
      assert.deepStrictEqual([...m.connectedSelection(start.id, els, mode)].sort(), [...seen].sort(), `${mode} from ${start.id}`);
    }
  }
});

t("indexed pairs are deterministic across runs", () => {
  const els = randomModel(77, 120, 40);
  const a = m.connectedPairs(els.filter(m.isMepElement)).map(([x, y]) => [x.id, y.id]);
  const b = m.connectedPairs(els.filter(m.isMepElement)).map(([x, y]) => [x.id, y.id]);
  assert.deepStrictEqual(a, b);
});

t("scale: 1500 sparse elements index in bounded time", () => {
  const els = randomModel(2026, 1500, 400);
  const t0 = Date.now();
  const pairs = m.connectedPairs(els.filter(m.isMepElement));
  const ms = Date.now() - t0;
  console.log(`    (1500 elements: ${pairs.length} pairs in ${ms} ms)`);
  assert.ok(ms < 30000, `index took ${ms} ms`);
  assert.ok(pairs.length >= 0);
});

console.log(`\nmep-connectivity-index: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
