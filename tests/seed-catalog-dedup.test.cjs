// tests/seed-catalog-dedup.test.cjs
//
// new.family parity Item 1 — seed-catalog loader re-added the whole
// catalog on every reload (service list 50 → 111): `familyStore.create()`
// assigns a fresh random id, so the loader's `get(entry.id)` check could
// never match a family loaded on an earlier boot, and seed families are
// persisted to localStorage.
//
// The fix: seed families are inserted with their catalog id preserved
// (`familyStore.createSeed`), legacy copies persisted under random ids
// are recognised by (origin + name + content signature), and exact
// duplicates left by earlier boots are removed. This suite pins the
// pure dedupe logic in `src/modules/families/seed-catalog-dedupe.ts`
// (no runtime imports, so it compiles standalone) and the loader
// wiring by source, and simulates two boots — including a legacy boot
// whose persisted copies carry random ids — against a fake store that
// implements the real store's createSeed contract.
//
// Run: node tests/seed-catalog-dedup.test.cjs
// CI:  test:seed-catalog-dedup (package.json + scripts/ci-unit-tests.mjs)

const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);

const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".seed-dedup-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc src/modules/families/seed-catalog-dedupe.ts"
  + " --outDir " + JSON.stringify(tmpOut)
  + " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck",
  { cwd: root, stdio: "inherit", shell: true },
);
const find = (n) => {
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (f.name === n) return p;
    }
    return null;
  };
  return walk(tmpOut);
};
const dedupe = require(find("seed-catalog-dedupe.js"));
const { findExistingSeedFamily, dedupeSeedCatalogCopies, seedFamilySignature } = dedupe;

// ── Fixtures ────────────────────────────────────────────────────────────────
function fam(over) {
  return {
    id: "seed-door-001",
    name: "Single Flush Door",
    category: "door",
    ifcEntity: "IfcDoor",
    sourceElementType: undefined,
    group: "Doors",
    origin: "seed-catalog",
    parameters: [{ name: "width", type: "length", scope: "instance", default: 0.9, editable: true }],
    geometry: { kind: "box", w: { ref: "width" }, d: { const: 0.05 }, h: { const: 2.1 } },
    types: [{ id: "t_seed-door-001-0", name: "Single 900 x 2100", values: { width: 0.9 } }],
    schemaVersion: 2,
    builtIn: false,
    ...over,
  };
}
const entry = { id: "seed-door-001", name: "Single Flush Door", path: "Doors/single-flush-door.json" };

