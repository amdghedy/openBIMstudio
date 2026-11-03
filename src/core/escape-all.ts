/**
 * Global "Escape resets everything" orchestrator — one ESC press cancels ALL
 * active orders, tools, previews and in-progress modifications.
 *
 * Problem this module solves: the app previously had three overlapping Escape
 * paths — the input-router (first-true-consumes), the bim-mouse-policy arbiter
 * (first-consume), and ~50 per-feature window keydown listeners. A single ESC
 * press therefore unwound only the innermost context: a live Move order could
 * stay active while the measure tool was canceled, a rotate preview could
 * survive an ESC that closed the context menu, and whether anything happened
 * at all depended on where keyboard focus was.
 *
 * Contract:
 *   • main.ts calls installEscapeAll() BEFORE setupInputRouter(), so this
 *     window-capture keydown listener is registered first (same target and
 *     phase → registration order) and sees every bare Escape press first.
 *   • On a bare Escape (no modifiers, target not an editable field) it runs
 *     EVERY registered scope's cancel() — not first-wins — collects the ids
 *     that actually canceled something, unsticks the camera gate and any
 *     claimed router gesture, fires the existing "obs:operation-cancelled"
 *     event, and consumes the key (preventDefault + stopImmediatePropagation)
 *     so legacy per-feature listeners do not double-handle the same press.
 *   • With nothing active the key is NOT consumed: modals, the command
 *     palette, dialogs and every legacy listener keep their current behavior.
 *   • Editable targets (input/textarea/select/contenteditable) are skipped —
 *     keystrokes aimed at a field belong to that field (e.g. the temporary
 *     dimension editor cancels itself with its own ESC handling).
 *
 * Feature modules are resolved lazily (background dynamic import at install
 * time) so boot order and code splitting stay untouched. Every adapter is
 * defensive: optional calls, try/catch — a scope that throws is logged and
 * skipped, never blocking the others.
 *
 * Extension point: any feature with cancellable transient state registers a
 * scope via registerEscapeScope({ id, priority, cancel }) instead of growing
 * another private window keydown listener.
 */
import { inputRouter } from "./input-router";
import { forceResumeCameraControls } from "./camera-gate";
import { ctx } from "./context";

type Any = Record<string, any>;

export interface EscapeScope {
  id: string;
  /** Higher priority cancels first. 900 router gestures, 850 modify orders,
   *  800 tool previews, 700 drags/creation, 600 mode switches, 100 UI. */
  priority?: number;
  /** Return true if this scope actually canceled something. */
  cancel: () => boolean;
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as Any;
  if (!el) return false;
  const tag = String(el.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  if (typeof el.closest === "function" &&
      el.closest('input, textarea, select, [contenteditable="true"]')) return true;
  return false;
}

interface Reg extends EscapeScope { __order: number; }

class EscapeAllImpl {
  private scopes: Reg[] = [];
  private seq = 0;
  private installed = false;
  /** Lazily resolved feature modules (background imports at install time). */
  private mods: Any = {};

  register(scope: EscapeScope): () => void {
    const entry: Reg = { ...scope, __order: this.seq++ };
    this.scopes.push(entry);
    this.scopes.sort((a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) || a.__order - b.__order);
    return () => {
      const i = this.scopes.indexOf(entry);
      if (i >= 0) this.scopes.splice(i, 1);
    };
  }

  /** Run every scope; returns the ids that actually canceled something. */
  cancelAll(): string[] {
    const canceled: string[] = [];
    for (const s of [...this.scopes]) {
      try {
        if (s.cancel()) canceled.push(s.id);
      } catch (err) {
        console.error("[escape-all] scope '" + s.id + "' threw", err);
      }
    }
    if (canceled.length) {
      try { forceResumeCameraControls(); } catch { /* */ }
      try { inputRouter.releaseGesture(); } catch { /* */ }
      try { window.dispatchEvent(new CustomEvent("obs:operation-cancelled")); } catch { /* */ }
    }
    return canceled;
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;
    for (const s of builtinScopes(() => this.mods)) this.register(s);
    window.addEventListener("keydown", this.onKey, true);
    this.resolveFeatureMods();
    console.log("[escape-all] installed: one ESC cancels all active orders, tools and previews");
  }

