// tests/family-gallery.test.cjs
//
// new.family parity Phase 1, Item 1 — Family Gallery.
//
// The Gallery shows the REAL family store as cards with search, group /
// category / hosting filters, sort and Show-more pagination, plus a
// local-only upvote per family. This suite pins the pure logic in
// `src/modules/families/gallery.ts` (no runtime imports, so it compiles
// standalone) and the wiring by source.
//
// Honesty rules pinned here:
// - Hosting is derived (door/window = Wall, else Unhosted); no Face /
//   Ceiling / Floor hosting is claimed.
// - "Ready" = geometry + >=1 type (placeable in openBIMstudio); it is
//   NOT a Revit / .rfa claim.
// - Sort offers only computable fields (name / group / type count /
//   parameter count) — no Featured / Top / Most-downloaded, because no
//   download counts or creation dates exist in the store.
// - Upvotes are local only (1 when this browser upvoted, else 0).
//
// Run: node tests/family-gallery.test.cjs
// CI:  test:family-gallery (package.json + scripts/ci-unit-tests.mjs)

const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);

const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".gallery-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc src/modules/families/gallery.ts"
  + " --outDir " + JSON.stringify(tmpOut)
  + " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck",
  { cwd: root, stdio: "inherit", shell: true },
);
const find = (name) => {
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (f.name === name) return p;
    }
    return null;
  };
  return walk(tmpOut);
};
const g = require(find("gallery.js"));
const {
  deriveHosting, galleryStatus, galleryMatchesQuery, filterGalleryFamilies,
  sortGalleryFamilies, paginateGalleryFamilies, createGalleryUpvotes,
  GALLERY_PAGE_SIZE, GALLERY_UPVOTES_KEY, EMPTY_GALLERY_FILTERS,
} = g;

// ── Fixtures ────────────────────────────────────────────────────────────────
function fam(over) {
  return {
    id: "seed-door-001",
    name: "Single Flush Door",
    category: "door",
    ifcEntity: "IfcDoor",
    group: "Doors",
    origin: "seed-catalog",
    parameters: [
      { name: "width", type: "length", scope: "type", default: 0.9, editable: true },
      { name: "height", type: "length", scope: "type", default: 2.1, editable: true },
    ],
    geometry: { kind: "box", w: { ref: "width" }, d: { const: 0.04 }, h: { ref: "height" } },
    types: [
      { id: "t1", name: "800 x 2100", values: {} },
      { id: "t2", name: "900 x 2100", values: {} },
    ],
    schemaVersion: 1,
    builtIn: false,
    ...over,
  };
}
const door = fam();
const windowFam = fam({
  id: "seed-window-001", name: "Casement Window", category: "window",
  ifcEntity: "IfcWindow", group: "Windows",
  types: [{ id: "t1", name: "1200 x 1500", values: {} }],
});
const chair = fam({
  id: "seed-furn-001", name: "Office Chair", category: "generic",
  ifcEntity: "IfcFurnishingElement", group: "Furniture",
  parameters: [{ name: "seatHeight", type: "length", scope: "type", default: 0.45, editable: true }],
  types: [
    { id: "t1", name: "Standard", values: {} },
    { id: "t2", name: "Tall", values: {} },
    { id: "t3", name: "Wide", values: {} },
  ],
});
// A user family sketched without types yet: a Draft, not Ready.
const draft = fam({
  id: "user-draft-001", name: "Unfinished Shelf", category: "generic",
  ifcEntity: "IfcFurnishingElement", group: "Furniture", origin: undefined,
  types: [],
});
const all = [door, windowFam, chair, draft];

// ── Hosting (derived, never stored) ─────────────────────────────────────────
eq(deriveHosting(door), "Wall", "door hosts on a wall");
eq(deriveHosting(windowFam), "Wall", "window hosts on a wall");
eq(deriveHosting(chair), "Unhosted", "furniture is unhosted");
eq(deriveHosting(draft), "Unhosted", "generic draft is unhosted");

