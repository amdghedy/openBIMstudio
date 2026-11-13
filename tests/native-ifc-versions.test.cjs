/**
 * Unit tests for the Native IFC versions layer — the “git for BIM” engine.
 * No DOM/WebGL — pure logic mirrors native-ifc-versions.ts:
 *   twin identity · canonical JSON · structured twin diff · quota-safe store
 *   commit metadata (label/parent chain) · restore-with-stash sequence.
 */
const assert = require("assert");

/* ── mirrors: twinIdentity ─────────────────────────────────────────────── */
function twinIdentity(e) {
  if (e?.sourceGlobalId) return `gid:${e.sourceGlobalId}`;
  const lid = Number(e?.localId);
  if (e?.modelId != null && Number.isFinite(lid)) return `el:${e.modelId}:${lid}`;
  if (e?.nativeElementId) return `nat:${e.nativeElementId}`;
  return `id:${e?.id ?? "?"}`;
}

/* ── mirrors: canonicalJson ────────────────────────────────────────────── */
function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const obj = value;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/* ── mirrors: diff engine ──────────────────────────────────────────────── */
function sameGeometry(a, b) {
  const pa = a?.positions;
  const pb = b?.positions;
  if (!pa?.length && !pb?.length) return true;
  if (pa?.length !== pb?.length) return false;
  if (!pa || !pb) return pa === pb;
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

function changedRow(from, to) {
  const changes = [];
  let deltaMeters;
  const p1 = Array.isArray(from.position) ? from.position : null;
  const p2 = Array.isArray(to.position) ? to.position : null;
  if (p1 && p2) {
    const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
    if (d > 1e-9) {
      changes.push(`moved · Δ ${d.toFixed(2)}m`);
      deltaMeters = d;
    }
  }
  const q1 = Array.isArray(from.quaternion) ? from.quaternion : null;
  const q2 = Array.isArray(to.quaternion) ? to.quaternion : null;
  if (q1 && q2) {
    const dot = Math.abs(q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3]);
    if (dot < 0.99999) changes.push("rotated");
  }
  const s1 = Array.isArray(from.scale) ? from.scale : null;
  const s2 = Array.isArray(to.scale) ? to.scale : null;
  if (s1 && s2 && s1.some((v, i) => Math.abs(v - s2[i]) > 1e-9)) changes.push("scaled");
  if (from.name !== to.name) changes.push("renamed");
  if (from.category !== to.category) changes.push("type changed");
  if (from.predefinedType !== to.predefinedType) changes.push("predefined type changed");
  if (from.description !== to.description) changes.push("description changed");
  for (const field of ["propertySets", "quantities", "overrides"]) {
    if (canonicalJson(from[field] ?? null) !== canonicalJson(to[field] ?? null)) {
      changes.push("properties changed");
      break;
    }
  }
  if (!sameGeometry(from.geometry, to.geometry)) changes.push("geometry changed");
  if (!changes.length) return null;
  return {
    key: twinIdentity(to),
    name: String(to.name ?? "(unnamed)"),
    category: String(to.category ?? "—"),
    modelId: to.modelId ? String(to.modelId) : undefined,
    changes,
    deltaMeters,
  };
}

function computeTwinDiff(fromEdits, toEdits) {
  const from = Array.isArray(fromEdits) ? fromEdits : [];
  const to = Array.isArray(toEdits) ? toEdits : [];
  const fromMap = new Map();
  for (const e of from) fromMap.set(twinIdentity(e), e);
  const toMap = new Map();
  for (const e of to) toMap.set(twinIdentity(e), e);
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;
  for (const [key, e] of toMap) {
    const prev = fromMap.get(key);
    if (!prev) {
      added.push({
        key, name: String(e.name ?? "(unnamed)"), category: String(e.category ?? "—"),
        modelId: e.modelId ? String(e.modelId) : undefined, changes: [],
      });
    } else {
      const row = changedRow(prev, e);
      if (row) changed.push(row);
      else unchanged++;
    }
  }
  for (const [key, e] of fromMap) {
    if (!toMap.has(key)) {
      removed.push({
        key, name: String(e.name ?? "(unnamed)"), category: String(e.category ?? "—"),
        modelId: e.modelId ? String(e.modelId) : undefined, changes: [],
      });
    }
  }
  return { added, removed, changed, unchanged };
}

/* ── mirrors: quota-safe store degradation ─────────────────────────────── */
const MAX_VERSIONS = 30;
const MIN_VERSIONS = 5;

function stripGeometry(edits) {
  return (edits || []).map((e) => {
    if (!e?.geometry?.positions?.length) return e;
    const { geometry, ...rest } = e;
    return { ...rest, geometry: undefined };
  });
}

function saveVersionsInto(setItem, versions) {
  let store = versions.slice(-MAX_VERSIONS);
  const attempts = [
    (v) => v,
    (v) => v.slice(-Math.max(MIN_VERSIONS, Math.floor(v.length / 2))),
    (v) => v.map((ver, i) => (i < v.length - 1 ? { ...ver, slim: true, edits: stripGeometry(ver.edits) } : ver)),
    (v) => v.slice(-MIN_VERSIONS).map((ver) => ({ ...ver, slim: true, edits: stripGeometry(ver.edits) })),
  ];
  for (let i = 0; i < attempts.length; i++) {
    store = i === 0 ? store : attempts[i](store);
    if (setItem(JSON.stringify(store))) return { ok: true, store };
  }
  return { ok: false, store };
}

