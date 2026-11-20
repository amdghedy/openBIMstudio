/**
 * Automatic journal replay — the validated core of crash recovery (#101).
 *
 * The operation journal (`projectOps`, written by `indexeddb-journal.ts`)
 * is the only browser-side record that is written BEFORE the primary
 * project record: `store.putProject()` appends the full document as a
 * `replace-state` op and only then writes the `projects` record. A crash
 * in that window — or a primary record that later turns out corrupt —
 * leaves the journal ahead of the primary store. On the next boot after
 * a crash marker is found, this replay rebuilds the newest journaled
 * state and the caller writes it back to the primary store.
 *
 * Rules (all enforced here, all unit-tested in tests/journal-replay.test.cjs):
 *
 *   - Replay runs ONLY when the caller says a crash happened. A clean
 *     boot never calls this module, so a journal that is ahead of the
 *     primary store is left alone unless the previous session crashed.
 *   - Entries apply in `seq` order onto the newest snapshot. A
 *     `replace-state` entry replaces the whole document; a `delete`
 *     entry means the project was intentionally deleted, so replay
 *     yields `null` and recovery must NOT resurrect it.
 *   - Every applied `replace-state` payload must normalize to a
 *     `ProjectDoc` for THIS project (`normalizeProjectDoc` + id match).
 *     The journal is untrusted input — a torn or hand-edited entry must
 *     never become the live document.
 *   - The first entry that cannot be applied STOPS the replay. That
 *     entry and every later entry (the tail) are reported as
 *     quarantined/unreplayed with reasons — never silently dropped,
 *     never skipped over in the hope a later entry is fine. The state
 *     up to the last good entry is still returned (partial recovery),
 *     and the caller must surface that it was partial.
 *   - Entry kinds with no replay semantics stop the replay too. Nothing
 *     is invented for an unknown kind.
 *   - A corrupt snapshot does not poison the ops: the snapshot is
 *     discarded, replay starts from empty over ALL ops, and the
 *     corruption is reported. A missing sequence number (gap) is
 *     tolerated — `replace-state` entries are whole documents, so a
 *     later full state still supersedes — but the gap is recorded.
 *     A sequence that goes backwards or repeats stops the replay:
 *     out-of-order application is unsound.
 *   - Replay is a pure function of (snapshot, ops): replaying the same
 *     journal twice yields the same document, and replaying a journal
 *     that already contains a recovery's own re-appended entry yields
 *     the same document. That is the idempotency the browser spec
 *     proves end to end.
 *
 * This module is pure and dependency-free (apart from the pure schema
 * normalizer) so the unit tests can compile it standalone, exactly like
 * `core/journal.ts` and `project-schema.ts`.
 */
import { normalizeProjectDoc } from "./project-schema";
import type { ProjectDoc } from "./types";

/** One journal entry as read back from the `projectOps` store. */
export interface ReplayJournalOp {
  seq: number;
  kind: string;
  payload: unknown;
}

/** A journal snapshot as read back from the `projectOperationSnapshots` store. */
export interface ReplaySnapshot {
  seq: number;
  state: string;
}

/** One entry of the quarantined tail: the entry that stopped the replay, or an entry after it. */
export interface QuarantinedOp {
  seq: number;
  kind: string;
  /** Why this entry was not applied (the stop reason for the first, "not reached" for the rest). */
  reason: string;
  /** The raw entry payload, kept so the quarantine record preserves the evidence. */
  raw: unknown;
}

/** The tail, summarized for the banner and the recovery log. */
export interface UnreplayedOp {
  seq: number;
  kind: string;
  reason: string;
}

export type JournalReplayStatus =
  | "full" // every entry applied; a document was recovered
  | "partial" // stopped early; the document below is the last good state (or null when nothing was good)
  | "empty" // no snapshot and no entries — nothing to replay
  | "deleted"; // replayed fully and the last entry deletes the project

