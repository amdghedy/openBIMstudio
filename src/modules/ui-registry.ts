/**
 * UI element registry.
 *
 * Tracks the visibility of every toggleable UI panel or bar. Each item
 * declares how to read its current visibility, how to toggle it, and
 * whether it is available yet. The User Interface menu iterates this
 * registry and renders checkboxes.
 *
 * Adding a new UI element = adding one entry here. No UI code changes.
 */

export interface UiItem {
  id: string;
  label: string;
  /** Return current visibility. */
  isVisible: () => boolean;
  /** Toggle visibility. Called when the checkbox is clicked. */
  toggle: () => void;
  /** If false, the row is rendered as a disabled placeholder. */
  available: boolean;
  /** Optional tooltip when disabled. */
  unavailableHint?: string;
  /** Section key (used for grouping in the menu). */
  group: "panels" | "bars";
}

const items: UiItem[] = [];
const listeners = new Set<() => void>();

export function registerUiItem(item: UiItem): void {
  const idx = items.findIndex((x) => x.id === item.id);
  if (idx >= 0) items[idx] = item;
  else items.push(item);
}

export function listUiItems(): UiItem[] {
  return items.slice();
}

export function getUiItem(id: string): UiItem | null {
  return items.find((x) => x.id === id) ?? null;
}

export function onUiRegistryChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Notify the menu that some checkbox changed state externally. */
export function notifyUiChange(): void {
  for (const cb of listeners) {
    try { cb(); } catch { /* */ }
  }
}

const STORAGE_KEY = "obs.ui.visibility.v1";

interface StoredVisibility { [id: string]: boolean; }

export function loadStoredVisibility(): StoredVisibility {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveStoredVisibility(state: StoredVisibility): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* */ }
}

export function persistItem(id: string, visible: boolean): void {
  const s = loadStoredVisibility();
  s[id] = visible;
  saveStoredVisibility(s);
}