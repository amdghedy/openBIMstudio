const TOAST_EVENT = "obs-toast";
const HISTORY_EVENT = "obs-history";
export function notify(kind, message, opts = {}) {
    try {
        window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { kind, message, ...opts } }));
    }
    catch {
        /* non-browser env */
    }
}
export function notifyHistory(action, label) {
    try {
        window.dispatchEvent(new CustomEvent(HISTORY_EVENT, { detail: { action, label } }));
    }
    catch {
        /* */
    }
}
const toastHandlers = new Set();
export function onNotify(cb) {
    toastHandlers.add(cb);
    return () => toastHandlers.delete(cb);
}
/** Called by the toast host when a `obs-toast` event arrives. */
export function __dispatchToSubscribers(kind, message, opts) {
    for (const cb of toastHandlers) {
        try {
            cb(kind, message, opts);
        }
        catch { /* */ }
    }
}
/**
 * Non-blocking replacement for `window.alert()`. Shows a toast whose kind is
 * inferred from the wording and whose lifetime scales with the message length.
 */
export function uiAlert(message) {
    const text = String(message).replace(/\s*\n+\s*/g, " — ").trim();
    const kind = /fail|could not|cannot|can't|error|invalid|unavailable|blocked|not available/i.test(text)
        ? "error"
        : /^(no |nothing|please|select|run |generate|create or select)/i.test(text) ? "warn" : "info";
    notify(kind, text, { timeout: Math.min(14000, Math.max(3500, 2500 + text.length * 45)) });
}
