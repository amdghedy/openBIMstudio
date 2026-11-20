/** Auto-reopen the last opened project at boot.
 *
 *  Problem (honest gap, project-persistence registry): a fresh boot always
 *  entered an empty session even when a saved project existed — the user had
 *  to click the project on the welcome screen, and that easily reads as
 *  "everything is gone".
 *
 *  Design
 *  ──────
 *  · A module-local pointer (localStorage `obs.projects.lastId`) is recorded
 *    when a project is successfully created or opened, and cleared when that
 *    project is deleted.
 *  · At the END of boot (after every setup step) the pointer is resolved:
 *    - no pointer, a project is already current, or the doc no longer exists
 *      → the welcome screen stays, nothing else happens;
 *    - otherwise the project is reopened through the normal openProject
 *      pipeline (same hydration, same repairs report, same loader progress);
 *      the welcome overlay hides itself via the existing project-changed hook.
 *  · Crash recovery (#101) runs in main.ts BEFORE this step, so by the time
 *    this runs the journal has already been replayed into the primary
 *    store when the previous session crashed. One exception is honoured
 *    here: when recovery found the journal ends with an intentional
 *    deletion, the recorded outcome (`obs.recovery.last`) says
 *    `suppressReopen`, and this step must NOT resurrect the project —
 *    the pointer is cleared as stale instead.
 *  · The decision is a pure function so the boot behaviour is unit-tested;
 *    stale pointers are silently cleared (never an alert at boot).
 *  · There is no "close project" action in the app, so a session always ends
 *    with the last project it had open — auto-reopen matches that intent in
 *    every currently expressible state.
 */
import { ctx } from "../../core/context";
import * as store from "./store";

type Any = Record<string, any>;

const LAST_PROJECT_KEY = "obs.projects.lastId";

/** Pure decision: which project id (if any) should auto-reopen. */
export function pickAutoReopenId(
  docs: Array<{ id: string }>,
  lastId: string | null,
  hasCurrentProject: boolean,
): string | null {
  if (hasCurrentProject) return null;
  if (!lastId) return null;
  return docs.some((d) => d.id === lastId) ? lastId : null;
}

export function readLastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function recordLastProjectId(id: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch { /* */ }
}

export function clearLastProjectId(): void {
  try {
    localStorage.removeItem(LAST_PROJECT_KEY);
  } catch { /* */ }
}

/** Boot hook: reopen the last project, or leave the welcome screen as-is.
 *  Returns true when a reopen was attempted (and let openProject report). */
export async function autoReopenLastProject(): Promise<boolean> {
  const feats = (ctx.features as Any)?.projects;
  if (!feats?.openProject) return false;
  if (feats.getCurrentProject?.()) return false;
  const lastId = readLastProjectId();
  if (!lastId) return false;
  // #101: the journal recorded an intentional deletion before the crash —
  // do not resurrect the project by reopening a stale primary copy left
  // behind by a crash mid-delete. (Read straight from localStorage: this
  // module is imported by projects.ts, so it cannot import the recovery
  // module without an import cycle.)
  try {
    const raw = localStorage.getItem("obs.recovery.last");
    if (raw) {
      const outcome = JSON.parse(raw) as { projectId?: unknown; suppressReopen?: unknown };
      if (outcome?.projectId === lastId && outcome?.suppressReopen === true) {
        console.log(`[auto-reopen] not reopening ${lastId}: journal shows it was deleted before the crash`);
        clearLastProjectId();
        return false;
      }
    }
  } catch { /* unreadable outcome: proceed with the normal reopen path */ }
  let docs: Array<{ id: string }> = [];
  try {
    docs = await store.listProjectDocs();
  } catch (e) {
    console.warn("[auto-reopen] could not list stored projects", e);
    return false;
  }
  const target = pickAutoReopenId(docs, lastId, false);
  if (!target) {
    // Stale pointer (project deleted in another tab / storage cleared):
    // clear silently — boot must never alert about it.
    clearLastProjectId();
    return false;
  }
  console.log(`[auto-reopen] reopening last project ${target}`);
  try {
    await feats.openProject(target);
    return true;
  } catch (e) {
    console.warn("[auto-reopen] reopen failed; welcome screen stays", e);
    return false;
  }
}
