// openbim-fix:workspace-layout
//
// Persists which dockable panels are open across page reloads and
// provides a "Reset Workspace" that returns to the clean BIM-like
// default (all panels closed).
//
// How it works:
//   1. Every panel that should be remembered registers here with an
//      isVisible() / setVisible(on) pair.
//   2. On page unload, the current state is snapshotted and written
//      to localStorage under "obs.workspace.layout.v1".
//   3. On the next boot, restoreWorkspace() applies the saved state.
//      Missing keys fall back to `defaultOpen` (false everywhere).
//   4. resetWorkspace() closes every registered panel and clears the
//      saved state, so the next reload starts clean again.

const STORAGE_KEY = "obs.workspace.layout.v1";

export interface WorkspacePanel {
  key: string;
  label: string;
  isVisible: () => boolean;
  setVisible: (on: boolean) => void;
  defaultOpen?: boolean;
}

const registry = new Map<string, WorkspacePanel>();
const listeners = new Set<() => void>();

export function registerWorkspacePanel(p: WorkspacePanel): void {
  registry.set(p.key, p);
}

export function listWorkspacePanels(): WorkspacePanel[] {
  return [...registry.values()];
}

function readSaved(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSaved(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota exceeded / storage disabled - not fatal
  }
}

function emit(): void {
  for (const cb of listeners) {
    try { cb(); } catch { /* listener must never crash */ }
  }
}

export function onWorkspaceChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function snapshotWorkspace(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, p] of registry) {
    try { out[key] = !!p.isVisible(); }
    catch { out[key] = false; }
  }
  return out;
}

export function saveWorkspace(): Record<string, boolean> {
  const snap = snapshotWorkspace();
  writeSaved(snap);
  emit();
  return snap;
}

export function restoreWorkspace(): void {
  const saved = readSaved();
  for (const [key, p] of registry) {
    const want = key in saved ? saved[key] : (p.defaultOpen ?? false);
    try { p.setVisible(!!want); }
    catch (err) { console.warn("[workspace] restore failed:", key, err); }
  }
  emit();
}

export function resetWorkspace(): void {
  for (const p of registry.values()) {
    try { p.setVisible(false); } catch { /* */ }
  }
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
  emit();
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "Workspace reset - all panels closed", kind: "success" },
    }));
  } catch { /* */ }
}

export function showAllWorkspace(): void {
  for (const p of registry.values()) {
    try { p.setVisible(true); } catch { /* */ }
  }
  saveWorkspace();
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "Workspace - all panels open", kind: "success" },
    }));
  } catch { /* */ }
}

let unloadHookInstalled = false;
export function installWorkspaceUnloadHook(): void {
  if (unloadHookInstalled) return;
  unloadHookInstalled = true;
  window.addEventListener("beforeunload", () => { saveWorkspace(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveWorkspace();
  });
}