/* ── mirrors: restore sequence (stash before checkout) ──────────────────── */
async function restoreSequence({ store, confirmYes, currentEdits, versionEdits, deserialize }) {
  if (!confirmYes) return { restored: false, committed: 0 };
  let committed = 0;
  if (currentEdits.length) {
    const v = {
      id: `auto-${store.length + 1}`, label: `v${store.length + 1}`,
      message: "Auto-saved before restore", auto: true,
      twinCount: currentEdits.length, edits: currentEdits,
    };
    store.push(v);
    committed++;
  }
  await deserialize(versionEdits);
  return { restored: true, committed, sceneNow: versionEdits };
}

/* ═══════════════════════════════════════════════════════════════════════ */
// Identity preference: GlobalId > modelId:localId (stable across rebuilds) > nativeElementId > id
{
  assert.strictEqual(twinIdentity({ sourceGlobalId: "ABC" }), "gid:ABC");
  assert.strictEqual(twinIdentity({ modelId: "M", localId: 7 }), "el:M:7");
  // nativeElementId re-mints on rebuild — modelId:localId wins when both exist
  assert.strictEqual(twinIdentity({ modelId: "M", localId: 7, nativeElementId: "n1" }), "el:M:7");
  assert.strictEqual(twinIdentity({ nativeElementId: "n1" }), "nat:n1");
  assert.strictEqual(twinIdentity({ id: "t1" }), "id:t1");
  assert.strictEqual(twinIdentity({}), "id:?");
  // localId NaN falls through to id
  assert.strictEqual(twinIdentity({ modelId: "M", localId: NaN, id: "t2" }), "id:t2");
}

