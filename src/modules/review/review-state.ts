/**
 * Review-mode state (differentiation item 8).
 *
 * Deliberately dependency-free: the edit gates in authoring.ts,
 * plan-view-panel.ts and tools.ts import this module, so it must not pull
 * in any app module (no import cycles, no boot ordering surprises).
 *
 * Review mode is view-only: the reviewer navigates, selects and creates
 * issues, but cannot author, delete or transform model elements. The flag
 * is process-local to the browser tab — a review link enters it at boot,
 * and "Exit review" clears it. Nothing about the mode is persisted: a
 * reviewer who reloads the plain app URL is back in normal mode.
 */
let reviewMode = false;

export function isReviewMode(): boolean {
  return reviewMode;
}

export function setReviewMode(on: boolean): void {
  reviewMode = on;
}
