/** Pure helpers for user-assigned keyboard shortcuts.
 *  Key strings use the registry format: "ctrl+shift+z", "f5", "delete", "g" or a two-letter sequence "wa". */
const MODS = ["ctrl", "shift", "alt"];
const NAMED = /^(f([1-9]|1[0-2])|delete|backspace|escape|enter|space|tab|home|end|pageup|pagedown|insert|arrowup|arrowdown|arrowleft|arrowright)$/;

/** Normalise user text/keys; returns null when it is not a valid shortcut. */
export function normalizeKeys(raw: string): string | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "").replace(/^cmd\+|^meta\+/, "ctrl+").replace(/\+cmd|\+meta/g, "+ctrl");
  if (!s) return null;
  const parts = s.split("+");
  const key = parts.pop()!;
  const mods = parts;
  if (!key) return null;
  if (new Set(mods).size !== mods.length || mods.some((m) => !MODS.includes(m))) return null;
  const ordered = MODS.filter((m) => mods.includes(m));
  if (!mods.length) {
    if (/^[a-z]{1,2}$/.test(key) || /^[0-9]$/.test(key) || NAMED.test(key)) return key;
    return null;
  }
  if (/^[a-z0-9]$/.test(key) || NAMED.test(key) || /^[-=,./;'[\]\\`]$/.test(key)) return [...ordered, key].join("+");
  return null;
}

export function prettyKeys(k: string): string {
  if (!k) return "";
  if (/^[a-z]{1,2}$/.test(k)) return k.toUpperCase();
  return k.split("+").map((p) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join("+");
}

/** Build a key string from a keydown (modifier combos / named keys only; plain letters are typed). */
export function comboFromEvent(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): string | null {
  const k = e.key.toLowerCase();
  if (["control", "shift", "alt", "meta"].includes(k)) return null;
  const key = k === " " ? "space" : k;
  const mods = [(e.ctrlKey || e.metaKey) ? "ctrl" : "", e.shiftKey ? "shift" : "", e.altKey ? "alt" : ""].filter(Boolean);
  return normalizeKeys([...mods, key].join("+"));
}

/** Another command that already uses `keys` (exact), ignoring `selfId`. */
export function findConflict(effective: Record<string, string>, selfId: string, keys: string): string | null {
  if (!keys) return null;
  for (const [id, k] of Object.entries(effective)) if (id !== selfId && k === keys) return id;
  return null;
}
