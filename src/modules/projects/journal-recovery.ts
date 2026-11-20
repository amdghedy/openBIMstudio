/**
 * Boot-time crash recovery — automatic journal replay (#101).
 *
 * Called ONLY from the boot path (`autoReopenLastProject`), and ONLY
 * when a crash marker exists for the project being reopened. A clean
 * boot never reaches this module, so replay can never rewrite a healthy
 * primary record.
 *
 * Order of operations (the hook-point decision — see
 * docs/engineering/JOURNAL-RECOVERY.md):
 *
 *   1. recovery runs BEFORE the project list is consulted and BEFORE
 *      `openProject` hydrates the scene. A crash that lost the primary
 *      write makes the project invisible to `listProjectDocs`, so
 *      recovering after that check would conclude "project not found"
 *      and clear the auto-reopen pointer. `openProject` also refuses a
 *      corrupt primary record outright, so replaying after the open
 *      would be too late on both counts.
 *   2. the journal is replayed with the validated core
 *      (`journal-replay.ts`); a corrupt tail is quarantined, never
 *      silently dropped, and the partial state is reported honestly.
 *   3. when the replayed document is newer than the primary record
 *      (or the primary record is missing/corrupt), it is written back
 *      with `putProject` — which journals the recovered state itself
 *      and snapshots the previous primary record as a "project-save"
 *      checkpoint first, so a bad recovery is itself reversible.
 *   4. the outcome is recorded in localStorage (`obs.recovery.last`)
 *      for the banner and for tests, and the crash marker is cleared:
 *      the crash has been triaged. The ONE exception is a failed
 *      restore write — then the marker stays so the next boot retries.
 *
 * This function never throws: a failed journal read, a failed
 * quarantine, or a failed restore write is recorded in the outcome and
 * boot continues with the primary record (or the welcome screen).
 * Boot must never fail because recovery failed.
 */
import { replayJournalOps, type JournalReplayResult } from "./journal-replay";
import {
  loadProjectJournalRaw,
  quarantineProjectJournalOps,
} from "./indexeddb-journal";
import { loadProjectDoc, putProject } from "./store";
import { clearCrashMarker } from "./persistence";
import type { ProjectDoc } from "./types";

/** localStorage key for the last crash-recovery outcome (summary only — never the document). */
export const RECOVERY_OUTCOME_KEY = "obs.recovery.last";

export type RecoveryPrimaryState = "current" | "behind" | "missing" | "corrupt";
export type RecoveryRestoredFrom = "journal" | "primary" | "none";

/** Everything the banner, the log, and the tests need — no document, no raw payloads. */
export interface CrashRecoverySummary {
  projectId: string;
  at: number;
  status: JournalReplayResult["status"];
  appliedSeqs: number[];
  lastAppliedSeq: number | null;
  stoppedAtSeq: number | null;
  stoppedReason: string | null;
  snapshotCorrupt: boolean;
  seqGaps: number[];
  quarantined: Array<{ seq: number; kind: string; reason: string }>;
  unreplayed: Array<{ seq: number; kind: string; reason: string }>;
  primaryState: RecoveryPrimaryState;
  primaryUpdatedAt: number | null;
  journalAbsent: boolean;
  restored: boolean;
  restoredFrom: RecoveryRestoredFrom;
  /** The journal says the project was deleted before the crash: do not auto-reopen it. */
  suppressReopen: boolean;
  /** The restore write failed (or the journal could not be read): the crash marker was left in place. */
  error?: string;
}

export interface CrashRecoveryOutcome extends CrashRecoverySummary {
  /** The recovered document, when one exists (null when deleted / nothing usable). */
  doc: ProjectDoc | null;
}

function toSummary(outcome: CrashRecoveryOutcome): CrashRecoverySummary {
  const { doc: _doc, ...summary } = outcome;
  return summary;
}

function recordOutcome(summary: CrashRecoverySummary): void {
  try {
    localStorage.setItem(RECOVERY_OUTCOME_KEY, JSON.stringify(summary));
  } catch { /* private mode / quota — the banner still shows the in-memory outcome */ }
}

