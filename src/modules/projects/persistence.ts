/**
 * Session-level persistence safety for the open project.
 *
 * Owns everything time-based or unload-based around saving:
 *
 *   - the autosave interval (in-flight + transition aware, replaced the
 *     bare setInterval that used to live in projects.ts);
 *   - the beforeunload / pagehide guard so a browser refresh or close with
 *     unsaved changes is never silent;
 *   - the crash marker: a synchronous localStorage note written while the
 *     project is dirty, cleared on every successful save and on a clean
 *     unload. Its presence at boot means the previous session ended
 *     without a clean save — surfaced as a recovery notice;
 *   - the storage-quota watch (estimate + persist request) so exhaustion
 *     is visible before it eats a save.
 *
 * No new window globals: everything is module-scoped.
 */
import {
  getCurrentProject, isDirty, isTransitioning, saveProject, getSaveState,
} from "./projects";
import { estimateStorage } from "./store";
import { notify as toast } from "../../core/notify";

/** localStorage key for the "ended without a clean save" marker. */
export const CRASH_MARKER_KEY = "obs.session.unsaved";

export interface CrashMarker {
  projectId: string;
  projectName: string;
  at: number;
}

export function readCrashMarker(): CrashMarker | null {
  try {
    const raw = localStorage.getItem(CRASH_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CrashMarker>;
    if (!parsed || typeof parsed.projectId !== "string" || !parsed.projectId) return null;
    return {
      projectId: parsed.projectId,
      projectName: typeof parsed.projectName === "string" ? parsed.projectName : "Untitled project",
      at: typeof parsed.at === "number" ? parsed.at : 0,
    };
  } catch {
    // A malformed marker must never block boot; drop it.
    try { localStorage.removeItem(CRASH_MARKER_KEY); } catch { /* */ }
    return null;
  }
}

export function writeCrashMarker(): void {
  const cur = getCurrentProject();
  try {
    if (!cur || !isDirty()) return;
    localStorage.setItem(CRASH_MARKER_KEY, JSON.stringify({
      projectId: cur.id, projectName: cur.name, at: Date.now(),
    } satisfies CrashMarker));
  } catch { /* private mode / quota — best effort by design */ }
}

export function clearCrashMarker(): void {
  try { localStorage.removeItem(CRASH_MARKER_KEY); } catch { /* */ }
}

const AUTOSAVE_MS = 25_000;
const QUOTA_WARN_RATIO = 0.9;

export function setupProjectPersistence(): void {
  /* ── crash-recovery notice from the previous session ─────────────────── */
  const marker = readCrashMarker();
  if (marker) {
    // Keep the marker until a clean save or unload clears it; just surface it.
    const when = marker.at ? new Date(marker.at).toLocaleTimeString() : "earlier";
    toast("warn", `The previous session (${when}) ended with unsaved changes to “${marker.projectName}”. ` +
      "Autosaved checkpoints are available via File → Recovery checkpoints…");
    try { window.dispatchEvent(new CustomEvent("obs:recovery-available", { detail: { ...marker } })); } catch { /* */ }
  }

  /* ── autosave: guarded on every axis the old bare interval missed ────── */
  setInterval(() => {
    if (document.hidden) return;                    // background tabs are throttled anyway
    if (isTransitioning()) return;                  // never autosave a half-restored document
    if (getSaveState().state === "saving") return;  // a write is already in flight
    if (!getCurrentProject() || !isDirty()) return;
    void saveProject(true);
  }, AUTOSAVE_MS);

  /* ── unload safety: warn + crash marker ──────────────────────────────── */
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) {
      writeCrashMarker(); // synchronous; survives the reload even if the user stays
      // Standard browser-native confirmation (not window.confirm).
      e.preventDefault();
      e.returnValue = "The project has unsaved changes.";
      return e.returnValue;
    }
    clearCrashMarker();
    return undefined;
  });
  // Mobile / instant-refresh path: beforeunload is not guaranteed to fire.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (isDirty()) writeCrashMarker(); else clearCrashMarker();
    }
  });

  /* ── clear the marker whenever a save lands ──────────────────────────── */
  window.addEventListener("obs:project-saved", () => {
    if (!isDirty()) clearCrashMarker();
  });

  /* ── quota observability: know exhaustion before it eats a save ──────── */
  void (async () => {
    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
    } catch { /* not supported — estimation below still applies */ }
    try {
      const est = await estimateStorage();
      if (est.supported && est.quota > 0 && est.usage / est.quota >= QUOTA_WARN_RATIO) {
        const pct = Math.round((est.usage / est.quota) * 100);
        toast("warn", `Browser storage is ${pct}% full. Project saves may fail soon — save a .obsproj backup (File → Save As).`);
      }
    } catch { /* purely informational */ }
  })();
}
