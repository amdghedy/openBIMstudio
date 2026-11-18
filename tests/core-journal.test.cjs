const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-core-journal-"));
execSync(`npx tsc src/core/journal.ts --outDir "${out}" --module commonjs --target ES2022 --moduleResolution node --skipLibCheck --noCheck`, { cwd: root, stdio: "inherit" });
const { Journal } = require(path.join(out, "journal.js"));

class MemoryStore {
  constructor() { this.ops = []; this.snapshots = []; }
  async loadNewestSnapshot() { return this.snapshots.at(-1) ?? null; }
  async opsAfter(seq) { return this.ops.filter((op) => op.seq > seq).sort((a, b) => a.seq - b.seq); }
  async latestSeq() { return this.ops.reduce((max, op) => Math.max(max, op.seq), 0); }
  async appendLine(line) { this.ops.push(JSON.parse(line)); }
  async writeSnapshot(seq, state) { this.snapshots.push({ seq, state }); }
  async compactJournalBefore(seq) { this.ops = this.ops.filter((op) => op.seq > seq); }
}

(async () => {
  const store = new MemoryStore();
  let state = 0;
  const apply = (op) => { if (op.kind === "add") state += op.payload; };
  const serialize = () => String(state);
  const first = await Journal.open(store, apply, serialize);
  await first.append("add", 2);
  await first.append("add", 3);
  assert.equal(state, 5);

  state = 0;
  const reopened = await Journal.open(store, apply, serialize, (snapshot) => { state = Number(snapshot); });
  const op = await reopened.append("add", 4);
  assert.equal(op.seq, 3, "reopen must continue after unsnapshotted operations");
  assert.equal(state, 9, "reopen must replay operations in sequence");

  let snapshotState = 0;
  const snapStore = new MemoryStore();
  snapStore.snapshots.push({ seq: 500, state: "7" });
  const snapJournal = await Journal.open(snapStore, (next) => { snapshotState += next.payload; }, () => String(snapshotState), (snapshot) => { snapshotState = Number(snapshot); });
  assert.equal(snapshotState, 7, "newest snapshot must be restored before replay");
  assert.equal((await snapJournal.append("add", 1)).seq, 501);
  assert.equal(snapStore.snapshots.at(-1)?.seq, 500, "compaction is not premature");

  const compactStore = new MemoryStore();
  let compactState = 0;
  const compact = await Journal.open(compactStore, (next) => { compactState += next.payload; }, () => String(compactState));
  for (let i = 0; i < 500; i++) await compact.append("add", 1);
  assert.equal(compactStore.snapshots.at(-1)?.seq, 500, "500 operations create a snapshot");
  assert.equal(compactStore.ops.length, 0, "snapshot compacts prior operations");
  console.log("PASS core journal sequence recovery, snapshot restore, replay, and compaction");
})().catch((error) => { console.error(error); process.exit(1); });