// Canonical JSON is key-order independent
{
  assert.strictEqual(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.strictEqual(
    canonicalJson({ psets: { z: [1, { y: 2, x: 3 }] }, w: null }),
    canonicalJson({ w: null, psets: { z: [1, { x: 3, y: 2 }] } }),
  );
  assert.strictEqual(canonicalJson(undefined), "null");
}

// Diff: added / removed / unchanged
{
  const a = [
    { id: "t1", modelId: "M", localId: 1, name: "Wall", category: "Walls", position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    { id: "t2", modelId: "M", localId: 2, name: "Door", category: "Doors", position: [1, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  ];
  const b = [
    { id: "t1", modelId: "M", localId: 1, name: "Wall", category: "Walls", position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    { id: "t3", modelId: "M", localId: 3, name: "Window", category: "Windows", position: [2, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  ];
  const d = computeTwinDiff(a, b);
  assert.strictEqual(d.added.length, 1);
  assert.strictEqual(d.added[0].name, "Window");
  assert.strictEqual(d.removed.length, 1);
  assert.strictEqual(d.removed[0].name, "Door");
  assert.strictEqual(d.changed.length, 0);
  assert.strictEqual(d.unchanged, 1);
}

// Diff change flags: move / rotate / scale / rename / type / props / geometry
{
  const base = { modelId: "M", localId: 1, name: "Wall", category: "Walls", position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };
  const moved = { ...base, position: [3, 4, 0] };
  const dMove = computeTwinDiff([base], [moved]);
  assert.strictEqual(dMove.changed.length, 1);
  assert.ok(dMove.changed[0].changes[0].startsWith("moved · Δ 5.00m"));
  assert.strictEqual(dMove.changed[0].deltaMeters, 5);

  const rotated = { ...base, quaternion: [0, 0, 0.7071, 0.7071] };
  assert.ok(computeTwinDiff([base], [rotated]).changed[0].changes.includes("rotated"));

  const scaled = { ...base, scale: [2, 1, 1] };
  assert.ok(computeTwinDiff([base], [scaled]).changed[0].changes.includes("scaled"));

  const renamed = { ...base, name: "Wall B" };
  assert.ok(computeTwinDiff([base], [renamed]).changed[0].changes.includes("renamed"));

  const recat = { ...base, category: "Structural Walls" };
  assert.ok(computeTwinDiff([base], [recat]).changed[0].changes.includes("type changed"));

  // propertySets equal but key order different → NOT changed
  const props1 = { ...base, propertySets: { Pset: { A: 1, B: 2 } } };
  const props2 = { ...base, propertySets: { Pset: { B: 2, A: 1 } } };
  assert.strictEqual(computeTwinDiff([props1], [props2]).changed.length, 0);
  // propertySets actually different → changed
  const props3 = { ...base, propertySets: { Pset: { A: 9, B: 2 } } };
  assert.ok(computeTwinDiff([props1], [props3]).changed[0].changes.includes("properties changed"));

  const geo1 = { ...base, geometry: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] } };
  const geo2 = { ...base, geometry: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 1] } };
  assert.ok(computeTwinDiff([geo1], [geo2]).changed[0].changes.includes("geometry changed"));
  assert.strictEqual(computeTwinDiff([geo1], [geo1]).changed.length, 0);
  // both without geometry → identical
  assert.strictEqual(computeTwinDiff([base], [{ ...base }]).changed.length, 0);
}

// Identity keeps edits coupled across id renames (same GlobalId = same element)
{
  const v1 = [{ id: "t1", sourceGlobalId: "G1", modelId: "M", localId: 1, name: "Old", position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }];
  const v2 = [{ id: "t-other", sourceGlobalId: "G1", modelId: "M", localId: 1, name: "New", position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }];
  const d = computeTwinDiff(v1, v2);
  assert.strictEqual(d.added.length, 0);
  assert.strictEqual(d.removed.length, 0);
  assert.strictEqual(d.changed.length, 1);
  assert.ok(d.changed[0].changes.includes("renamed"));
}

(async () => {
  // Quota degradation: store succeeds immediately when there is room
  {
    const calls = [];
    const res = saveVersionsInto((s) => { calls.push(s.length); return true; }, [{ edits: [] }]);
    assert.ok(res.ok);
    assert.strictEqual(calls.length, 1);
  }

  // Quota degradation: capped localStorage → drop oldest half → slim → last resort
  {
    const cap = 900; // bytes
    const setItem = (s) => s.length <= cap;
    const mk = (i) => ({
      id: `v${i}`, label: `v${i}`, message: "m".repeat(60),
      twinCount: 1, edits: [{ id: `t${i}`, geometry: { positions: new Array(60).fill(i) } }],
    });
    const versions = Array.from({ length: 10 }, (_, i) => mk(i));
    const res = saveVersionsInto(setItem, versions);
    assert.ok(res.ok, "degradation must eventually succeed");
    assert.ok(res.store.length < 10, "some commits were trimmed");
    // Newest commit keeps its geometry (only older ones get slimmed at step 3)
    const newest = res.store[res.store.length - 1];
    assert.ok(newest.edits[0].geometry?.positions?.length, "newest stays lossless");
    // Everything slimmed store still returns newest MIN_VERSIONS
    const tiny = saveVersionsInto(() => false, versions);
    assert.strictEqual(tiny.ok, false);
  }

  // Restore sequence: no confirmation → untouched
  {
    const store = [];
    const out = await restoreSequence({
      store, confirmYes: false, currentEdits: [{ id: "t1" }], versionEdits: [{ id: "t9" }],
      deserialize: async () => { throw new Error("must not run"); },
    });
    assert.strictEqual(out.restored, false);
    assert.strictEqual(store.length, 0);
  }

  // Restore sequence: stash current → checkout target
  {
    const store = [];
    let deserialized = null;
    const out = await restoreSequence({
      store, confirmYes: true,
      currentEdits: [{ id: "t1", modelId: "M", localId: 1 }],
      versionEdits: [{ id: "t5", modelId: "M", localId: 5 }],
      deserialize: async (edits) => { deserialized = edits; },
    });
    assert.ok(out.restored);
    assert.strictEqual(out.committed, 1, "current state stashed as auto commit");
    assert.strictEqual(store[0].auto, true);
    assert.strictEqual(deserialized.length, 1);
    assert.strictEqual(deserialized[0].id, "t5");
  }

  // Restore sequence: empty current state → no stash commit
  {
    const store = [];
    const out = await restoreSequence({
      store, confirmYes: true, currentEdits: [], versionEdits: [{ id: "t5" }],
      deserialize: async () => {},
    });
    assert.strictEqual(out.committed, 0);
    assert.strictEqual(store.length, 0);
  }

  // Commit metadata: label sequence + parent chain (mirror of commitNativeIfcVersion)
  {
    const store = [];
    const commit = (message, opts = {}) => {
      const edits = opts.edits ?? [{ id: "t1" }];
      if (!edits.length) return null;
      const prev = store[store.length - 1] ?? null;
      const v = {
        id: `v-${store.length + 1}`, label: `v${store.length + 1}`,
        message: (message ?? "").trim() || `Commit · ${edits.length} twin(s)`,
        parent: prev?.id ?? null, twinCount: edits.length,
        models: Array.from(new Set(edits.map((e) => String(e.modelId ?? "?")))).sort(),
        auto: opts.auto || undefined, edits,
      };
      store.push(v);
      return v;
    };
    const v1 = commit("Baseline", { edits: [{ id: "t1", modelId: "B" }, { id: "t2", modelId: "A" }] });
    const v2 = commit("Moved walls", { edits: [{ id: "t1", modelId: "B" }] });
    assert.strictEqual(v1.label, "v1");
    assert.strictEqual(v2.label, "v2");
    assert.strictEqual(v2.parent, v1.id);
    assert.strictEqual(v1.parent, null);
    assert.deepStrictEqual(v1.models, ["A", "B"], "models deduped + sorted");
    assert.strictEqual(v2.auto, undefined, "manual commit not flagged auto");
    // empty edits → rejected
    assert.strictEqual(commit("empty", { edits: [] }), null);
  }

  console.log("native-ifc-versions.test.cjs: ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
