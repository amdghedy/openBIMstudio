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

/**
 * Combos the CAD drawing editor (cad-viewer.ts) consumes itself while a
 * drawing tab is active: copy / cut / paste / super-copy / undo / redo /
 * CleanScreen, Delete and the CAD toggle keys (F3 osnap, F7 grid, F8 ortho,
 * F12 dyn). While the CAD editor owns the keyboard the registry must neither
 * fire these nor stopImmediatePropagation them — its own hotkey handler is
 * registered later on the same window capture path and would never run
 * (this exact collision shipped Ctrl+Shift+C/V dead inside the CAD editor:
 * "ctrl+shift+c" fired Clash Review and "ctrl+shift+v" fired Tools Manager).
 */
const CAD_EDITOR_COMBOS = new Set([
  "ctrl+c", "ctrl+shift+c", "ctrl+x", "ctrl+v", "ctrl+shift+v", "ctrl+alt+v",
  "ctrl+z", "ctrl+shift+z", "ctrl+y", "ctrl+0", "ctrl+digit0",
  "delete", "f3", "f7", "f8", "f12",
]);

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
    // Physical-key variant so the CAD yield below also matches non-Latin
    // keyboard layouts, where e.key is not the Latin letter (ev.code is).
    const codeKey = e.code ? e.code.replace(/^Key/, "").toLowerCase() : "";
    const physCombo = codeKey ? [...parts, codeKey].join("+") : "";

    // CAD drawing editor owns the keyboard while a drawing tab is active:
    // yield its editing combos (and bare command letters) so they reach the
    // CAD hotkey layer instead of being swallowed here.
    try {
      const ownsKeys = (window as unknown as { __obsCadOwnsKeys?: () => boolean }).__obsCadOwnsKeys;
      if (typeof ownsKeys === "function" && ownsKeys()) {
        if (CAD_EDITOR_COMBOS.has(combo) || (physCombo && CAD_EDITOR_COMBOS.has(physCombo))) return;
        if (!parts.length && /^[a-z]$/.test(key)) return;
      }
    } catch { /* CAD bridge unavailable — normal registry behaviour */ }

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