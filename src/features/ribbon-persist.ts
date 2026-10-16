// openbim-fix:ribbon-persist
//
// Remembers the ribbon's active tab and every panel group's collapse
// state across page reloads.
//
// Implementation strategy: observe the ribbon from the outside so this
// module never has to know the ribbon's internal class names, tab ids,
// or collapse mechanism. That means it works today, works after any
// future refactor of shell/ribbon.ts, and cannot break the existing
// regression guard.
//
//   1. A MutationObserver watches for the .obs-ribbon element.
//   2. Once found, it scans for the currently active tab and for every
//      collapsible group. Both are identified by a small set of
//      fallback selectors, so a change of class name degrades to
//      "feature disabled" rather than "feature broken".
//   3. A capturing click listener records every tab / group-header
//      click.
//   4. State is written to localStorage["obs.ribbon.state.v1"] on
//      click and on beforeunload.
//   5. On boot, the saved state is reapplied.

const STORAGE_KEY = "obs.ribbon.state.v1";

export interface RibbonState {
  activeTab: string | null;
  collapsedGroups: string[];
}

// Selectors tried in order. First match wins. Kept short on purpose --
// the goal is generic discovery, not perfect capture of every style.
const TAB_SELECTORS = [
  ".obs-ribbon__tab",
  "[data-ribbon-tab]",
  "[data-tab]",
  "button[role='tab']",
];

const GROUP_SELECTORS = [
  "bim-panel-section",
  "[data-ribbon-group]",
  ".obs-ribbon__group",
  ".obs-ribbon__panel",
];

function pickSelector(root: ParentNode, list: string[]): {
  selector: string;
  nodes: Element[];
} {
  for (const sel of list) {
    const nodes = Array.from(root.querySelectorAll(sel));
    if (nodes.length) return { selector: sel, nodes };
  }
  return { selector: "", nodes: [] };
}

function readState(): RibbonState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { activeTab: null, collapsedGroups: [] };
    const parsed = JSON.parse(raw) as Partial<RibbonState>;
    return {
      activeTab: typeof parsed.activeTab === "string" ? parsed.activeTab : null,
      collapsedGroups: Array.isArray(parsed.collapsedGroups)
        ? parsed.collapsedGroups.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return { activeTab: null, collapsedGroups: [] };
  }
}

function writeState(s: RibbonState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
  catch { /* storage unavailable -- not fatal */ }
}

function isGroupCollapsed(node: Element): boolean {
  // Three common collapse conventions, all treated as equivalent.
  if (node.hasAttribute("collapsed")) return true;
  if (node.getAttribute("data-collapsed") === "1") return true;
  if (node.getAttribute("data-open") === "0") return true;
  // If the group contains a body whose display is none, treat as collapsed.
  const body = node.querySelector("[data-ribbon-group-body], .obs-ribbon__group-body, .obs-ribbon__panel-body");
  if (body && (body as HTMLElement).style.display === "none") return true;
  return false;
}

function setGroupCollapsed(node: Element, collapsed: boolean): void {
  // Mirror the same three conventions on write.
  if (collapsed) node.setAttribute("collapsed", "");
  else node.removeAttribute("collapsed");
  node.setAttribute("data-collapsed", collapsed ? "1" : "0");

  // Also drive the body if one exists.
  const body = node.querySelector("[data-ribbon-group-body], .obs-ribbon__group-body, .obs-ribbon__panel-body") as HTMLElement | null;
  if (body) body.style.display = collapsed ? "none" : "";
}

function tabIdOf(el: Element): string | null {
  const explicit =
    el.getAttribute("data-ribbon-tab") ??
    el.getAttribute("data-tab") ??
    el.getAttribute("data-id");
  if (explicit) return explicit;
  const text = (el.textContent ?? "").trim();
  return text ? text.slice(0, 40) : null;
}

function groupIdOf(el: Element, index: number): string {
  const explicit =
    el.getAttribute("data-ribbon-group") ??
    el.getAttribute("data-group") ??
    el.getAttribute("data-id") ??
    el.getAttribute("label");
  if (explicit) return explicit;
  const head = el.querySelector("header, [data-ribbon-group-head], .obs-ribbon__group-head");
  const text = (head?.textContent ?? el.textContent ?? "").trim();
  return text ? text.slice(0, 40) + "#" + index : "group#" + index;
}

let installed = false;

