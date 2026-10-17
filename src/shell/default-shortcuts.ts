/** Default keyboard shortcuts (Revit + Blender hybrid + AccuDraw).
 *
 * Two-letter sequences for tools (WA, SL, CM …), single-letter modals for
 * the gizmo (G, R, S, Q), modifier combos for app commands (Ctrl+S, Ctrl+O,
 * Ctrl+N, Ctrl+Z, Ctrl+Y, Ctrl+A, F5), and AccuDraw axis reservation
 * (X / Z / Y / Tab while a base point is active).
 *
 * Walk mode owns W A S D Shift Ctrl Space C — every shortcut registered
 * here is filtered by the walk handler when it fires.
 */
import { ctx } from "../core/context";
import { history } from "../features/history";
import { selection } from "../features/selection";
import { snapping } from "../features/snapping";
import { gizmo, type GizmoMode } from "../features/gizmo";
import { shortcuts } from "../features/shortcuts";
import { accuDraw } from "../features/accudraw";

import { saveProject, createProject, getCurrentProject } from "../modules/projects/projects";
import { pickAndImport } from "../features/file-interop";
import { showHome } from "../shell/home-screen";
import { runElementClashDetection } from "../features/clash";
import { toggleWalkMode, isWalkModeEnabled } from "../features/walk-mode";

