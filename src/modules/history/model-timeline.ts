/**
 * Model history / time-travel — browser orchestration (differentiation item 7).
 *
 * A visible timeline of model versions with restore, built on the existing
 * project journal (the last 10 pre-save / pre-import / pre-restore
 * snapshots with archived model payloads). history.ts is undo/redo only —
 * it holds apply/revert closures, not snapshots — so the journal is the
 * version store, and this panel is its timeline face.
 *
 * Versions appear as the app saves (Ctrl+S, autosave every 25 s while
 * dirty, model imports, restores); "Save version" records a named manual
 * version of the live state on demand. A checkpoint records the state
 * BEFORE the save/import/restore, so the timeline always shows the live
 * current state as its first row, then the retained versions newest first,
 * each with what changed to reach it from the previous version.
 *
 * Restore reuses the recovery path exactly (restoreProjectRecoverySnapshot
 * + openProject): the current state is snapshotted first ("before-restore"),
 * so a restore is itself reversible, and the scene reopens through the
 * normal pipeline. Restoring clears the undo/redo stacks (a project
 * transition) — the confirm dialog says so.
 */
import { ctx } from "../../core/context";
import { notify as toast } from "../../core/notify";
import { confirmDialog, promptLine } from "../../features/form-modal";
import { fmtDateTime } from "../../core/region";
import { escapeHtml as esc } from "../../core/html-escape";
import {
  getCurrentProject,
  openProject,
  saveProject,
  listProjectRecoverySnapshots,
  restoreProjectRecoverySnapshot,
} from "../projects/projects";
import { listProjectJournalRecords, recordProjectVersion } from "../projects/store";
import {
  buildVersionRows,
  contentHash,
  diffProjectDocs,
  formatDiff,
  REASON_LABELS,
  type ElementLike,
  type VersionRow,
} from "./model-timeline-core";

type Any = Record<string, any>;

const PANEL_ID = "obs-model-timeline";

function liveElements(): ElementLike[] {
  try {
    const els = (ctx.features as Any).authoring?.getElements?.();
    return Array.isArray(els) ? (els as ElementLike[]) : [];
  } catch {
    return [];
  }
}

export interface TimelineState {
  projectName: string;
  current: {
    elementCount: number;
    modelCount: number;
    diffFromNewest: string;
    matchesVersionId: number | null;
  };
  versions: VersionRow[];
}

/** The timeline data: live current row + retained versions with diffs. */
export async function getTimelineState(): Promise<TimelineState | null> {
  const cur = getCurrentProject();
  if (!cur) return null;
  const [listed, records] = await Promise.all([
    listProjectRecoverySnapshots(),
    listProjectJournalRecords(cur.id),
  ]);
  // The recovery listing returns { snapshots, quarantined } since the
  // checkpoint-quarantine change (rank 4): the timeline shows restorable
  // snapshots only; quarantined checkpoints are never offered as versions.
  const summaries = listed.snapshots;
  const docsById = new Map(records.map((r) => [r.id, r.doc as Any]));
  const versions = buildVersionRows(summaries, docsById);
  const live = { elements: liveElements(), models: ((cur.models ?? []) as unknown as Array<{ id: string; [key: string]: unknown }>) };
  const newest = versions[0];
  const newestDoc = newest ? docsById.get(newest.id) : undefined;
  const diffFromNewest = newestDoc
    ? formatDiff(diffProjectDocs(newestDoc as Any, live))
    : "no earlier version yet";
  let matchesVersionId: number | null = null;
  const liveHash = contentHash(live);
  for (const v of versions) {
    const doc = docsById.get(v.id);
    if (doc && contentHash(doc as Any) === liveHash) { matchesVersionId = v.id; break; }
  }
  return {
    projectName: cur.name,
    current: {
      elementCount: live.elements.length,
      modelCount: live.models.length,
      diffFromNewest,
      matchesVersionId,
    },
    versions,
  };
}

/** Record a named manual version of the live state. */
export async function saveVersion(label?: string): Promise<number | null> {
  const cur = getCurrentProject();
  if (!cur) { toast("warn", "Open or create a project first — versions are recorded per project."); return null; }
  const name = (label ?? (await promptLine("Save a version", "Version name", "")))?.trim() || undefined;
  await saveProject(true); // flush live state, then record the flushed doc
  const doc = getCurrentProject();
  if (!doc) return null;
  const id = await recordProjectVersion(doc, "manual-version", name);
  if (id < 0) { toast("error", "Could not record the version — see the console for details."); return null; }
  toast("success", `Version saved${name ? ` — “${name}”` : ""}.`);
  await refreshPanel();
  return id;
}