export function setupRibbonPersist(): void {
  if (installed) return;
  installed = true;

  const applyTo = (ribbon: Element): void => {
    const saved = readState();

    // Restore active tab.
    if (saved.activeTab) {
      const tabs = pickSelector(ribbon, TAB_SELECTORS);
      for (const t of tabs.nodes) {
        if (tabIdOf(t) === saved.activeTab) {
          try { (t as HTMLElement).click(); } catch { /* */ }
          break;
        }
      }
    }

    // Restore collapsed groups.
    const groups = pickSelector(ribbon, GROUP_SELECTORS);
    const wanted = new Set(saved.collapsedGroups);
    groups.nodes.forEach((g, i) => {
      const id = groupIdOf(g, i);
      const shouldCollapse = wanted.has(id);
      if (shouldCollapse !== isGroupCollapsed(g)) {
        setGroupCollapsed(g, shouldCollapse);
      }
    });

    console.log(
      "[ribbon-persist] restored Â· tab=" + (saved.activeTab ?? "default") +
      " Â· collapsed=" + saved.collapsedGroups.length,
    );
  };

  const onRibbonClick = (ev: MouseEvent): void => {
    const target = ev.target as Element | null;
    if (!target) return;
    const ribbon = target.closest(".obs-ribbon");
    if (!ribbon) return;

    // Tab click?
    const tabSel = TAB_SELECTORS.join(",");
    const tab = target.closest(tabSel);
    if (tab) {
      const state = readState();
      const next = tabIdOf(tab);
      if (next && next !== state.activeTab) {
        state.activeTab = next;
        writeState(state);
      }
      return;
    }

    // Group header click? We accept a click anywhere on the group and
    // re-scan afterwards so we do not have to know where the header is.
    const groupSel = GROUP_SELECTORS.join(",");
    const group = target.closest(groupSel);
    if (group) {
      // Read fresh collapse states for every group after the click lands.
      // A microtask is enough because the ribbon updates synchronously.
      Promise.resolve().then(() => {
        const groups = pickSelector(ribbon, GROUP_SELECTORS);
        const state = readState();
        const collapsed: string[] = [];
        groups.nodes.forEach((g, i) => {
          if (isGroupCollapsed(g)) collapsed.push(groupIdOf(g, i));
        });
        state.collapsedGroups = collapsed;
        writeState(state);
      });
    }
  };

  // Install a MutationObserver that finds the ribbon the first time it
  // appears and then disconnects.
  const observer = new MutationObserver(() => {
    const ribbon = document.querySelector(".obs-ribbon");
    if (!ribbon) return;
    observer.disconnect();
    applyTo(ribbon);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // If the ribbon is already mounted, apply right now.
  const existing = document.querySelector(".obs-ribbon");
  if (existing) {
    observer.disconnect();
    applyTo(existing);
  }

  // Global capture listener for tab + group clicks.
  document.addEventListener("click", onRibbonClick, true);

  // Save on unload.
  window.addEventListener("beforeunload", () => {
    const ribbon = document.querySelector(".obs-ribbon");
    if (!ribbon) return;
    const state = readState();
    const groups = pickSelector(ribbon, GROUP_SELECTORS);
    const collapsed: string[] = [];
    groups.nodes.forEach((g, i) => {
      if (isGroupCollapsed(g)) collapsed.push(groupIdOf(g, i));
    });
    state.collapsedGroups = collapsed;
    writeState(state);
  });

  (window as any).__obsRibbonPersist = {
    save: () => {
      const ribbon = document.querySelector(".obs-ribbon");
      if (!ribbon) return null;
      const groups = pickSelector(ribbon, GROUP_SELECTORS);
      const collapsed: string[] = [];
      groups.nodes.forEach((g, i) => {
        if (isGroupCollapsed(g)) collapsed.push(groupIdOf(g, i));
      });
      const state = readState();
      state.collapsedGroups = collapsed;
      writeState(state);
      return state;
    },
    restore: () => {
      const ribbon = document.querySelector(".obs-ribbon");
      if (!ribbon) return;
      applyTo(ribbon);
    },
    reset: () => {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
      try {
        window.dispatchEvent(new CustomEvent("obs-toast", {
          detail: { message: "Ribbon layout reset", kind: "success" },
        }));
      } catch { /* */ }
    },
    read: readState,
  };

  console.log("[ribbon-persist] ready");
}