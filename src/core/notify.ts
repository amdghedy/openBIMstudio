/**
 * Centralised notification + history event bus.
 *
 * Every feature previously dispatched `obs-toast` and `obs-history` from a
 * dozen modules with slightly different shapes. Listeners (the status bar,
 * the ribbon, the toast host) now only need one subscription each.
 */
export type NotifyKind = "info" | "success" | "warn" | "error";

export interface NotifyOptions {
  /** Auto-dismiss delay in ms. 0 keeps the toast until dismissed. */
  timeout?: number;
  /** Optional inline action button. */
  action?: { label: string; run: () => void };
}

const TOAST_EVENT = "obs-toast";
const HISTORY_EVENT = "obs-history";

export function notify(
  kind: NotifyKind,
  message: string,
  opts: NotifyOptions = {},
): void {
  try {
    window.dispatchEvent(
      new CustomEvent(TOAST_EVENT, { detail: { kind, message, ...opts } }),
    );
  } catch {
    /* non-browser env */
  }
}

export function notifyHistory(action: "undo" | "redo", label: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent(HISTORY_EVENT, { detail: { action, label } }),
    );
  } catch {
    /* */
  }
}

/* ── Compatibility shim ────────────────────────────────────────────────
   Some call sites still use `detail.kind` and `detail.message`; some use
   `detail.message` and `detail.kind`. The host listener reads both.
   Nothing else needs to change here.                                */

export type ToastHandler = (kind: NotifyKind, message: string, opts: NotifyOptions) => void;
const toastHandlers = new Set<ToastHandler>();

export function onNotify(cb: ToastHandler): () => void {
  toastHandlers.add(cb);
  return () => toastHandlers.delete(cb);
}

/** Called by the toast host when a `obs-toast` event arrives. */
export function __dispatchToSubscribers(
  kind: NotifyKind,
  message: string,
  opts: NotifyOptions,
): void {
  for (const cb of toastHandlers) {
    try { cb(kind, message, opts); } catch { /* */ }
  }
}