export function registerDefaultShortcuts(): void {
  const setGizmo = (m: GizmoMode) => {
    gizmo.setMode(m);
    (window as any).__obs_setGizmo?.(m);
  };

  /* ── App / file ───────────────────────────────────────────────────── */
  shortcuts.register({
    id: "app-save", label: "Save project", keys: "ctrl+s", category: "app",
    handler: () => { void saveProject(); },
  });
  shortcuts.register({
    id: "app-open", label: "Open any file", keys: "ctrl+o", category: "app",
    handler: () => { void pickAndImport(); },
  });
  shortcuts.register({
    id: "app-new", label: "New project", keys: "ctrl+n", category: "app",
    handler: () => {
      const name = prompt("New project name:", "Untitled");
      if (name == null) return;
      void createProject(name.trim() || "Untitled");
    },
  });
  shortcuts.register({
    id: "app-home", label: "Home screen", keys: "ctrl+h", category: "app",
    handler: () => showHome(),
  });
  shortcuts.register({
    id: "app-run-clash", label: "Run clash test", keys: "f5", category: "app",
    handler: () => { void runElementClashDetection(); },
  });
  shortcuts.register({
  id: "app-clash-review",
  label: "Toggle Clash Review window",
  keys: "ctrl+shift+c",
  category: "app",
  handler: () => {
    const fn = (window as any).__obs_toggleClashReview;
    if (typeof fn === "function") fn();
  },
});
  shortcuts.register({
    id: "app-toggle-walk", label: "Toggle walk mode", keys: "ctrl+w", category: "app",
    when: () => true,
    handler: () => { try { toggleWalkMode(); } catch { /* */ } },
  });
  shortcuts.register({
    id: "app-exit-walk", label: "Exit walk mode", keys: "shift+escape", category: "app",
    when: () => isWalkModeEnabled(),
    handler: () => {
      const fn = (ctx.features as any).walkMode?.disable;
      if (typeof fn === "function") fn();
    },
  });

  /* ── Edit ─────────────────────────────────────────────────────────── */
  shortcuts.register({
    id: "undo", label: "Undo", keys: "ctrl+z", category: "edit",
    handler: () => {
      if (!history.canUndo()) {
        try {
          window.dispatchEvent(new CustomEvent("obs-toast", {
            detail: { message: "Nothing to undo", kind: "warn" },
          }));
        } catch { /* */ }
        return;
      }
      void history.undo();
    },
  });
  shortcuts.register({
    id: "redo-ctrl-shift-z", label: "Redo", keys: "ctrl+shift+z", category: "edit",
    handler: () => { void history.redo(); },
  });
  shortcuts.register({
    id: "redo-ctrl-y", label: "Redo", keys: "ctrl+y", category: "edit",
    handler: () => { void history.redo(); },
  });
  shortcuts.register({
    id: "redo-ctrl-r", label: "Redo", keys: "ctrl+r", category: "edit",
    handler: () => { void history.redo(); },
  });

  /* ── Selection ────────────────────────────────────────────────────── */
  shortcuts.register({
    id: "select-all", label: "Select all", keys: "ctrl+a", category: "select",
    handler: () => { void selection.selectAll(); },
  });
  shortcuts.register({
    id: "cancel-or-clear",
    label: "Cancel tool / Clear selection",
    keys: "escape",
    category: "select",
    when: () => !isWalkModeEnabled(),
    handler: async () => {
      // Floor Plan owns Esc when open
      try {
        if ((window as any).__obsPlanVisible?.()) return;
      } catch { /* */ }
      // Revit-style Esc:
      // 1) Cancel active authoring tool (wall, duct, move…) → Select
      // 2) If already Select, clear selection
      try {
        const auth = (ctx.features as any).authoring;
        const tool = auth?.getActiveTool?.();
        if (tool && tool !== "select" && tool !== null) {
          // Preserve lastCommand for Space-bar repeat
          const last = auth?.getLastCommand?.();
          auth.setAuthoringTool?.("select");
          if (last && auth.setLastCommand) auth.setLastCommand(last);
          try {
            window.dispatchEvent(
              new CustomEvent("obs-toast", { detail: { message: "Cancelled — Select", kind: "info" } }),
            );
          } catch { /* */ }
          try { (window as any).obsRefreshRibbon?.(); } catch { /* */ }
          return;
        }
      } catch (err) {
        console.warn("[shortcuts] Esc cancel tool failed", err);
      }

      // Clear model + authored selection
      try {
        selection.clear();
        await selection.applyToHighlighter();
      } catch { /* */ }
      try {
        const auth = (ctx.features as any).authoring;
        auth?.setSelectedAuthored?.([]);
        // force clear via select tool path
        const ids = auth?.getSelectedIds?.() ?? [];
        if (ids.length) {
          auth?.setAuthoringTool?.("select");
          // clear by selecting none - use delete path's clear if available
          try {
            const selected = auth.getSelectedIds?.() ?? [];
            for (const id of selected) {
              /* cleared via setSelectedAuthored */
            }
            auth.setSelectedAuthored?.([]);
          } catch { /* */ }
        }
      } catch { /* */ }
      try {
        window.dispatchEvent(
          new CustomEvent("obs-toast", { detail: { message: "Selection cleared", kind: "info" } }),
        );
      } catch { /* */ }
    },
  });
  shortcuts.register({
    id: "delete-selection", label: "Delete selection", keys: "delete", category: "edit",
    handler: () => {
      const fn = (ctx.features as any).authoring?.deleteSelectedElement;
      if (fn) fn();
    },
  });

  /* ── Modal gizmo (Blender) ────────────────────────────────────────── */
  shortcuts.register({ id: "gizmo-move",   label: "Move gizmo",     keys: "g", category: "modal", handler: () => setGizmo("move") });
  shortcuts.register({ id: "gizmo-rotate", label: "Rotate gizmo",   keys: "r", category: "modal", handler: () => setGizmo("rotate") });
  shortcuts.register({ id: "gizmo-scale",  label: "Scale gizmo",    keys: "s", category: "modal", handler: () => setGizmo("scale") });
  shortcuts.register({ id: "gizmo-none",   label: "Selection mode", keys: "q", category: "modal", handler: () => setGizmo("none") });

  /* ── Authoring two-letter ────────────────────────────────────────── */
  const authoring = () => (ctx.features as any).authoring;
  const setTool = (tool: string | null) => authoring()?.setAuthoringTool?.(tool);

  const toolList: { id: string; label: string; keys: string; tool: string }[] = [
    { id: "tool-wall",    label: "Wall",          keys: "wa", tool: "wall" },
    { id: "tool-slab",    label: "Slab",          keys: "sl", tool: "slab" },
    { id: "tool-column",  label: "Column",        keys: "cm", tool: "column" },
    { id: "tool-beam",    label: "Beam",          keys: "bm", tool: "beam" },
    { id: "tool-brace",   label: "Brace",         keys: "br", tool: "brace" },
    { id: "tool-truss",   label: "Truss",         keys: "tr", tool: "truss" },
    { id: "tool-footing", label: "Footing",       keys: "ft", tool: "footing" },
    { id: "tool-strip",   label: "Strip footing", keys: "sf", tool: "strip" },
    { id: "tool-duct",    label: "Duct",          keys: "du", tool: "duct" },
    { id: "tool-pipe",    label: "Pipe",          keys: "pp", tool: "pipe" },
    { id: "tool-grid",    label: "Grid",          keys: "gr", tool: "grid" },
    { id: "tool-level",   label: "Level",         keys: "lv", tool: "level" },
    { id: "tool-door",    label: "Door",          keys: "dr", tool: "door" },
    { id: "tool-window",  label: "Window",        keys: "wn", tool: "window" },
  ];
  for (const t of toolList) {
    shortcuts.register({
      id: t.id, label: t.label, keys: t.keys, category: "tool",
      handler: () => setTool(t.tool),
    });
  }

    /* ── Direct Modeling (SketchUp-parity) ─────────────────────────────── */
  shortcuts.register({
    id: "push-pull-shortcut",
    label: "Push/Pull",
    keys: "pu",
    category: "tool",
    handler: () => {
      try {
        const pp = (ctx.features as any).pushPull;
        if (pp?.isEnabled?.()) pp.disable(); else pp?.enable?.();
      } catch { /* */ }
    },
  });
  shortcuts.register({
    id: "rectangle-shortcut",
    label: "Rectangle",
    keys: "re",
    category: "tool",
    handler: () => {
      try { (ctx.features as any).primitives?.activateRectangle?.(); } catch { /* */ }
    },
  });
  shortcuts.register({
    id: "circle-shortcut",
    label: "Circle",
    keys: "ci",
    category: "tool",
    handler: () => {
      try { (ctx.features as any).primitives?.activateCircle?.(); } catch { /* */ }
    },
  });
/* ── View ─────────────────────────────────────────────────────────── */
  shortcuts.register({
    id: "fit", label: "Fit to view", keys: "f", category: "view",
    handler: () => {
      const fn = (ctx.features as any).cameraTools?.fitAll;
      if (fn) fn();
      else void import("../features/camera-tools").then((m) => m.fitAll());
    },
  });
  shortcuts.register({
    id: "home-view", label: "Home view", keys: "h", category: "view",
    handler: () => {
      const fn = (ctx.features as any).cameraTools?.goHome;
      if (fn) fn();
      else void import("../features/camera-tools").then((m) => m.goHome());
    },
  });

  /* ── Snap ─────────────────────────────────────────────────────────── */
  shortcuts.register({
    id: "snap-toggle", label: "Toggle snapping", keys: "shift+s", category: "tool",
    handler: () => {
      const on = !snapping.isEnabled();
      snapping.setEnabled(on);
    },
  });

  /* ── Ortho hold ─────────────────────────────────────────────────── */
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") snapping.clearOrtho();
  });

  /* ── Live gizmo refresh on selection changes ─────────────────────── */
  selection.onChange(() => {
    if (gizmo.getMode() !== "none") void gizmo.refresh();
  });

  /* ── Walk mode toggled from anywhere ─────────────────────────────── */
  window.addEventListener("obs:walk-mode-changed", () => { /* ribbon re-renders itself */ });

  /* ── AccuDraw key reservation ─────────────────────────────────────── */
  // AccuDraw's own keydown listener runs in capture phase and stops
  // propagation for X / Z / Y / Tab while a base point is active. The
  // registrations below are belt-and-braces: they prevent the app-level
  // two-letter buffer from ever treating X / Z / Y as a starting letter
  // when AccuDraw is engaged.
  const accuActive = () => {
    try { return accuDraw.isActive(); } catch { return false; }
  };
  shortcuts.register({ id: "accu-noop-x",   label: "AccuDraw X",   keys: "x",   category: "tool", when: accuActive, handler: () => { /* handled in accudraw.ts */ } });
  shortcuts.register({ id: "accu-noop-z",   label: "AccuDraw Z",   keys: "z",   category: "tool", when: accuActive, handler: () => { /* handled in accudraw.ts */ } });
  shortcuts.register({ id: "accu-noop-y",   label: "AccuDraw Y",   keys: "y",   category: "tool", when: accuActive, handler: () => { /* handled in accudraw.ts */ } });
  shortcuts.register({ id: "accu-noop-tab", label: "AccuDraw Tab", keys: "tab", category: "tool", when: accuActive, handler: () => { /* handled in accudraw.ts */ } });

  console.log("[shortcuts] registered", shortcuts.list().length, "commands");
}