  private async resolveFeatureMods(): Promise<void> {
    const loads: Array<[string, Promise<Any>]> = [
      ["modifyLive", import("../features/modify-live")],
      ["rotate", import("../features/rotate-tool")],
      ["array", import("../features/array-tool")],
      ["multiMove", import("../features/multi-move")],
      ["sectionCut", import("../features/section-cut-interaction")],
      ["cadEngine", import("../modules/cad/cad-engine")],
    ];
    for (const [key, p] of loads) {
      try { this.mods[key] = await p; }
      catch (err) { console.warn("[escape-all] optional module unavailable: " + key, err); }
    }
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (isEditableTarget(e.target)) return;
    const canceled = this.cancelAll();
    if (canceled.length) {
      e.preventDefault();
      e.stopImmediatePropagation();
      try {
        window.dispatchEvent(new CustomEvent("obs-toast", {
          detail: { kind: "info", message: "Cancelled: " + canceled.join(", "), timeout: 1400 },
        }));
      } catch { /* */ }
    }
  };
}

export const escapeAll = new EscapeAllImpl();

export function registerEscapeScope(scope: EscapeScope): () => void {
  return escapeAll.register(scope);
}

export function installEscapeAll(): void {
  escapeAll.install();
}

/* ── Built-in scopes ────────────────────────────────────────────────────
 * Each adapter resolves its target lazily at ESC time, because feature
 * modules install themselves over the whole boot sequence. `false` means
 * "nothing active here" — the sweep keeps going either way.
 * ───────────────────────────────────────────────────────────────────── */
function builtinScopes(getMods: () => Any): EscapeScope[] {
  const W = () => window as Any;
  const F = () => (ctx as Any).features as Any | undefined;
  return [
    {
      // Gizmo/box-select/authoring/primitives/push-pull/clash/navigation
      // cancel handlers registered through the input router.
      id: "viewport-router", priority: 900,
      cancel: () => inputRouter.cancelAll() > 0,
    },
    {
      // Live Move/Copy modification orders (CommandHost previews & commits).
      id: "modify-orders", priority: 850,
      cancel: () => {
        const ml: Any = W().__obsModifyLive;
        const mods = getMods();
        const isActive = typeof ml?.isActive === "function"
          ? !!ml.isActive()
          : mods.modifyLive?.isModifyLiveActive?.() === true;
        if (!isActive) return false;
        if (typeof ml?.escape === "function") {
          try { return ml.escape() === true; } catch { /* fall through */ }
        }
        return mods.modifyLive?.modifyLiveEscape?.() === true;
      },
    },
    {
      id: "rotate-preview", priority: 800,
      cancel: () => {
        const r: Any = getMods().rotate;
        if (!r || (typeof r.isRotateActive === "function" && !r.isRotateActive())) return false;
        return r.cancelRotate?.() === true;
      },
    },
    {
      id: "array-preview", priority: 800,
      cancel: () => {
        const a: Any = getMods().array;
        if (!a || (typeof a.isArrayActive === "function" && !a.isArrayActive())) return false;
        return a.cancelArray?.() === true;
      },
    },
    {
      id: "multi-move-preview", priority: 800,
      cancel: () => {
        const mm: Any = getMods().multiMove;
        if (!mm || (typeof mm.isMultiMoveActive === "function" && !mm.isMultiMoveActive())) return false;
        return mm.cancelMultiMove?.() === true;
      },
    },
    {
      // In-flight section-plane handle drag.
      id: "section-cut-drag", priority: 700,
      cancel: () => getMods().sectionCut?.cancelSectionCutDrag?.() === true,
    },
    {
      // Pending measure picks + OBC creation, then exit measure tool.
      id: "measure-tool", priority: 720,
      cancel: () => {
        const m: Any = F()?.measure ?? W().__obsMeasure;
        if (!m) {
          const lm: Any = (ctx as Any).lengthMeasurer;
          if (!lm?.enabled) return false;
          try { lm.cancelCreation?.(); } catch { /* */ }
          try { lm.enabled = false; return true; } catch { return false; }
        }
        try {
          if (typeof m.cancel === "function") return m.cancel() === true;
          let any = false;
          if (typeof m.cancelPending === "function") any = m.cancelPending() === true || any;
          if (typeof m.isEnabled === "function" ? m.isEnabled() : !!m.enabled) {
            m.setMeasureEnabled?.(false); m.disable?.(); any = true;
          }
          return any;
        } catch { return false; }
      },
    },
    {
      // CAD panel polyline in progress.
      id: "cad-poly", priority: 700,
      cancel: () => {
        const ce: Any = getMods().cadEngine?.cadEngine;
        if (!ce) return false;
        try {
          if ((ce.getPolyPoints?.() ?? []).length > 0) { ce.cancelPoly?.(); return true; }
        } catch { /* */ }
        return false;
      },
    },
    {
      // Walk mode (first-person).
      id: "walk-mode", priority: 680,
      cancel: () => {
        const wmode: Any = F()?.walkMode ?? W().__obsWalkMode;
        try {
          if (wmode?.isEnabled?.() || wmode?.isActive?.()) {
            wmode.disable?.(); wmode.setActive?.(false); return true;
          }
        } catch { /* */ }
        return false;
      },
    },
    {
      // Model align tool window / mode.
      id: "model-align", priority: 660,
      cancel: () => {
        const a: Any = F()?.align ?? getMods().modelAlign;
        try {
          if (a?.isVisible?.() || a?.isEnabled?.()) { a.disable?.(); a.hide?.(); a.toggle?.(); return true; }
        } catch { /* */ }
        return false;
      },
    },
    {
      // Section cut mode (planes stay; exit interactive mode).
      id: "section-mode", priority: 650,
      cancel: () => {
        const s: Any = F()?.section ?? W().__obsSection;
        try {
          const on = typeof s?.isEnabled === "function" ? s.isEnabled() : !!s?.isSectionOn?.();
          if (on) {
            if (typeof s.setSectionOn === "function") s.setSectionOn(false);
            else if (typeof s.setOn === "function") s.setOn(false);
            else if (typeof s.toggle === "function") s.toggle();
            s.disable?.();
            return true;
          }
        } catch { /* */ }
        return false;
      },
    },
    {
      // Authoring placement tool → back to select / idle.
      id: "authoring-tool", priority: 640,
      cancel: () => {
        const a: Any = F()?.authoring;
        try {
          const tool = a?.getActiveTool?.();
          if (tool && tool !== "select" && tool !== null) {
            a.setAuthoringTool?.(null); return true;
          }
        } catch { /* */ }
        return false;
      },
    },
    {
      // BIM arbiter: drafting-2D + leftover measure/section/walk flags.
      id: "bim-policy-modes", priority: 600,
      cancel: () => {
        const p: Any = W().__obsBIMMousePolicy;
        if (typeof p?.cancelOperation !== "function") return false;
        try { return p.cancelOperation() === true; } catch { return false; }
      },
    },
    {
      // UI transients: command palette, CAD query, file menu, walk adjust UI.
      id: "ui-transients", priority: 100,
      cancel: () => {
        let any = false;
        const f = F();
        try {
          const cp: Any = f?.commandPalette;
          if (cp?.isOpen?.() === true) { cp.close?.(); any = true; }
        } catch { /* */ }
        try {
          const cq: Any = f?.cadQuery ?? W().__obsCadQuery;
          if (cq?.isOpen?.() === true || (cq?.toggle && document.getElementById("obs-cad-query-panel")?.style.display !== "none")) {
            cq.close?.(); cq.hide?.(); any = true;
          }
        } catch { /* */ }
        try {
          const fm: Any = f?.fileMenu;
          if (fm?.isVisible?.()) { fm.hide?.(); fm.close?.(); any = true; }
        } catch { /* */ }
        try {
          const adj = document.getElementById("walk-adjust-ui");
          if (adj) { adj.remove(); any = true; }
        } catch { /* */ }
        return any;
      },
    },
  ];
}
