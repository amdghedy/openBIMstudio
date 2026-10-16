/**
 * Registers all built-in UI items with the ui-registry.
 *
 * Called once during boot, after every feature has been set up so the
 * features object is populated.
 */

import { ctx } from "../core/context";
import { registerUiItem, loadStoredVisibility, persistItem } from "../modules/ui-registry";

function getFeatures(): any { return ctx.features as any; }

export function registerUiItems(): void {
  const F = getFeatures();
  const stored = loadStoredVisibility();

  const safeToggle = (id: string, toggle: () => void) => {
    try { toggle(); } catch { /* */ }
    persistItem(id, true);
  };

  // ── ViewCube ─────────────────────────────────────────────────────
  registerUiItem({
    id: "viewcube",
    label: "ViewCube",
    group: "panels",
    available: true,
    isVisible: () => {
      try { return !!(F.viewcube && F.viewcube.host && F.viewcube.host.style.display !== "none"); }
      catch { return false; }
    },
    toggle: () => {
      try {
        const h = F.viewcube?.host as HTMLElement | undefined;
        if (!h) return;
        h.style.display = h.style.display === "none" ? "block" : "none";
        if (F.viewcube?.host?.parentElement) {
          h.style.display = h.style.display === "block" ? "block" : "none";
        }
      } catch { /* */ }
    },
  });

  // ── Navigation Bar ───────────────────────────────────────────────
  registerUiItem({
    id: "nav-bar",
    label: "Navigation Bar",
    group: "panels",
    available: false,
    unavailableHint: "The Navigation Bar is on the roadmap — the ViewCube and view ribbon cover this for now.",
    isVisible: () => false,
    toggle: () => {},
  });

  // ── Project Browser ──────────────────────────────────────────────
  registerUiItem({
    id: "project-browser",
    label: "Project Browser",
    group: "panels",
    available: true,
    isVisible: () => {
      try { return !!F.projectBrowser?.isVisible?.(); } catch { return false; }
    },
    toggle: () => {
      try { F.projectBrowser?.toggle?.(); } catch { /* */ }
    },
  });

  // ── System Browser ───────────────────────────────────────────────
  registerUiItem({
    id: "system-browser",
    label: "System Browser",
    group: "panels",
    available: false,
    unavailableHint: "MEP System Browser not yet implemented. Use the Model Tree for MEP categories.",
    isVisible: () => false,
    toggle: () => {},
  });

  // ── Properties
  registerUiItem({
    id: "family-browser",
    label: "Family Browser",
    group: "panels",
    available: true,
    isVisible: () => {
      try { return !!F.familyBrowser?.isVisible?.(); } catch { return false; }
    },
    toggle: () => {
      try { F.familyBrowser?.toggle?.(); } catch { /* */ }
    },
  });
  // ----------------------------------------------------------------
  registerUiItem({
    id: "properties",
    label: "Properties",
    group: "panels",
    available: true,
    isVisible: () => {
      try { return !!F.propertyPalette?.isVisible?.(); } catch { return false; }
    },
    toggle: () => {
      try { F.propertyPalette?.toggle?.(); } catch { /* */ }
    },
  });

  // ── MEP Fabrication Parts ────────────────────────────────────────
  registerUiItem({
    id: "mep-fabrication",
    label: "MEP Fabrication Parts",
    group: "panels",
    available: false,
    unavailableHint: "Fabrication-parts catalog integration is on the roadmap.",
    isVisible: () => false,
    toggle: () => {},
  });

  // ── P&ID Modeler ─────────────────────────────────────────────────
  registerUiItem({
    id: "pid-modeler",
    label: "P&ID Modeler",
    group: "panels",
    available: false,
    unavailableHint: "P&ID Modeler is on the roadmap.",
    isVisible: () => false,
    toggle: () => {},
  });

  // ── Status Bar ───────────────────────────────────────────────────
  // ---- Advanced / Critical Gaps toolbar (open / close) -----------------
  // The [D] [H] [S] [A] [L] [C] [R] [P] toolbar. Starts hidden.
  registerUiItem({
    id: "critical-gaps-toolbar",
    label: "Advanced Toolbar ([D] [H] [S] ...)",
    group: "bars",
    available: true,
    isVisible: () => {
      try {
        return !!(window as any).__obsCriticalGapsUI?.isVisible?.();
      } catch {
        return false;
      }
    },
    toggle: () => {
      try {
        (window as any).__obsCriticalGapsUI?.toggle?.();
      } catch {
        /* */
      }
    },
  });

  registerUiItem({
    id: "status-bar",
    label: "Status Bar",
    group: "bars",
    available: true,
    isVisible: () => {
      const el = document.querySelector(".bb-status") as HTMLElement | null;
      return !!el && el.style.display !== "none";
    },
    toggle: () => {
      const el = document.querySelector(".bb-status") as HTMLElement | null;
      if (!el) return;
      el.style.display = el.style.display === "none" ? "" : "none";
      window.dispatchEvent(new Event("resize"));
    },
  });

  // ── Status Bar · Worksets ────────────────────────────────────────
  registerUiItem({
    id: "status-bar-worksets",
    label: "Status Bar - Worksets",
    group: "bars",
    available: true,
    isVisible: () => {
      try { return !!F.worksetsBadge?.isVisible?.(); } catch { return false; }
    },
    toggle: () => {
      try {
        if (F.worksetsBadge?.toggle) F.worksetsBadge.toggle();
        else toggleStatusBadge("worksets");
      } catch { toggleStatusBadge("worksets"); }
    },
  });

  // ── Status Bar · Design Options ──────────────────────────────────
  registerUiItem({
    id: "status-bar-design-options",
    label: "Status Bar - Design Options",
    group: "bars",
    available: true,
    isVisible: () => {
      try { return !!F.designOptionsBadge?.isVisible?.(); } catch { return false; }
    },
    toggle: () => {
      try {
        if (F.designOptionsBadge?.toggle) F.designOptionsBadge.toggle();
        else toggleStatusBadge("design-options");
      } catch { toggleStatusBadge("design-options"); }
    },
  });

  void safeToggle;
  void stored;
}

/** Adds a small label to the bottom status bar for a named feature. */
function toggleStatusBadge(kind: "worksets" | "design-options"): void {
  const bar = document.querySelector(".bb-status") as HTMLElement | null;
  if (!bar) return;
  const id = "obs-status-" + kind;
  const existing = document.getElementById(id);
  if (existing) { existing.remove(); return; }

  const label = document.createElement("span");
  label.id = id;
  label.className = "bb-status__seg";
  label.style.cssText = "padding:0 6px;font-size:10.5px;color:#94a3b8;opacity:.9";
  label.textContent = kind === "worksets" ? "Worksets: 1" : "Design Options: Main";
  bar.appendChild(label);
}