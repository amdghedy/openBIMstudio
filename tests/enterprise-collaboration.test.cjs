/**
 * Enterprise Collaboration & Model Streaming Unit Tests
 * Run: node tests/enterprise-collaboration.test.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-collab-stream-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type":"commonjs"}');

// Compile the pure modules to CJS
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/collaboration/worksharing-engine.ts src/modules/streaming/spatial-octree.ts src/modules/streaming/memory-budget-manager.ts",
  { cwd: root, stdio: "pipe", shell: true }
);

const { WorksharingEngine } = require(path.join(tmpOut, "modules/collaboration/worksharing-engine.js"));
const { SpatialOctree, createBoundingBox, boxesIntersect } = require(path.join(tmpOut, "modules/streaming/spatial-octree.js"));
const { MemoryBudgetManager } = require(path.join(tmpOut, "modules/streaming/memory-budget-manager.js"));

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log("  PASS", name);
    pass++;
  } catch (e) {
    console.error("  FAIL", name, e.message);
    fail++;
  }
}

console.log("\n=== Enterprise Collaboration & Streaming Tests ===\n");

// --- 1. Worksharing Engine ---
console.log("Worksharing Engine:");

t("initializes default discipline worksets", () => {
  const engine = new WorksharingEngine("user_alice", "Alice");
  const list = engine.getAllWorksets();
  assert(list.length >= 8, `Expected >= 8 default worksets, got ${list.length}`);
  assert(list.some(w => w.name.includes("Architecture")));
  assert(list.some(w => w.name.includes("Structural")));
  assert(list.some(w => w.name.includes("Levels & Grids")));
});

t("assigns element to workset and supports granular borrowing", () => {
  const engine = new WorksharingEngine("user_alice", "Alice");
  const ws = engine.getActiveWorkset();
  assert(engine.assignElement(101, ws.id));
  assert.strictEqual(engine.getWorksetForElement(101)?.id, ws.id);

  // Alice can edit
  assert.strictEqual(engine.canEditElement(101, "user_alice"), true);

  // Alice borrows element 101
  const borrowRes = engine.borrowElement(101, "user_alice");
  assert.strictEqual(borrowRes.success, true);

  // Bob cannot edit or borrow element 101
  assert.strictEqual(engine.canEditElement(101, "user_bob"), false);
  const bobBorrow = engine.borrowElement(101, "user_bob");
  assert.strictEqual(bobBorrow.success, false);
  assert.strictEqual(bobBorrow.owner, "user_alice");
});

t("handles borrow request workflow (request, grant, transfer)", () => {
  const engine = new WorksharingEngine("user_alice", "Alice");
  const ws = engine.getActiveWorkset();
  engine.assignElement(202, ws.id);
  engine.borrowElement(202, "user_alice");

  // Bob requests element 202
  const req = engine.submitBorrowRequest(202, "user_bob");
  assert(req !== null, "Borrow request should be created");
  assert.strictEqual(req.requestedBy, "user_bob");
  assert.strictEqual(req.currentOwner, "user_alice");
  assert.strictEqual(req.status, "pending");

  // Alice checks pending requests
  const pending = engine.getPendingBorrowRequests("user_alice");
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].id, req.id);

  // Alice grants request
  assert.strictEqual(engine.respondToBorrowRequest(req.id, true, "Granted for duct adjustments"), true);
  assert.strictEqual(engine.canEditElement(202, "user_bob"), true);
  assert.strictEqual(engine.canEditElement(202, "user_alice"), false);
});

t("syncs with central, increments revision, and detects 3-way conflicts", () => {
  const engine = new WorksharingEngine("user_alice", "Alice");
  
  // Stage transaction
  engine.stageTransaction({
    addedElements: [{ id: 301, data: { category: "Wall" }, worksetId: "ws-arch" }],
    modifiedElements: [{ id: 302, data: { height: 4000 } }],
    deletedElementIds: [],
    description: "Added exterior wall partition",
  });

  const syncRes = engine.syncWithCentral();
  assert.strictEqual(syncRes.success, true);
  assert.strictEqual(syncRes.syncedRevisions, 1);
  assert.strictEqual(syncRes.conflicts.length, 0);
  assert.strictEqual(engine.getState().centralRevision, 2);
});

t("relinquishes borrowed elements and user-created worksets", () => {
  const engine = new WorksharingEngine("user_alice", "Alice");
  const ws = engine.getActiveWorkset();
  engine.assignElement(401, ws.id);
  engine.borrowElement(401, "user_alice");

  const relRes = engine.relinquish({ borrowedElements: true, userCreatedWorksets: true });
  assert.strictEqual(relRes.relinquishedElements, 1);
  assert.strictEqual(engine.canEditElement(401, "user_bob"), true);
});

// --- 2. Spatial Octree ---
console.log("\nSpatial Octree & 3D Partitioning:");

t("creates bounding box and tests intersection", () => {
  const b1 = createBoundingBox([0, 0, 0], [10, 10, 10]);
  const b2 = createBoundingBox([5, 5, 5], [15, 15, 15]);
  const b3 = createBoundingBox([20, 20, 20], [30, 30, 30]);

  assert.strictEqual(boxesIntersect(b1, b2), true);
  assert.strictEqual(boxesIntersect(b1, b3), false);
});

t("builds hierarchical octree and queries spatial volume", () => {
  const tree = new SpatialOctree(createBoundingBox([-100, -100, -100], [100, 100, 100]), 4, 4);

  for (let i = 0; i < 20; i++) {
    tree.insert({
      id: `elem-${i}`,
      bbox: createBoundingBox([i * 4, 0, 0], [i * 4 + 2, 3, 2]),
      data: { index: i },
    });
  }

  const stats = tree.getStats();
  assert(stats.totalNodes > 1, `Octree should subdivide, total nodes: ${stats.totalNodes}`);
  assert.strictEqual(stats.totalItems, 20);

  // Box query in positive X region [0..15]
  const hits = tree.queryBox(createBoundingBox([0, -1, -1], [15, 5, 5]));
  assert(hits.length >= 3, `Expected at least 3 hits in [0..15], got ${hits.length}`);
});

t("performs frustum plane intersection and culling", () => {
  const tree = new SpatialOctree(createBoundingBox([-100, -100, -100], [100, 100, 100]), 4, 8);
  tree.insert({ id: "inside", bbox: createBoundingBox([10, 10, 10], [12, 12, 12]) });
  tree.insert({ id: "outside", bbox: createBoundingBox([-80, -80, -80], [-70, -70, -70]) });

  // Single half-space clipping plane: normal [1,0,0], distance 0 (X > 0)
  const plane = [{ normal: [1, 0, 0], distance: 0 }];
  const visible = tree.queryFrustum(plane);
  assert(visible.some(item => item.id === "inside"));
  assert(!visible.some(item => item.id === "outside"));
});

// --- 3. Out-of-Core Memory Budget Manager ---
console.log("\nOut-of-Core Memory Budget Manager:");

t("registers model chunks and calculates Screen-Space Error (SSE)", () => {
  const mgr = new MemoryBudgetManager({ maxMemoryMb: 256, sseThresholdPx: 16 });
  mgr.updateCamera([0, 0, 0], 60, 1080);

  mgr.registerChunk({
    id: "chunk-near",
    bbox: createBoundingBox([0, 0, 5], [10, 10, 15]),
    elementCount: 150,
    memoryBytes: 30 * 1024 * 1024, // 30 MB
  });

  mgr.registerChunk({
    id: "chunk-far",
    bbox: createBoundingBox([0, 0, 500], [10, 10, 510]),
    elementCount: 150,
    memoryBytes: 30 * 1024 * 1024, // 30 MB
  });

  const transitions = mgr.evaluateStreaming(new Set(["chunk-near", "chunk-far"]));
  assert(transitions.toLoad.length > 0, "Near chunk should trigger load to high LOD");
});

t("enforces client memory budget by evicting distant chunks", () => {
  const mgr = new MemoryBudgetManager({ maxMemoryMb: 50 }); // 50MB limit
  mgr.updateCamera([0, 0, 0]);

  // Insert two 35MB chunks (total 70MB > 50MB budget)
  mgr.registerChunk({
    id: "near-35mb",
    bbox: createBoundingBox([0, 0, 5], [5, 5, 10]),
    elementCount: 100,
    memoryBytes: 35 * 1024 * 1024,
  });
  mgr.registerChunk({
    id: "distant-35mb",
    bbox: createBoundingBox([0, 0, 300], [5, 5, 305]),
    elementCount: 100,
    memoryBytes: 35 * 1024 * 1024,
  });

  mgr.setChunkResident("near-35mb", true, 0);
  mgr.setChunkResident("distant-35mb", true, 0);

  const budgetRes = mgr.enforceBudget();
  assert.strictEqual(budgetRes.evictedCount, 1, "Should evict 1 chunk to stay within 50MB");
  assert(budgetRes.memoryFreedMb >= 35, "Freed memory should be >= 35MB");

  const metrics = mgr.getMetrics();
  assert(metrics.currentMemoryMb <= 50, `Memory should be <= 50MB, got ${metrics.currentMemoryMb}MB`);
  assert.strictEqual(metrics.residentChunks, 1);
});

console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
