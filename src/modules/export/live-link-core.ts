/** Pure decision helpers for the Live IFC link (no DOM, testable in Node). */

/** Small, fast, non-cryptographic string hash (FNV-1a, 32-bit) used to notice that the edits changed. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** The linked file was modified by something other than this app since we last wrote or read it. */
export function detectExternalChange(knownModified: number, currentModified: number): boolean {
  return currentModified !== knownModified;
}

export type LinkAction = "idle" | "write" | "conflict";

/**
 * What the link should do on a tick.
 *  - conflict: the file changed outside the app - never overwrite it silently.
 *  - write:    the edits changed since the last write (or the user forced one).
 *  - idle:     nothing to do.
 */
export function nextLinkAction(p: { externalChange: boolean; sig: string; lastWrittenSig: string | null; hasEdits: boolean; force?: boolean }): LinkAction {
  if (p.externalChange) return "conflict";
  if (!p.hasEdits) return "idle";
  if (p.force || p.sig !== p.lastWrittenSig) return "write";
  return "idle";
}
