/**
 * Hotkey ownership for the CAD drawing view.
 *
 * While a drawing tab is the active screen, the CAD editor owns
 * Ctrl+Shift+C (COPYCLIP) and Ctrl+Shift+V (PASTECLIP) for cross-drawing
 * Super Copy. App-level handlers that bind the same combos (Clash Review,
 * View Tools Manager, Saved Views, Validation, VG dialog) call
 * `isCadHotkeyOwnerActive()` before consuming the key and stand down, so the
 * keystroke always reaches the CAD editor's own hotkey handler.
 *
 * A module singleton (rather than another `window.__obs*` global) keeps the
 * global budget intact and makes the ownership explicit and type-safe.
 */

let ownerActive = false;

/** True while a CAD drawing tab is the active screen. */
export function isCadHotkeyOwnerActive(): boolean {
  return ownerActive;
}

/** Called by the CAD editor when a drawing tab activates / deactivates. */
export function setCadHotkeyOwner(active: boolean): void {
  ownerActive = active;
}
