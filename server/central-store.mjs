/**
 * Durable store for one central-model room.
 *
 * Layout under <dataDir>/central/<roomId>/:
 *   snapshot.json   — full room state (atomic write via writeJsonWithBackup:
 *                     fsync + rename + backup rotation, the same machinery
 *                     #244 proved for projects/rooms.json).
 *   journal.jsonl   — append-only transaction journal, one JSON object per
 *                     line, fsynced on every append BEFORE the caller acks
 *                     the client. Retained window: last MAX_JOURNAL_ENTRIES
 *                     entries; older entries are compacted away once a
 *                     snapshot covers them (clients that fell behind the
 *                     window re-sync from the full state instead).
 *   audit.jsonl     — append-only audit trail (accepted AND rejected
 *                     actions, with actor + sequence + timestamp). Never
 *                     compacted.
 *
 * Crash safety: commit order is (1) append journal entry + fsync,
 * (2) apply effects in memory, (3) rewrite snapshot (fsync + rename),
 * (4) ack. A crash between (1) and (3) leaves a journal tail ahead of the
 * snapshot; `load()` replays that tail with the same `applyEffects` the
 * live path uses, so no committed op is lost and no op is applied twice
 * (effects are idempotent writes of recorded values).
 */
import fs from "node:fs";
import path from "node:path";
import { emptyState, applyEffects, MAX_JOURNAL_ENTRIES } from "./central-model.mjs";
import { writeJsonWithBackup, readJsonWithRecovery } from "./backup.mjs";

/** Retained journal window. Tunable for tests via OBS_CENTRAL_JOURNAL_MAX. */
export const JOURNAL_MAX = Math.max(
  1,
  Number(process.env.OBS_CENTRAL_JOURNAL_MAX || MAX_JOURNAL_ENTRIES) || MAX_JOURNAL_ENTRIES,
);

function roomDir(dataDir, roomId) {
  return path.join(dataDir, "central", roomId);
}

function appendLineSync(file, obj) {
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, JSON.stringify(obj) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // A torn final line (crash mid-append) is skipped: the entry was
      // never fsynced, so it was never acked and the client will retry
      // with the same opId. Earlier lines are intact.
    }
  }
  return out;
}

export class CentralStore {
  constructor(dataDir, roomId) {
    this.dataDir = dataDir;
    this.roomId = roomId;
    this.dir = roomDir(dataDir, roomId);
    this.snapshotFile = path.join(this.dir, "snapshot.json");
    this.journalFile = path.join(this.dir, "journal.jsonl");
    this.auditFile = path.join(this.dir, "audit.jsonl");
    fs.mkdirSync(this.dir, { recursive: true });
    const loaded = this.load();
    this.state = loaded.state;
    this.entries = loaded.entries; // retained journal entries, ascending seq
    this.recoveredFrom = loaded.recoveredFrom;
  }

  load() {
    let state;
    let recoveredFrom = "snapshot";
    if (fs.existsSync(this.snapshotFile)) {
      const r = readJsonWithRecovery(this.snapshotFile, null);
      if (r.value) {
        state = r.value;
        if (r.source !== "file") recoveredFrom = `snapshot-${r.source}`;
      }
    }
    if (!state) {
      state = emptyState(this.roomId);
      recoveredFrom = "fresh";
    }
    const entries = readJsonl(this.journalFile)
      .filter((e) => e && typeof e.seq === "number")
      .sort((a, b) => a.seq - b.seq);
    // Replay the journal tail ahead of the snapshot (crash window).
    let replayed = 0;
    for (const e of entries) {
      if (e.seq > state.revision) {
        applyEffects(state, e.effects || []);
        state.revision = e.seq;
        replayed++;
      }
    }
    // Rebuild the opId dedupe window from retained entries.
    state.opIds = entries.map((e) => e.opId).filter(Boolean);
    return { state, entries, recoveredFrom, replayed };
  }

  /** Append the journal entry (fsync), apply its effects, rewrite the snapshot. */
  commit(entry) {
    appendLineSync(this.journalFile, entry);
    this.entries.push(entry);
    applyEffects(this.state, entry.effects || []);
    this.state.revision = entry.seq;
    // Rebuild dedupe window incrementally.
    if (entry.opId && !this.state.opIds.includes(entry.opId)) this.state.opIds.push(entry.opId);
    this.writeSnapshot();
    this.compactIfNeeded();
    return entry;
  }

  writeSnapshot() {
    writeJsonWithBackup(this.snapshotFile, this.state);
  }

  compactIfNeeded() {
    if (this.entries.length <= JOURNAL_MAX) return;
    const keep = this.entries.slice(-JOURNAL_MAX);
    const tmp = `${this.journalFile}.tmp`;
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const fd = fs.openSync(tmp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.journalFile);
    this.entries = keep;
    this.state.opIds = keep.map((e) => e.opId).filter(Boolean);
  }

  audit(action, detail) {
    const rec = { at: new Date().toISOString(), room: this.roomId, action, ...detail };
    try {
      appendLineSync(this.auditFile, rec);
    } catch {
      // Audit failure must not fail the user operation.
    }
    return rec;
  }

  readAudit(limit = 200) {
    const all = readJsonl(this.auditFile);
    return all.slice(-Math.max(1, limit));
  }

  /** Entries with seq > `since`, ascending. Also reports the oldest retained seq. */
  entriesSince(since) {
    const list = this.entries.filter((e) => e.seq > since);
    return {
      entries: list,
      oldestRetainedSeq: this.entries.length ? this.entries[0].seq : this.state.revision,
      truncated: this.entries.length > 0 && since < this.entries[0].seq - 1,
    };
  }

  /** Public serialisation for API responses (strips internal bookkeeping). */
  publicEntry(e) {
    const { effects, prev, ...rest } = e;
    return rest;
  }
}
