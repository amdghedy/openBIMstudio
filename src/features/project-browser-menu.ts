/**
 * Project Browser right-click menu — Revit 2D environment audit gap G11.
 *
 * Pure, DOM-free model: menuItemsForNode(node, caps) returns the exact
 * menu for a tree node, or null when the node has no applicable action and
 * gets no menu rather than a fake one. Every listed action is executed for
 * real by the panel layer (src/features/project-browser.ts) against the
 * stores that own the data — nothing here is a stub or a "planned" entry.
 *
 * Menu rules (Revit-style):
 * - Named leaves (stored view, saved view, sheet, family, family type,
 *   selection set, phase) get Open / Rename / Duplicate / Delete.
 * - Built-in families keep Rename and Duplicate but Delete is disabled
 *   with a reason: the family store refuses to remove built-ins.
 * - Single-purpose leaves (the built-in 3D / Floor Plan entries, materials,
 *   links, the two built-in schedule entries) get Open only.
 * - Root and group nodes get their creation actions: New View / New Sheet /
 *   New Phase / New Material / Save Current View, plus the panel each
 *   group opens, and Expand All where the group has children.
 * - New Selection Set is disabled with an empty selection: a set is saved
 *   from the current selection, so with none there is nothing to save.
 * - Empty placeholders offer only their creation action (Create Default
 *   Sheet Set / Create Default Phases); guidance-only placeholders
 *   (save-a-set-first, no-models) get no menu.
 */
import type { ProjectBrowserNode } from "./project-browser-tree";

export type ProjectBrowserMenuActionId =
  | "open"
  | "rename"
  | "duplicate"
  | "delete"
  | "new-view"
  | "save-view"
  | "new-sheet"
  | "new-phase"
  | "new-material"
  | "new-set"
  | "create-default-sheets"
  | "create-default-phases"
  | "open-schedules"
  | "open-cost"
  | "open-sheets"
  | "open-timeline"
  | "open-model-tree"
  | "open-properties"
  | "expand-all";

export interface ProjectBrowserMenuItem {
  id: ProjectBrowserMenuActionId;
  label: string;
  icon?: string;
  /** Destructive action: rendered in red, confirmed before it runs. */
  danger?: boolean;
  /** Offered but not runnable right now; the reason is shown as a tooltip. */
  disabled?: boolean;
  disabledReason?: string;
}

export interface ProjectBrowserMenuCaps {
  /** A non-empty authored/linked selection exists (enables New Selection Set). */
  hasSelection?: boolean;
}

function item(
  id: ProjectBrowserMenuActionId,
  label: string,
  extra: Partial<ProjectBrowserMenuItem> = {},
): ProjectBrowserMenuItem {
  return { id, label, ...extra };
}

const OPEN = item("open", "Open", { icon: "↗" });
const RENAME = item("rename", "Rename…", { icon: "✎" });
const DUPLICATE = item("duplicate", "Duplicate", { icon: "⧉" });
const DELETE = item("delete", "Delete", { icon: "🗑", danger: true });
const EXPAND_ALL = item("expand-all", "Expand All", { icon: "⤢" });

/** The full leaf menu: Open / Rename / Duplicate / Delete. */
const LEAF_MENU: ProjectBrowserMenuItem[] = [OPEN, RENAME, DUPLICATE, DELETE];

/** "Floor Plans" → "Floor Plan", "3D Views" → "3D View", "Legends" → "Legend". */
function singularGroupLabel(label: string): string {
  return label.endsWith("s") ? label.slice(0, -1) : label;
}

/**
 * The "New …" label for a view-kind subgroup: "New Floor Plan View",
 * "New 3D View" (the kind already ends in View), "New Legend View".
 * Shared with the panel layer so the prompt title matches the menu item.
 */
export function newViewLabel(groupLabel: string): string {
  const singular = singularGroupLabel(groupLabel);
  return singular.endsWith("View") ? `New ${singular}` : `New ${singular} View`;
}

/**
 * The menu for one tree node, or null when the node has no applicable
 * action. Item order is the order shown.
 */
export function menuItemsForNode(
  node: ProjectBrowserNode,
  caps: ProjectBrowserMenuCaps = {},
): ProjectBrowserMenuItem[] | null {
  // Empty placeholders first: they are not entities, so only their
  // creation action applies — and only where one exists.
  if (node.id === "sheet-empty") {
    return [item("create-default-sheets", "Create Default Sheet Set", { icon: "＋" })];
  }
  if (node.id === "phase-empty") {
    return [item("create-default-phases", "Create Default Phases", { icon: "＋" })];
  }
  if (node.id === "grp-empty" || node.id === "link-empty") return null;

  switch (node.kind) {
    case "view-def":
    case "view-saved":
    case "sheet":
    case "family-type":
    case "group":
    case "phase":
      return [...LEAF_MENU];

    case "family": {
      // The family store refuses to remove built-ins, so Delete is shown
      // disabled with the reason instead of a live action that would fail.
      const builtIn = node.meta?.builtIn === true;
      return [
        OPEN,
        RENAME,
        DUPLICATE,
        builtIn
          ? { ...DELETE, disabled: true, disabledReason: "Built-in families cannot be deleted" }
          : DELETE,
      ];
    }

    case "view-3d":
    case "view-plan":
    case "material":
    case "link":
    case "schedule":
      return [OPEN];

    case "views":
      return [item("new-view", "New View", { icon: "＋" }), EXPAND_ALL];

    case "view-group":
      // The Saved Views subgroup saves the current camera; a kind subgroup
      // creates a stored view of that kind.
      if (node.id === "views-saved") {
        return [item("save-view", "Save Current View", { icon: "＋" }), EXPAND_ALL];
      }
      return [
        item("new-view", newViewLabel(node.label), { icon: "＋" }),
        EXPAND_ALL,
      ];

    case "sheets":
      return [
        item("new-sheet", "New Sheet", { icon: "＋" }),
        item("open-sheets", "Open Sheets Panel", { icon: "📑" }),
        EXPAND_ALL,
      ];

    case "schedules":
      return [
        item("open-schedules", "Open Schedules Panel", { icon: "📋" }),
        item("open-cost", "Open Cost / QTO", { icon: "💰" }),
      ];

    case "families":
      return [item("open-properties", "Open Properties", { icon: "ⓘ" }), EXPAND_ALL];

    case "materials":
      return [item("new-material", "New Material", { icon: "＋" }), EXPAND_ALL];

    case "groups":
      return [
        caps.hasSelection
          ? item("new-set", "New Selection Set", { icon: "＋" })
          : item("new-set", "New Selection Set", {
              icon: "＋",
              disabled: true,
              disabledReason: "Select elements first — a set is saved from the current selection",
            }),
        EXPAND_ALL,
      ];

    case "links":
      return [item("open-model-tree", "Open Model Tree", { icon: "🔗" }), EXPAND_ALL];

    case "phases":
      return [
        item("new-phase", "New Phase", { icon: "＋" }),
        item("open-timeline", "Open Timeline", { icon: "⏱" }),
        EXPAND_ALL,
      ];

    default:
      return null;
  }
}