export function readLastRecoveryOutcome(): CrashRecoverySummary | null {
  try {
    const raw = localStorage.getItem(RECOVERY_OUTCOME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CrashRecoverySummary>;
    if (!parsed || typeof parsed.projectId !== "string" || !parsed.status) return null;
    return parsed as CrashRecoverySummary;
  } catch {
    return null;
  }
}

export async function recoverCrashedProject(projectId: string): Promise<CrashRecoveryOutcome> {
  const at = Date.now();
  const base: Omit<CrashRecoveryOutcome, "status" | "doc"> = {
    projectId, at,
    appliedSeqs: [], lastAppliedSeq: null,
    stoppedAtSeq: null, stoppedReason: null,
    snapshotCorrupt: false, seqGaps: [],
    quarantined: [], unreplayed: [],
    primaryState: "missing", primaryUpdatedAt: null,
    journalAbsent: false, restored: false, restoredFrom: "none",
    suppressReopen: false,
  };

  // ── primary record: the last known-good baseline ──────────────────────
  let primary: ProjectDoc | null = null;
  try {
    const load = await loadProjectDoc(projectId);
    if (load.loaded) {
      primary = load.doc;
      base.primaryState = "current";
      base.primaryUpdatedAt = load.doc.updatedAt ?? null;
    } else if (load.fatal === "Project not found.") {
      base.primaryState = "missing";
    } else {
      base.primaryState = "corrupt";
      console.error("[journal-recovery] primary record is corrupt; journal is the only source", projectId, load.fatal, load.issues);
    }
  } catch (error) {
    base.primaryState = "corrupt";
    console.error("[journal-recovery] could not read the primary record", projectId, error);
  }

  // ── journal replay (validated; never Journal.open's blind apply) ──────
  let replay: JournalReplayResult;
  try {
    const raw = await loadProjectJournalRaw(projectId);
    base.journalAbsent = !raw.snapshot && raw.ops.length === 0;
    replay = replayJournalOps(projectId, raw.snapshot, raw.ops);
    base.appliedSeqs = replay.appliedSeqs;
    base.lastAppliedSeq = replay.lastAppliedSeq;
    base.stoppedAtSeq = replay.stoppedAtSeq;
    base.stoppedReason = replay.stoppedReason;
    base.snapshotCorrupt = replay.snapshotCorrupt;
    base.seqGaps = replay.seqGaps;
    base.quarantined = replay.quarantined.map(({ seq, kind, reason }) => ({ seq, kind, reason }));
    base.unreplayed = replay.unreplayed;
    if (replay.quarantined.length) {
      try {
        await quarantineProjectJournalOps(projectId, replay.quarantined);
        console.warn(
          `[journal-recovery] replay stopped at entry #${replay.stoppedAtSeq} (${replay.stoppedReason}); ` +
          `${replay.quarantined.length} entr(ies) quarantined, state recovered up to entry #${replay.lastAppliedSeq ?? "none"}`,
        );
      } catch (error) {
        // The evidence stays in the live op store: the next crash boot retries the quarantine.
        base.error = `quarantine failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error("[journal-recovery] quarantine failed; corrupt tail left in the op store", error);
      }
    }
  } catch (error) {
    // The journal could not be read at all: fall back to the primary record, do not block boot.
    const outcome: CrashRecoveryOutcome = {
      ...base, status: "empty", doc: primary,
      restored: false,
      restoredFrom: primary ? "primary" : "none",
      error: `journal read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
    console.error("[journal-recovery] journal unreadable; falling back to the primary record", error);
    // Deliberately NOT clearing the crash marker here: the crash was not
    // triaged (the journal could not even be read), so the next boot
    // retries instead of silently treating the crash as handled.
    recordOutcome(toSummary(outcome));
    return outcome;
  }

  // ── decide what the primary store should hold ─────────────────────────
  const outcome: CrashRecoveryOutcome = { ...base, status: replay.status, doc: replay.doc };

  if (replay.status === "deleted") {
    // The journal records an intentional deletion. Never resurrect the
    // project — and do not auto-reopen a stale primary copy left behind
    // by a crash mid-delete. The record stays on disk for a manual
    // open / checkpoint restore; boot simply does not reopen it.
    outcome.suppressReopen = true;
    outcome.restoredFrom = primary ? "primary" : "none";
    console.warn("[journal-recovery] journal ends with a deletion; not auto-reopening", projectId);
  } else if (replay.doc) {
    const primaryMissingOrCorrupt = !primary || base.primaryState === "corrupt";
    const journalAhead = !!primary && (replay.doc.updatedAt ?? 0) > (primary.updatedAt ?? 0);
    const sameStampDifferentBytes = !!primary
      && (replay.doc.updatedAt ?? 0) === (primary.updatedAt ?? 0)
      && JSON.stringify(replay.doc) !== JSON.stringify(primary);
    if (primaryMissingOrCorrupt || journalAhead || sameStampDifferentBytes) {
      base.primaryState = primaryMissingOrCorrupt ? base.primaryState : "behind";
      try {
        await putProject(replay.doc);
        outcome.restored = true;
        outcome.restoredFrom = "journal";
        outcome.primaryUpdatedAt = replay.doc.updatedAt ?? null;
        console.log(
          `[journal-recovery] restored project ${projectId} from the journal ` +
          `(replayed ${replay.appliedSeqs.length} entr(ies) up to #${replay.lastAppliedSeq}; ` +
          `previous primary state kept as a checkpoint)`,
        );
      } catch (error) {
        // The restore write failed: keep the crash marker so the next boot retries.
        outcome.error = `restore write failed: ${error instanceof Error ? error.message : String(error)}`;
        outcome.restoredFrom = primary ? "primary" : "none";
        console.error("[journal-recovery] restore write failed; crash marker kept for retry", error);
        recordOutcome(toSummary(outcome));
        return outcome;
      }
    } else {
      outcome.restoredFrom = "primary";
    }
  } else {
    // Nothing usable in the journal (empty, or partial with no good entry): the primary record stands.
    outcome.restoredFrom = primary ? "primary" : "none";
  }

  // Triage is complete: clear the crash marker so the next boot is clean.
  // (The outcome stays in obs.recovery.last for the banner and for tests.)
  clearCrashMarker();
  recordOutcome(toSummary(outcome));
  return outcome;
}
