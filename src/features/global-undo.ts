/**
 * Global Undo / Redo activation for OpenBIMStudio.
 *
 * Ensures Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z always reach the history stack,
 * even if another listener stops propagation or the shortcut registry
 * has not finished installing.
 *
 * Also exposes window.__obsUndo / __obsRedo for ribbon buttons and
 * third-party modules.
 */
import { history } from "./history";

type Any = any;

let installed = false;

function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (t.isContentEditable) return true;
  return false;
}

async function doUndo(): Promise<void> {
  if (!history.canUndo()) {
    try {
      window.dispatchEvent(
        new CustomEvent("obs-toast", {
          detail: { message: "Nothing to undo", kind: "warn" },
        }),
      );
    } catch {
      /* */
    }
    return;
  }
  try {
    await history.undo();
  } catch (e) {
    console.error("[global-undo] undo failed", e);
  }
}

async function doRedo(): Promise<void> {
  if (!history.canRedo()) {
    try {
      window.dispatchEvent(
        new CustomEvent("obs-toast", {
          detail: { message: "Nothing to redo", kind: "warn" },
        }),
      );
    } catch {
      /* */
    }
    return;
  }
  try {
    await history.redo();
  } catch (e) {
    console.error("[global-undo] redo failed", e);
  }
}

/**
 * Capture-phase keydown so undo wins over most other handlers.
 * Does not fire inside inputs / contenteditable.
 */
function onKeyDown(e: KeyboardEvent): void {
  if (isTypingTarget(e.target)) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();

  // Ctrl+Z → Undo (not Ctrl+Shift+Z)
  if (key === "z" && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    e.stopPropagation();
    void doUndo();
    return;
  }

  // Ctrl+Y → Redo
  if (key === "y" && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    e.stopPropagation();
    void doRedo();
    return;
  }

  // Ctrl+Shift+Z → Redo (standard alternate)
  if (key === "z" && e.shiftKey && !e.altKey) {
    e.preventDefault();
    e.stopPropagation();
    void doRedo();
    return;
  }
}

export function setupGlobalUndo(): void {
  if (installed) return;
  installed = true;

  // Capture phase — runs before bubble listeners and most UI handlers
  window.addEventListener("keydown", onKeyDown, true);

  const w = window as Any;
  w.__obsUndo = () => void doUndo();
  w.__obsRedo = () => void doRedo();
  w.__obsHistory = history;
  w.__obsCanUndo = () => history.canUndo();
  w.__obsCanRedo = () => history.canRedo();
  w.__obsUndoLabel = () => history.undoLabel();
  w.__obsRedoLabel = () => history.redoLabel();

  // Keep status / ribbon in sync when history changes
  history.onChange(() => {
    try {
      window.dispatchEvent(
        new CustomEvent("obs-history-changed", {
          detail: {
            canUndo: history.canUndo(),
            canRedo: history.canRedo(),
            undoLabel: history.undoLabel(),
            redoLabel: history.redoLabel(),
            depth: history.depth(),
          },
        }),
      );
    } catch {
      /* */
    }
  });

  console.log("[global-undo] Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z active");
}

export { doUndo, doRedo };