// ── Status (placeable here, NOT a Revit claim) ──────────────────────────────
eq(galleryStatus(door), "Ready", "door with geometry + types is Ready");
eq(galleryStatus(draft), "Draft", "family with no types is a Draft");
eq(
  galleryStatus(fam({ types: [{ id: "t", name: "T", values: {} }], geometry: {} })),
  "Draft",
  "family with no geometry kind is a Draft",
);

// ── Query ───────────────────────────────────────────────────────────────────
ok(galleryMatchesQuery(door, ""), "empty query matches");
ok(galleryMatchesQuery(door, "flush"), "name matches");
ok(galleryMatchesQuery(door, "DOORS"), "group matches, case-insensitive");
ok(galleryMatchesQuery(door, "ifcdoor"), "IFC entity matches");
ok(galleryMatchesQuery(door, "900 x 2100"), "type name matches");
ok(!galleryMatchesQuery(door, "chair"), "unrelated query does not match");

// ── Filters ─────────────────────────────────────────────────────────────────
eq(filterGalleryFamilies(all, EMPTY_GALLERY_FILTERS).length, 4, "no filter passes all");
eq(
  filterGalleryFamilies(all, { ...EMPTY_GALLERY_FILTERS, query: "chair" }).map((f) => f.id),
  ["seed-furn-001"],
  "query filter narrows to the chair",
);
eq(
  filterGalleryFamilies(all, { ...EMPTY_GALLERY_FILTERS, group: "Doors" }).map((f) => f.id),
  ["seed-door-001"],
  "group filter narrows to Doors",
);
eq(
  filterGalleryFamilies(all, { ...EMPTY_GALLERY_FILTERS, category: "window" }).map((f) => f.id),
  ["seed-window-001"],
  "category filter narrows to windows",
);
eq(
  filterGalleryFamilies(all, { ...EMPTY_GALLERY_FILTERS, hosting: "Wall" }).map((f) => f.id),
  ["seed-door-001", "seed-window-001"],
  "hosting filter keeps wall-hosted families",
);
eq(
  filterGalleryFamilies(all, { ...EMPTY_GALLERY_FILTERS, hosting: "Unhosted" }).map((f) => f.id),
  ["seed-furn-001", "user-draft-001"],
  "hosting filter keeps unhosted families",
);
eq(
  filterGalleryFamilies(all, { ...EMPTY_GALLERY_FILTERS, readyOnly: true }).map((f) => f.id),
  ["seed-door-001", "seed-window-001", "seed-furn-001"],
  "ready-only drops the Draft",
);
eq(
  filterGalleryFamilies(all, { ...EMPTY_GALLERY_FILTERS, query: "door", hosting: "Unhosted" }).length,
  0,
  "combined filters intersect",
);

// ── Sort (only computable fields) ───────────────────────────────────────────
eq(
  sortGalleryFamilies(all, "name").map((f) => f.name),
  ["Casement Window", "Office Chair", "Single Flush Door", "Unfinished Shelf"],
  "name sort is A-Z",
);
eq(
  sortGalleryFamilies(all, "group").map((f) => f.name),
  ["Single Flush Door", "Office Chair", "Unfinished Shelf", "Casement Window"],
  "group sort groups, ties by name",
);
eq(
  sortGalleryFamilies(all, "types").map((f) => f.name),
  ["Office Chair", "Single Flush Door", "Casement Window", "Unfinished Shelf"],
  "types sort is most-types first, ties by name",
);
eq(
  sortGalleryFamilies(all, "parameters").map((f) => f.name),
  ["Casement Window", "Single Flush Door", "Unfinished Shelf", "Office Chair"],
  "parameters sort is most-parameters first, ties by name (draft keeps the 2 default params)",
);
{
  const before = all.map((f) => f.id);
  sortGalleryFamilies(all, "types");
  eq(all.map((f) => f.id), before, "sort does not mutate its input");
  const filtered = filterGalleryFamilies(all, EMPTY_GALLERY_FILTERS);
  ok(filtered !== all, "filter returns a new array");
}

