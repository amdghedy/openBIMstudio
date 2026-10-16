/**
 * Schedule snapshot diffing.
 *
 * A snapshot captures the current row values for a schedule. Later, after
 * the model has been edited, the user can diff the current run against the
 * snapshot to see added/removed/changed rows.
 */
import type { ScheduleRun, ScheduleSnapshot, ScheduleRow } from "./schedule-types";

const SNAPSHOT_KEY = "obs.schedule.snapshots";

export function takeSnapshot(run: ScheduleRun, label?: string): ScheduleSnapshot {
  const id = (crypto as any).randomUUID?.() ?? `snap-${Date.now()}`;
  const snap: ScheduleSnapshot = {
    id,
    label: label ?? `Snapshot ${new Date().toLocaleString()}`,
    definitionId: run.definition.id,
    takenAt: Date.now(),
    rows: {},
  };
  for (const row of run.rows) {
    if (row.subtotal) continue;
    snap.rows[row.id] = { ...row.values };
  }
  saveSnapshot(snap);
  return snap;
}

export function listSnapshots(definitionId?: string): ScheduleSnapshot[] {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return [];
    const arr: ScheduleSnapshot[] = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const sorted = arr.sort((a, b) => b.takenAt - a.takenAt);
    return definitionId ? sorted.filter((s) => s.definitionId === definitionId) : sorted;
  } catch {
    return [];
  }
}

function saveSnapshot(snap: ScheduleSnapshot): void {
  const list = listSnapshots();
  list.unshift(snap);
  // Keep the most recent 50 per definition + a hard cap of 200 total.
  const trimmed = list.slice(0, 200);
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(trimmed));
  } catch (err) {
    console.warn("[schedule-diff] failed to save snapshot", err);
  }
}

export function deleteSnapshot(id: string): void {
  const list = listSnapshots().filter((s) => s.id !== id);
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(list));
  } catch {
    /* */
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Diff
   ═════════════════════════════════════════════════════════════════════════ */
export interface DiffEntry {
  rowId: string;
  kind: "added" | "removed" | "changed";
  /** For "changed" — which columns differ. */
  changedColumns?: { key: string; before: string | number | null; after: string | number | null }[];
  /** For "added" — the new values. */
  values?: Record<string, string | number | null>;
}

export interface ScheduleDiff {
  definitionId: string;
  snapshotId: string;
  snapshotLabel: string;
  snapshotAt: number;
  currentAt: number;
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  unchanged: number;
}

export function diffAgainstSnapshot(run: ScheduleRun, snap: ScheduleSnapshot): ScheduleDiff {
  const current: Record<string, ScheduleRow> = {};
  for (const row of run.rows) {
    if (row.subtotal) continue;
    current[row.id] = row;
  }

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  let unchanged = 0;

  for (const id of Object.keys(current)) {
    if (!(id in snap.rows)) {
      added.push({ rowId: id, kind: "added", values: { ...current[id].values } });
      continue;
    }
    const before = snap.rows[id];
    const after = current[id].values;
    const diffs: DiffEntry["changedColumns"] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      const b = before[k];
      const a = after[k];
      if (!valuesEqual(b, a)) {
        diffs.push({ key: k, before: b, after: a });
      }
    }
    if (diffs.length) {
      changed.push({ rowId: id, kind: "changed", changedColumns: diffs });
    } else {
      unchanged++;
    }
  }

  for (const id of Object.keys(snap.rows)) {
    if (!(id in current)) {
      removed.push({ rowId: id, kind: "removed", values: snap.rows[id] });
    }
  }

  return {
    definitionId: run.definition.id,
    snapshotId: snap.id,
    snapshotLabel: snap.label,
    snapshotAt: snap.takenAt,
    currentAt: run.generatedAt,
    added,
    removed,
    changed,
    unchanged,
  };
}

function valuesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  // Numeric tolerance
  const na = typeof a === "number" ? a : parseFloat(String(a));
  const nb = typeof b === "number" ? b : parseFloat(String(b));
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    return Math.abs(na - nb) < 1e-6;
  }
  return String(a) === String(b);
}

export function summarizeDiff(diff: ScheduleDiff): string {
  return (
    `+${diff.added.length} added · ` +
    `−${diff.removed.length} removed · ` +
    `~${diff.changed.length} changed · ` +
    `${diff.unchanged} unchanged`
  );
}