export interface JournalReplayResult {
  status: JournalReplayStatus;
  /** The recovered document, or null when deleted / nothing usable was found. */
  doc: ProjectDoc | null;
  /** Snapshot seq replay started from (0 when there was no usable snapshot). */
  baseSeq: number;
  /** Seq values applied, in order. */
  appliedSeqs: number[];
  lastAppliedSeq: number | null;
  stoppedAtSeq: number | null;
  stoppedReason: string | null;
  /** The snapshot existed but could not be parsed/normalized; replay started from empty instead. */
  snapshotCorrupt: boolean;
  /** Missing seq values that were skipped over (tolerated, recorded). */
  seqGaps: number[];
  /** The stopped-at entry plus every later entry, in order. Empty unless stopped. */
  quarantined: QuarantinedOp[];
  /** Same tail as `quarantined`, without the raw payloads (for the banner / log). */
  unreplayed: UnreplayedOp[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replay `allOps` (every op for the project, any order) onto `snapshot`.
 * Pure: same inputs always yield the same result, with no side effects.
 */
export function replayJournalOps(
  projectId: string,
  snapshot: ReplaySnapshot | null,
  allOps: readonly ReplayJournalOp[],
): JournalReplayResult {
  const ops = [...allOps].sort((a, b) => a.seq - b.seq);
  let doc: ProjectDoc | null = null;
  let baseSeq = 0;
  let snapshotCorrupt = false;

  if (snapshot) {
    try {
      const parsed = normalizeProjectDoc(JSON.parse(snapshot.state) as unknown);
      if (parsed.ok && parsed.doc.id === projectId) {
        doc = parsed.doc;
        baseSeq = snapshot.seq;
      } else {
        snapshotCorrupt = true;
      }
    } catch {
      snapshotCorrupt = true;
    }
  }
  if (snapshotCorrupt) {
    // A corrupt snapshot must not poison the ops: replay everything from empty.
    doc = null;
    baseSeq = 0;
  }

  const appliedSeqs: number[] = [];
  const seqGaps: number[] = [];
  let expectedSeq = baseSeq + 1;
  let stoppedAtSeq: number | null = null;
  let stoppedReason: string | null = null;
  let stopIndex = -1;

  const pending = ops.filter((op) => op.seq > baseSeq);
  for (let i = 0; i < pending.length; i++) {
    const op = pending[i];
    if (!Number.isSafeInteger(op.seq)) {
      stoppedAtSeq = typeof op.seq === "number" ? op.seq : -1;
      stoppedReason = `journal entry has no usable sequence number — replay stopped`;
      stopIndex = i; break;
    }
    if (op.seq < expectedSeq) {
      stoppedAtSeq = op.seq;
      stoppedReason = `journal sequence went backwards or repeated (seq ${op.seq} after ${expectedSeq - 1}) — replay stopped, entries are not applied out of order`;
      stopIndex = i; break;
    }
    if (op.seq > expectedSeq) {
      for (let missing = expectedSeq; missing < op.seq; missing++) seqGaps.push(missing);
    }
    if (typeof op.kind !== "string" || !op.kind) {
      stoppedAtSeq = op.seq;
      stoppedReason = `journal entry #${op.seq} has no usable kind — replay stopped`;
      stopIndex = i; break;
    }
    if (op.kind === "delete") {
      // Intentional deletion: the project must not be resurrected.
      doc = null;
      appliedSeqs.push(op.seq);
      expectedSeq = op.seq + 1;
      continue;
    }
    if (op.kind !== "replace-state") {
      stoppedAtSeq = op.seq;
      stoppedReason = `journal entry #${op.seq} has unknown kind "${op.kind}" — no replay semantics exist for it, replay stopped`;
      stopIndex = i; break;
    }
    if (!isRecord(op.payload)) {
      stoppedAtSeq = op.seq;
      stoppedReason = `journal entry #${op.seq} ("replace-state") has no document payload — replay stopped`;
      stopIndex = i; break;
    }
    const parsed = normalizeProjectDoc(op.payload);
    if (!parsed.ok) {
      stoppedAtSeq = op.seq;
      stoppedReason = `journal entry #${op.seq} ("replace-state") is not a usable project document (${parsed.fatal}) — replay stopped`;
      stopIndex = i; break;
    }
    if (parsed.doc.id !== projectId) {
      stoppedAtSeq = op.seq;
      stoppedReason = `journal entry #${op.seq} ("replace-state") belongs to project "${parsed.doc.id}", not "${projectId}" — replay stopped`;
      stopIndex = i; break;
    }
    doc = parsed.doc;
    appliedSeqs.push(op.seq);
    expectedSeq = op.seq + 1;
  }

  const lastAppliedSeq = appliedSeqs.length ? appliedSeqs[appliedSeqs.length - 1] : null;
  const quarantined: QuarantinedOp[] = [];
  const unreplayed: UnreplayedOp[] = [];
  if (stoppedAtSeq !== null && stopIndex >= 0) {
    for (let i = stopIndex; i < pending.length; i++) {
      const op = pending[i];
      const reason = i === stopIndex
        ? (stoppedReason ?? "replay stopped")
        : `not reached — replay stopped at entry #${stoppedAtSeq}`;
      quarantined.push({ seq: op.seq, kind: typeof op.kind === "string" ? op.kind : String(op.kind), reason, raw: op.payload });
      unreplayed.push({ seq: op.seq, kind: typeof op.kind === "string" ? op.kind : String(op.kind), reason });
    }
  }

  let status: JournalReplayStatus;
  if (stoppedAtSeq !== null) {
    status = "partial";
  } else if (doc) {
    status = "full";
  } else if (appliedSeqs.length > 0) {
    // Every entry applied and the last one deleted the project.
    status = "deleted";
  } else {
    status = "empty";
  }

  return {
    status, doc, baseSeq, appliedSeqs, lastAppliedSeq,
    stoppedAtSeq, stoppedReason, snapshotCorrupt, seqGaps, quarantined, unreplayed,
  };
}

/** True when replaying `result` a second time over the same journal must yield the same document. */
export function replayIsIdempotent(first: JournalReplayResult, second: JournalReplayResult): boolean {
  // The document and the outcome are what must be stable. The last applied
  // seq legitimately advances when recovery re-appends the recovered
  // document as a new entry — same content, new seq — so it is not compared.
  return JSON.stringify(first.doc ?? null) === JSON.stringify(second.doc ?? null)
    && first.status === second.status;
}
