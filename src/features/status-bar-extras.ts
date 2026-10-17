// openbim-fix:status-bar-extras
//
// Adds four live readouts to the bottom status bar:
//   * Selection   -- "N selected" / "No selection"  (click clears)
//   * Level       -- active level + elevation        (click opens dropdown)
//   * Tool        -- active authoring tool
//   * Locale      -- current locale code             (click rotates)
//
// The status bar is discovered from the outside, exactly like
// ribbon-persist does for the ribbon, so this module never has to know
// the shell's internal class names beyond a small set of fallbacks.

import { ctx } from "../core/context";
import { selection } from "./selection";
import { levels } from "../modules/levels";

const STATUSBAR_SELECTORS = [
  ".bb-status",
  "[data-obs-status-bar]",
  ".obs-status-bar",
  "[role='status']",
];

function findStatusBar(): HTMLElement | null {
  for (const sel of STATUSBAR_SELECTORS) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

function ensureSegment(
  bar: HTMLElement,
  key: string,
  title: string,
): HTMLElement {
  const existing = bar.querySelector(
    "[data-obs-status='" + key + "']",
  ) as HTMLElement | null;
  if (existing) return existing;

  const el = document.createElement("span");
  el.dataset.obsStatus = key;
  el.title = title;
  el.style.cssText =
    "padding:0 8px;font-size:10.5px;color:var(--text-tertiary,#6b7280);" +
    "cursor:pointer;user-select:none;white-space:nowrap;display:inline-flex;" +
    "align-items:center;gap:4px;border-left:1px solid rgba(148,163,184,.15)";
  bar.appendChild(el);
  return el;
}

function textOf(el: HTMLElement, value: string, tint?: string): void {
  el.textContent = value;
  if (tint) el.style.color = tint;
}

function installSegments(bar: HTMLElement): void {
  const selSeg  = ensureSegment(bar, "selection", "Selection - click to clear");
  const lvlSeg  = ensureSegment(bar, "level",     "Active level - click to switch");
  const toolSeg = ensureSegment(bar, "tool",      "Active authoring tool");
  const locSeg  = ensureSegment(bar, "locale",    "Locale - click to cycle");

  // ---- Selection -------------------------------------------------------
  const renderSelection = () => {
    const n = selection.size();
    if (n === 0) {
      textOf(selSeg, "\u25CB No selection", "var(--text-tertiary,#6b7280)");
    } else {
      const models = selection.modelCount();
      const suffix = models > 1 ? "  \u00B7 " + models + " models" : "";
      textOf(selSeg, "\u25CF " + n + " selected" + suffix, "var(--accent,#38bdf8)");
    }
  };
  selSeg.addEventListener("click", () => {
    try {
      selection.clear();
      void selection.applyToHighlighter();
    } catch { /* */ }
  });
  try { selection.onChange(renderSelection); } catch { /* */ }
  renderSelection();

  // ---- Level -----------------------------------------------------------
  const renderLevel = () => {
    const active = levels.getActive();
    if (!active) {
      textOf(lvlSeg, "\u25C7 No level", "var(--text-tertiary,#6b7280)");
    } else {
      const elev = active.elevation >= 0
        ? "+" + active.elevation.toFixed(2)
        : active.elevation.toFixed(2);
      textOf(lvlSeg, "\u25C6 " + active.name + "  " + elev + " m",
        "var(--accent,#38bdf8)");
    }
  };
  lvlSeg.addEventListener("click", () => {
    try {
      const mod: any = (window as any).__obs_level_chip__;
      if (mod?.openDropdown) { mod.openDropdown(); return; }
      // Fallback: rotate to next level.
      const all = levels.list();
      if (all.length < 2) return;
      const cur = levels.getActiveId();
      const i = all.findIndex((l) => l.id === cur);
      const next = all[(i + 1) % all.length];
      levels.setActiveId(next.id);
    } catch { /* */ }
  });
  try { levels.onChange(renderLevel); } catch { /* */ }
  renderLevel();

  // ---- Tool ------------------------------------------------------------
  const renderTool = () => {
    const auth: any = (ctx.features as any).authoring;
    const tool = auth?.getActiveTool?.() ?? null;
    if (!tool || tool === "select") {
      textOf(toolSeg, "\u25B8 Select", "var(--text-tertiary,#6b7280)");
    } else {
      const nice = String(tool).replace(/-/g, " ")
        .replace(/\b\w/g, (c: string) => c.toUpperCase());
      textOf(toolSeg, "\u25B8 " + nice, "var(--text-secondary,#a0a6b5)");
    }
  };
  try {
    const auth: any = (ctx.features as any).authoring;
    auth?.onAuthoringChange?.(renderTool);
  } catch { /* */ }
  renderTool();

  // ---- Locale ----------------------------------------------------------
  const renderLocale = () => {
    const i18n: any = (ctx.features as any).i18n;
    const loc = i18n?.getLocale?.() ?? "en";
    textOf(locSeg, "\u2295 " + String(loc).toUpperCase(),
      "var(--text-tertiary,#6b7280)");
  };
  locSeg.addEventListener("click", () => {
    try {
      const i18n: any = (ctx.features as any).i18n;
      if (!i18n?.listLocales || !i18n?.setLocale) return;
      const list = i18n.listLocales();
      if (list.length < 2) return;
      const cur = i18n.getLocale();
      const i = list.findIndex((l: any) => l.id === cur);
      const next = list[(i + 1) % list.length];
      i18n.setLocale(next.id);
    } catch { /* */ }
  });
  try {
    const i18n: any = (ctx.features as any).i18n;
    i18n?.onChange?.(renderLocale);
  } catch { /* */ }
  renderLocale();

  (window as any).__obsStatusBar = {
    refresh: () => {
      renderSelection(); renderLevel(); renderTool(); renderLocale();
    },
    segments: { selSeg, lvlSeg, toolSeg, locSeg },
  };
}

let installed = false;

export function setupStatusBarExtras(): void {
  if (installed) return;
  installed = true;

  // If the bar is already mounted, install immediately.
  const existing = findStatusBar();
  if (existing) {
    installSegments(existing);
    console.log("[status-bar-extras] ready");
    return;
  }

  // Otherwise wait for it.
  const obs = new MutationObserver(() => {
    const bar = findStatusBar();
    if (!bar) return;
    obs.disconnect();
    installSegments(bar);
    console.log("[status-bar-extras] ready");
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // Safety: if the bar never appears, do not hold onto the observer.
  window.setTimeout(() => {
    try { obs.disconnect(); } catch { /* */ }
  }, 15_000);
}