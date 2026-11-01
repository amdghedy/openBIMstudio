/**
 * Keyboard command registry (BIM + Blender hybrid).
 *
 * Letter sequences of 1–3 letters (BIM-style): WA = Wall, CM = Column, KSX…
 * Single-letter modals (Blender-style): G = move gizmo, R = rotate, S = scale.
 * Standard modifiers: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Ctrl+A, Delete, Esc.
 *
 * Sequence resolution:
 *   - If a key starts a two-letter command, wait up to 800 ms for the next.
 *   - If the second key completes a command, run it.
 *   - If timeout expires and the first key is a single-letter command, run it.
 *
 * Handlers fire with stopImmediatePropagation so no downstream listener
 * (walk mode, custom windows, project auto-save) can double-fire.
 */
export interface Shortcut {
  id: string;
  label: string;
  /** "ctrl+shift+z", "delete", "g", or a two-letter sequence "wa". */
  keys: string;
  handler: (e: KeyboardEvent) => void;
  when?: () => boolean;
  category: "edit" | "view" | "select" | "tool" | "modal" | "navigate" | "app";
}

const SEQ_TIMEOUT = 800;

class ShortcutRegistry {
  private shortcuts = new Map<string, Shortcut>();
  private buffer = "";
  private timer: number | null = null;
  private installed = false;

  register(s: Shortcut): void {
    this.shortcuts.set(s.id, s);
  }
  unregister(id: string): void {
    this.shortcuts.delete(id);
  }
  get(id: string): Shortcut | undefined {
    return this.shortcuts.get(id);
  }
  /** Re-bind an existing shortcut (user customisation). Keys use the registry format. */
  setKeys(id: string, keys: string): boolean {
    const s = this.shortcuts.get(id);
    if (!s) return false;
    s.keys = keys;
    return true;
  }
  list(): Shortcut[] {
    return [...this.shortcuts.values()];
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;
    window.addEventListener("keydown", this.onKeyDown, true);
  }

  private resetBuffer(): void {
    this.buffer = "";
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private matchExact(combo: string): Shortcut | null {
    for (const s of this.shortcuts.values()) {
      if (s.keys !== combo) continue;
      if (s.when && !s.when()) continue;
      return s;
    }
    return null;
  }

  /** Letter-only sequences (2–3 letters) that start with `prefix` and are longer than it. */
  private matchLonger(prefix: string): Shortcut[] {
    const out: Shortcut[] = [];
    for (const s of this.shortcuts.values()) {
      if (/^[a-z]{2,3}$/.test(s.keys) && s.keys.length > prefix.length && s.keys.startsWith(prefix)) {
        if (!s.when || s.when()) out.push(s);
      }
    }
    return out;
  }

  private fire(s: Shortcut, e: KeyboardEvent) {
    e.preventDefault();
    // stopImmediatePropagation prevents every later window listener
    // (including the project module's own Ctrl+S handler, walk mode,
    // and any custom handler registered afterwards).
    e.stopImmediatePropagation();
    this.resetBuffer();
    try {
      s.handler(e);
    } catch (err) {
      console.error("[shortcuts] handler failed", s.id, err);
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Ignore keystrokes inside text inputs / contenteditable.
    const t = e.target as HTMLElement | null;
    if (t) {
      const tag = t.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || t.isContentEditable) return;
    }

    // Build combo string for modifier-based shortcuts.
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push("ctrl");
    if (e.shiftKey) parts.push("shift");
    if (e.altKey) parts.push("alt");
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
    const combo = [...parts, key].join("+");

    // Modifier-based commands handled first (they never start a sequence).
    if (parts.length) {
      const exact = this.matchExact(combo);
      if (exact) {
        this.fire(exact, e);
        return;
      }
    }

    // Pure letter → sequence logic (1–3 letters).
    if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[a-z]$/.test(key)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const candidate = (attempt === 0 ? this.buffer : "") + key;
        const exact = candidate.length <= 3 ? this.matchExact(candidate) : null;
        const longer = candidate.length < 3 ? this.matchLonger(candidate) : [];
        if (exact && !longer.length) {
          this.fire(exact, e);
          return;
        }
        if (longer.length) {
          // More keys may follow: wait; if they don't, run the shorter match (if any).
          e.preventDefault();
          this.buffer = candidate;
          if (this.timer != null) clearTimeout(this.timer);
          this.timer = window.setTimeout(() => {
            this.timer = null;
            const done = this.buffer === candidate ? this.matchExact(candidate) : null;
            this.resetBuffer();
            if (done) { try { done.handler(e); } catch (err) { console.error("[shortcuts] handler failed", done.id, err); } }
          }, SEQ_TIMEOUT);
          return;
        }
        if (!this.buffer) break; // nothing buffered: a fresh key was already evaluated
        this.resetBuffer();       // sequence broken: retry this key as a new start
      }
      this.resetBuffer();
      return;
    }

    // Non-letter keys without modifiers (Delete, Escape, F2, F5, etc.)
    if (parts.length === 0) {
      const exact = this.matchExact(key);
      if (exact) {
        this.fire(exact, e);
        return;
      }
    }
  };
}

export const shortcuts = new ShortcutRegistry();