// ── Pagination ──────────────────────────────────────────────────────────────
eq(GALLERY_PAGE_SIZE, 12, "page size is 12 cards");
{
  const p1 = paginateGalleryFamilies(all, 12);
  eq(p1.shown.length, 4, "short lists show everything");
  eq(p1.total, 4, "total counts the filtered list");
  ok(!p1.hasMore, "no more pages when everything fits");
  const big = Array.from({ length: 30 }, (_, i) => fam({ id: `f-${i}`, name: `Fam ${i}` }));
  const p2 = paginateGalleryFamilies(big, 12);
  eq(p2.shown.length, 12, "first page shows 12");
  ok(p2.hasMore, "more pages remain");
  const p3 = paginateGalleryFamilies(big, 24);
  eq(p3.shown.length, 24, "second page shows 24 total");
  ok(p3.hasMore, "a third page remains");
  eq(paginateGalleryFamilies(big, 30).hasMore, false, "exact fit has no more pages");
  eq(paginateGalleryFamilies(big, 0).shown.length, 0, "zero visible shows nothing");
}

// ── Upvotes (local only) ────────────────────────────────────────────────────
{
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, v); },
  };
  const votes = createGalleryUpvotes(storage);
  ok(!votes.isUpvoted("seed-door-001"), "not upvoted initially");
  eq(votes.count("seed-door-001"), 0, "local count starts at 0, not a community total");
  eq(votes.toggle("seed-door-001"), true, "first toggle upvotes");
  ok(votes.isUpvoted("seed-door-001"), "upvoted after toggle");
  eq(votes.count("seed-door-001"), 1, "local count is 1 after upvote");
  eq(votes.toggle("seed-door-001"), false, "second toggle removes the upvote");
  eq(votes.count("seed-door-001"), 0, "count returns to 0");
  votes.toggle("seed-door-001");
  votes.toggle("seed-furn-001");
  eq(votes.list(), ["seed-door-001", "seed-furn-001"], "upvoted ids listed in order");
  eq(
    JSON.parse(mem.get(GALLERY_UPVOTES_KEY)),
    ["seed-door-001", "seed-furn-001"],
    "upvotes persist as an id list under the gallery key",
  );
  // A fresh store over the same storage sees the persisted upvotes.
  const votes2 = createGalleryUpvotes(storage);
  ok(votes2.isUpvoted("seed-door-001"), "upvotes survive a reload of the store");
  // Corrupt storage resets to empty instead of throwing.
  mem.set(GALLERY_UPVOTES_KEY, "{not json");
  const votes3 = createGalleryUpvotes(storage);
  eq(votes3.list(), [], "corrupt upvote storage resets to empty");
  ok(votes3.toggle("seed-door-001"), "toggle still works after corrupt storage");
}

// ── Wiring by source ────────────────────────────────────────────────────────
const galleryUi = fs.readFileSync(
  path.join(root, "src/features/family-gallery.ts"), "utf8",
);
ok(galleryUi.includes("openFamilyBrowserWithFamily"), "gallery opens a family in the browser");
ok(galleryUi.includes("family.gallery"), "gallery registers a command-palette entry");
ok(galleryUi.includes("__obsFamilyGallery"), "gallery exposes a window API for tests/automation");
ok(galleryUi.includes("not a Revit .rfa"), "Ready badge says it is not a Revit .rfa");
ok(!galleryUi.includes("Most downloaded"), "gallery offers no fake Most-downloaded sort");
ok(!galleryUi.includes("Featured"), "gallery offers no fake Featured sort");
const browserSrc = fs.readFileSync(
  path.join(root, "src/features/family-browser.ts"), "utf8",
);
ok(
  browserSrc.includes("openFamilyBrowserWithFamily"),
  "browser exports the gallery deep-link entry point",
);
ok(browserSrc.includes("Gallery"), "browser header links to the gallery");
const mainSrc = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
ok(mainSrc.includes("setupFamilyGallery"), "gallery is wired into the app boot");

console.log(`family-gallery: ${n} assertions passed`);