class FakeStore {
  constructor() { this.byId = new Map(); }
  list() { return [...this.byId.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  get(id) { return this.byId.get(id) ?? null; }
  // Mirrors FamilyStore.createSeed: preserve the id; an existing id wins.
  createSeed(def) {
    const existing = this.byId.get(def.id);
    if (existing) return existing;
    const copy = JSON.parse(JSON.stringify(def));
    this.byId.set(copy.id, copy);
    return copy;
  }
  // Mirrors FamilyStore.create: fresh random id, catalog id discarded.
  create(def) {
    const copy = JSON.parse(JSON.stringify(def));
    copy.id = "fam-random-" + Math.random().toString(36).slice(2);
    this.byId.set(copy.id, copy);
    return copy;
  }
  remove(id) { return this.byId.delete(id); }
}

// ── findExistingSeedFamily ──────────────────────────────────────────────────
{
  const store = new FakeStore();
  ok(findExistingSeedFamily(store, entry, fam()) === null, "empty store: not present");
  store.createSeed(fam());
  ok(findExistingSeedFamily(store, entry, fam())?.id === "seed-door-001", "found by catalog id");
}
{
  // Legacy copy: persisted under a random id by an earlier boot.
  const store = new FakeStore();
  const legacy = store.create({ ...fam(), id: undefined });
  ok(legacy.id !== "seed-door-001", "legacy copy has a random id");
  ok(
    findExistingSeedFamily(store, entry, fam())?.id === legacy.id,
    "legacy copy recognised by name + signature",
  );
}
{
  // Same name, different content = a user edit, not a duplicate.
  const store = new FakeStore();
  const edited = fam({ id: "fam-user-1", origin: "seed-catalog" });
  edited.parameters = [{ name: "width", type: "length", scope: "instance", default: 1.2, editable: true }];
  store.byId.set(edited.id, edited);
  ok(findExistingSeedFamily(store, entry, fam()) === null, "user-edited same-name family is not a match");
}
ok(
  seedFamilySignature(fam()) === seedFamilySignature(fam({ id: "other-id" })),
  "signature ignores the id",
);

// ── dedupeSeedCatalogCopies ─────────────────────────────────────────────────
{
  const store = new FakeStore();
  const kept = store.createSeed(fam()); // catalog-id copy
  store.create({ ...fam(), id: undefined }); // exact duplicate, random id
  store.create({ ...fam(), id: undefined }); // another exact duplicate
  const edited = fam({ id: "fam-user-2" });
  edited.parameters = [{ name: "width", type: "length", scope: "instance", default: 1.2, editable: true }];
  store.byId.set(edited.id, edited); // user edit, same name
  const catalogByName = new Map([["Single Flush Door", { id: "seed-door-001", def: fam() }]]);
  eq(dedupeSeedCatalogCopies(store, catalogByName), 2, "removes the two exact duplicates");
  eq(store.list().length, 2, "keeps the catalog copy and the user edit");
  ok(store.get("seed-door-001")?.id === kept.id, "keeps the catalog-id copy");
  ok(store.get("fam-user-2") !== null, "keeps the user edit");
}
{
  const store = new FakeStore();
  store.createSeed(fam());
  const catalogByName = new Map([["Single Flush Door", { id: "seed-door-001", def: fam() }]]);
  eq(dedupeSeedCatalogCopies(store, catalogByName), 0, "single copy: nothing removed");
}

// ── Two-boot simulation (the reported 50 → 111) ───────────────────────────
// Boot 1 loads the catalog; boot 2 restores the persisted store and loads
// again. The list size must be identical after both boots.
function simulateBoot(store, useLegacyCreate, legacyCheck = false) {
  let added = 0;
  for (const e of [entry]) {
    const def = fam({ id: e.id });
    // The old loader checked by id only; the fixed loader also
    // recognises legacy copies by name + signature.
    const present = legacyCheck
      ? store.get(e.id)
      : findExistingSeedFamily(store, e, def);
    if (present) continue;
    if (useLegacyCreate) {
      const { id: _id, schemaVersion: _v, builtIn: _b, ...rest } = def;
      store.create(rest); // old loader: catalog id discarded
    } else {
      store.createSeed(def);
    }
    added++;
  }
  // The old loader had no dedupe pass; only the fixed loader cleans up.
  if (!legacyCheck) {
    dedupeSeedCatalogCopies(store, new Map([[entry.name, { id: entry.id, def: fam() }]]));
  }
  return added;
}
{
  // Fixed loader, fresh profile: boot 1 adds 1, boot 2 adds 0.
  const store = new FakeStore();
  eq(simulateBoot(store, false), 1, "fixed boot 1 adds the catalog family");
  eq(store.list().length, 1, "fixed boot 1 size");
  eq(simulateBoot(store, false), 0, "fixed boot 2 adds nothing");
  eq(store.list().length, 1, "fixed boot 2 size is stable");
}
{
  // Fixed loader, LEGACY profile: boot 1's copies carry random ids
  // (persisted by the old loader). Boot 2 must still add nothing and
  // must collapse the legacy duplicates to one copy.
  const store = new FakeStore();
  eq(simulateBoot(store, true), 1, "legacy boot 1 adds one copy (random id)");
  eq(store.list().length, 1, "legacy boot 1 size");
  // Simulate a second legacy boot having doubled the copies first:
  store.create({ ...fam(), id: undefined });
  eq(store.list().length, 2, "legacy duplication present before fix runs");
  eq(simulateBoot(store, false), 0, "fixed boot adds nothing on a legacy profile");
  eq(store.list().length, 1, "fixed boot collapses legacy duplicates to one");
}
{
  // Old loader, for contrast: id-only check + random ids re-add everything.
  const store = new FakeStore();
  eq(simulateBoot(store, true, true), 1, "old boot 1 adds 1");
  eq(simulateBoot(store, true, true), 1, "old boot 2 re-adds 1 (BUG)");
  eq(store.list().length, 2, "old boot 2 size doubled");
}

// ── Loader wiring (source-level, mirrors tests/seed-families.test.cjs) ────
const loaderSrc = fs.readFileSync(
  path.join(root, "src/modules/families/library-loader.ts"), "utf8",
);
ok(/familyStore\.createSeed\(def\)/.test(loaderSrc), "loader inserts via createSeed (catalog id preserved)");
ok(!/familyStore\.create\(def\)/.test(loaderSrc), "loader no longer uses create() for seed families");
ok(/findExistingSeedFamily\(familyStore, entry, def\)/.test(loaderSrc), "loader checks by id + name + signature");
ok(/dedupeSeedCatalogCopies\(familyStore, catalogByName\)/.test(loaderSrc), "loader cleans up legacy duplicates");
ok(/loading = null/.test(loaderSrc), "in-flight guard clears after settle (retryable + re-checks store)");
const storeSrc = fs.readFileSync(path.join(root, "src/modules/families/store.ts"), "utf8");
ok(/createSeed\(def: FamilyDefinition\)/.test(storeSrc), "store exposes createSeed");
ok(/if \(existing\) return existing;/.test(storeSrc), "createSeed returns the existing copy instead of overwriting");

console.log(`seed-catalog-dedup: ${n} assertions passed`);