/** Restore a version exactly; the scene reopens through the normal pipeline. */
export async function restoreVersion(id: number): Promise<boolean> {
  const cur = getCurrentProject();
  if (!cur) return false;
  const ok = await confirmDialog(
    "Restore this version?",
    "The project will be rolled back to that version's exact state.\n\n" +
      "The CURRENT state is saved as a new version first, so this can be undone — " +
      "but restoring clears the undo/redo stacks.",
  );
  if (!ok) return false;
  try {
    const result = await restoreProjectRecoverySnapshot(id);
    if (!result.restored) {
      toast("error", "Version could not be restored (no longer retained).");
      return false;
    }
    const missing = result.missingModelIds.length
      ? ` ${result.missingModelIds.length} model payload(s) were not in that version and show as missing.`
      : "";
    toast("success", `Version restored.${missing} Reloading the scene…`);
    await openProject(cur.id);
    await refreshPanel();
    return true;
  } catch (e) {
    console.error("[model-timeline] restore failed", e);
    toast("error", `Restore failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/* ── Panel ─────────────────────────────────────────────────────────────── */

function rowHtml(v: VersionRow): string {
  const when = esc(fmtDateTime(v.createdAt));
  const label = v.label ? ` — “${esc(v.label)}”` : "";
  const reason = esc(REASON_LABELS[v.reason] ?? v.reason);
  const counts = `${v.elementCount} element${v.elementCount === 1 ? "" : "s"} · ${v.modelCount} model${v.modelCount === 1 ? "" : "s"}`;
  const missing = v.missingModelCount > 0
    ? ` · <span style="color:#fca5a5">${v.missingModelCount} model payload(s) missing</span>` : "";
  return `<div style="display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border:1px solid #2a2e3a;border-radius:8px;background:#20222d">
    <div style="flex:1;min-width:0">
      <div style="font-weight:600">${when} <span style="opacity:.55;font-weight:400">· ${reason}${label}</span></div>
      <div style="opacity:.75;font-size:11px;margin-top:2px">${esc(counts)}${missing}</div>
      <div style="opacity:.75;font-size:11px">${esc(v.diffFromPrevious)}</div>
    </div>
    <button data-restore="${v.id}" style="padding:5px 12px;background:#2b3a55;color:#cfe1ff;border:1px solid #3b5578;border-radius:5px;cursor:pointer;font-size:11px;white-space:nowrap">Restore</button>
  </div>`;
}

export async function refreshPanel(): Promise<void> {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  const list = panel.querySelector("[data-list]") as HTMLElement | null;
  if (!list) return;
  const state = await getTimelineState();
  if (!state) {
    list.innerHTML = `<div style="opacity:.6;padding:10px">Open or create a project first — versions are recorded per project.</div>`;
    return;
  }
  const c = state.current;
  const matchNote = c.matchesVersionId !== null
    ? ` · matches the version below` : ` · ${esc(c.diffFromNewest)} since the newest version`;
  const currentRow = `<div style="display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border:1px solid #3b5578;border-radius:8px;background:#1a2436">
    <div style="flex:1;min-width:0">
      <div style="font-weight:600">Current — live state</div>
      <div style="opacity:.75;font-size:11px;margin-top:2px">${c.elementCount} element${c.elementCount === 1 ? "" : "s"} · ${c.modelCount} model${c.modelCount === 1 ? "" : "s"}${matchNote}</div>
      <div style="opacity:.6;font-size:11px">Save (Ctrl+S) or Save version to keep this state.</div>
    </div>
  </div>`;
  const versionRows = state.versions.length
    ? state.versions.map(rowHtml).join("")
    : `<div style="opacity:.6;padding:10px;border:1px dashed #34353f;border-radius:6px">No versions yet. One is written automatically before each save that changes the document, before each model import, and before each restore — or save one now.</div>`;
  list.innerHTML = currentRow + versionRows;
  list.querySelectorAll("[data-restore]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const id = Number((btn as HTMLElement).dataset.restore);
      (btn as HTMLButtonElement).disabled = true;
      (btn as HTMLButtonElement).textContent = "Restoring…";
      void restoreVersion(id).finally(() => { void refreshPanel(); });
    };
  });
}

export function showModelTimeline(): void {
  let panel = document.getElementById(PANEL_ID);
  if (panel) { panel.style.display = "block"; void refreshPanel(); return; }
  panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText =
    "position:fixed;right:16px;top:64px;z-index:9000;width:440px;max-width:92vw;max-height:80vh;overflow:auto;" +
    "background:var(--bg-floating,#1c1e28);color:var(--text-primary,#e8eaf0);border:1px solid #34353f;" +
    "border-radius:10px;padding:14px 16px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.45)";
  panel.innerHTML =
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
      <div style="font-weight:700;font-size:14px;flex:1">🕰 Model history</div>
      <button data-save-version style="padding:4px 10px;background:#2b3a55;color:#cfe1ff;border:1px solid #3b5578;border-radius:5px;cursor:pointer;font-size:11px">Save version</button>
      <button data-close style="padding:4px 10px;background:#24252f;color:inherit;border:1px solid #34353f;border-radius:5px;cursor:pointer;font-size:11px">Close</button>
    </div>
    <div style="opacity:.6;margin-bottom:10px">Versions are the last 10 journal checkpoints (saves, autosaves, imports, restores) plus manual versions. Restoring keeps the current state as a version first.</div>
    <div data-list style="display:flex;flex-direction:column;gap:6px">Loading versions…</div>`;
  (panel.querySelector("[data-close]") as HTMLButtonElement).onclick = () => { panel!.style.display = "none"; };
  (panel.querySelector("[data-save-version]") as HTMLButtonElement).onclick = () => { void saveVersion(); };
  document.body.appendChild(panel);
  void refreshPanel();
}

export function setupModelTimeline(): void {
  (ctx.features as Any).modelTimeline = { getTimelineState, saveVersion, restoreVersion, showModelTimeline, refreshPanel };
  import("../../features/command-palette").then((m) => {
    m.registerCommand({
      id: "history-model-timeline",
      label: "History: model timeline",
      category: "History",
      hint: "Visible versions of this project, with restore",
      run: () => showModelTimeline(),
    });
  }).catch((e) => console.warn("[model-timeline] could not register the palette command", e));
  window.addEventListener("obs:project-saved", () => { void refreshPanel(); });
  window.addEventListener("obs-history", () => { void refreshPanel(); });
}
