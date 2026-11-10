/**
 * Selection preferences — the real state behind the Edit-tab selection
 * toggles.
 *
 * Until now the Edit-tab toggles ("Select Links", "Select Pinned", …) only
 * wrote ad-hoc `window.__obsSel*` globals that no engine ever read — fake
 * switches. This module is the single source of truth:
 *
 *   • `links`   — allow selecting elements that belong to linked federation
 *                 models (anything registered in ctx.fragments). The current
 *                 document is the authored model; linked models are
 *                 read-only references, so turning this off protects them
 *                 from accidental selection/highlighting.
 *   • `pinned`  — allow selecting pinned authored elements
 *                 (`element.properties.pinned`, set via Modify ▸ Pin).
 *
 * Preferences persist in localStorage and notify subscribers so the
 * Edit-tab checkboxes stay in sync.
 */

export interface SelectionPrefs {
  links: boolean;
  pinned: boolean;
}

const STORAGE_KEY = "obs.selection-prefs.v1";

const DEFAULTS: SelectionPrefs = {
  links: true,
  pinned: true,
};

let prefs: SelectionPrefs = load();

function load(): SelectionPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<SelectionPrefs>;
    return {
      links: parsed.links !== false,
      pinned: parsed.pinned !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const listeners = new Set<() => void>();

export function getSelectionPrefs(): SelectionPrefs {
  return { ...prefs };
}

export function getSelectionPref(key: keyof SelectionPrefs): boolean {
  return prefs[key];
}

export function setSelectionPref(key: keyof SelectionPrefs, value: boolean): void {
  if (prefs[key] === value) return;
  prefs[key] = value;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* private browsing */ }
  for (const cb of listeners) {
    try { cb(); } catch { /* */ }
  }
}

export function onSelectionPrefsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
