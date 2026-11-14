/**
 * Global Undo / Redo activation for OpenBIMStudio.
 *
 * Ensures Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z always reach the history stack,
 * even if another listener stops propagation or the shortcut registry
 * has not finished installing.
 *
 * Undo/redo entry points live in features/history.ts — ribbon buttons and
 * third-party modules import it directly (legacy window handles removed
 * 2026-11-13, see scripts/eliminate-local-globals.mjs).
 */
import { history } from "./history";
import { isCadHotkeyOwnerActive } from "../core/cad-hotkey-ownership";

// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsUndo: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsRedo: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsHistory: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsCanUndo: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsCanRedo: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsUndoLabel: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsRedoLabel: any;

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
 *
 * Single-owner rule: while a CAD drawing tab is the active screen the
 * drawing editor owns Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z for its own entity
 * history (cad-viewer.ts). Without this stand-down BOTH handlers ran —
 * the app stack and the drawing stack were stepped in the same keystroke,
 * desynchronizing the two documents.
 */
function onKeyDown(e: KeyboardEvent): void {
  if (isCadHotkeyOwnerActive()) return;
  if (isTypingTarget(e.target)) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;

  // Synthetic key events can carry key === undefined — bail out instead of crashing.
  const key = (e.key ?? "").toLowerCase();
  if (!key) return;

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
  obsUndo = () => void doUndo();
  obsRedo = () => void doRedo();
  obsHistory = history;
  obsCanUndo = () => history.canUndo();
  obsCanRedo = () => history.canRedo();
  obsUndoLabel = () => history.undoLabel();
  obsRedoLabel = () => history.redoLabel();

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
