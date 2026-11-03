/**
 * Ribbon collapse gesture — pure decision logic, shared by src/shell/ribbon.ts
 * and executed directly by tests/ribbon-collapse.test.cjs.
 *
 * BIM/Office behaviour:
 *   • double-click a tab (or the empty tabs row) → collapse the ribbon strip so
 *     only the tab buttons remain, giving the model view more space;
 *   • single-click a tab while collapsed → auto-expand and switch to that tab;
 *   • a double-click that lands right after such an auto-expand is the tail of
 *     the SAME gesture — it must NOT immediately re-collapse the ribbon.
 */

/** Window (ms) in which a dblclick after an auto-expand counts as the same gesture. */
export const AUTO_EXPAND_GRACE_MS = 450;

export type RibbonCollapseInput = {
  /** current minimized state */
  minimized: boolean;
  /** Date.now() of the last auto-expand caused by a single click (0 = none) */
  lastAutoExpandAt: number;
  /** current time (Date.now()) */
  now: number;
  /** does the event target sit on a tab button (vs the empty tabs row)? */
  onTab: boolean;
};

export type RibbonCollapseDecision = {
  /** the state applyRibbonMinimize() should switch to */
  minimize: boolean;
  /** the updated lastAutoExpandAt bookkeeping value */
  lastAutoExpandAt: number;
};

export function resolveDblClick(s: RibbonCollapseInput): RibbonCollapseDecision {
  // The tail of an auto-expand double-click: swallow it so the ribbon that the
  // first click just expanded stays expanded.
  if (s.onTab && s.now - s.lastAutoExpandAt < AUTO_EXPAND_GRACE_MS) {
    return { minimize: false, lastAutoExpandAt: 0 };
  }
  return { minimize: !s.minimized, lastAutoExpandAt: s.lastAutoExpandAt };
}

/** Pure decision for full-screen chrome hiding: any fullscreen element → hide command bars. */
export function fullscreenChromeActive(fullscreenElement: unknown): boolean {
  return !!fullscreenElement;
}
