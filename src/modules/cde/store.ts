/**
 * Persistence for CDE credentials + session, keyed by provider id.
 *
 * Credentials are stored in localStorage for convenience. That is a
 * deliberate trade-off: this app runs entirely in the browser, and asking
 * the user to re-type an API token every page reload is unusable. If you
 * ship this to a shared machine, wipe the storage on logout (see
 * clearCdeConfig) or move to the Web Crypto encrypted vault in a later
 * hardening pass.
 */
import type {
  CdeCredentials,
  CdeProviderId,
  CdeSession,
  CdeStoredConfig,
} from "./types";

const PREFIX = "obs.cde.";

function keyFor(providerId: CdeProviderId): string {
  return `${PREFIX}${providerId}`;
}

export function loadCdeConfig(
  providerId: CdeProviderId,
): { credentials: CdeCredentials; session: CdeSession | null } | null {
  try {
    const raw = localStorage.getItem(keyFor(providerId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CdeStoredConfig;
    if (parsed?.providerId !== providerId) return null;
    return {
      credentials: parsed.credentials ?? {},
      session: parsed.session ?? null,
    };
  } catch {
    return null;
  }
}

export function saveCdeConfig(
  config: Omit<CdeStoredConfig, "updatedAt">,
): boolean {
  try {
    const payload: CdeStoredConfig = { ...config, updatedAt: Date.now() };
    localStorage.setItem(keyFor(config.providerId), JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn("[cde] save failed", err);
    return false;
  }
}

export function clearCdeConfig(providerId: CdeProviderId): void {
  try {
    localStorage.removeItem(keyFor(providerId));
  } catch { /* */ }
}

export function clearAllCdeConfig(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch { /* */ }
}

export function listStoredProviders(): CdeProviderId[] {
  const out: CdeProviderId[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      out.push(k.slice(PREFIX.length) as CdeProviderId);
    }
  } catch { /* */ }
  return out;
}