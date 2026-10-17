/**
 * Federation persistence — lives inside the current project document so a
 * project reload restores the federation exactly as the user left it.
 */
import type { FederationState } from "./types";

const KEY = "obs.federation.v1";

/** Session-level fallback when no project is active. */
let sessionCache: FederationState | null = null;

export function saveFederationState(state: FederationState | null): void {
  sessionCache = state;
  try {
    if (state) {
      localStorage.setItem(KEY, JSON.stringify(state));
    } else {
      localStorage.removeItem(KEY);
    }
  } catch { /* */ }
}

export function loadFederationState(): FederationState | null {
  if (sessionCache) return sessionCache;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FederationState;
    if (!parsed?.entries || !Array.isArray(parsed.entries)) return null;
    sessionCache = parsed;
    return parsed;
  } catch {
    return null;
  }
}