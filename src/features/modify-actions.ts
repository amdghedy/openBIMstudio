/**
 * Shared Modify actions for authored (native) elements.
 * Used by context-menu and element-context-menu.
 *
 * Tools that need multi-click placement call setAuthoringTool (left-click
 * completes the op via authoring.onModifyClick). Immediate ops run directly.
 */
import {
  setAuthoringTool,
  getActiveTool,
  getSelectedIds,
  deleteSelectedElement,
  pinSelected,
  createSimilarFromSelection,
  splitSelectedAtMidpoint,
  alignSelectedAxis,
  getElementById,
  getElements,
} from "./authoring";
import { gizmo, type GizmoMode } from "./gizmo";
import { listModifyCommandDefinitions, resolveModifyCapability, type ModifyCommandId } from "../modules/modify/registry";
import { ctx } from "../core/context";

type Any = Record<string, any>;

export type ModifyActionId = ModifyCommandId;

export interface ModifyActionDef {
  id: ModifyActionId;
  label: string;
  icon?: string;
  shortcut?: string;
  /** Requires at least one selected authored element (except paste). */
  needsSelection?: boolean;
  /** Requires 2+ selected. */
  needsMulti?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
}

/** Clipboard for Copy → Paste of authored element definitions. */
let clipboard: Any[] = [];

export function getModifyClipboardCount(): number {
  return clipboard.length;
}

function toast(message: string, kind: "info" | "success" | "warn" | "error" = "info") {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
  } catch { /* */ }
}

function selectionIds(): string[] {
  try {
    return (getSelectedIds() as string[]) ?? [];
  } catch {
    return [];
  }
}

/** Snapshot current authored selection into the modify clipboard. */
export function copySelectionToClipboard(): number {
  const ids = selectionIds();
  const els: Any[] = [];
  for (const id of ids) {
    try {
      const el = getElementById(id);
      if (el) els.push(JSON.parse(JSON.stringify(el)));
    } catch { /* skip */ }
  }
  clipboard = els;
  if (els.length) toast(`Copied ${els.length} element(s)`, "success");
  else toast("Nothing to copy — select authored element(s).", "warn");
  return els.length;
}

/**
 * Paste clipboard: place copies offset slightly so they are visible.
 * Prefer running createSimilar / copy tool when available; fallback clones with offset.
 */
export function pasteFromClipboard(): number {
  if (!clipboard.length) {
    toast("Clipboard empty — Copy elements first.", "warn");
    return 0;
  }
  try {
    const auth = (window as Any).__obsAuthoring;
    if (typeof auth?.pasteClipboard === "function") {
      const n = auth.pasteClipboard(clipboard);
      toast(`Pasted ${n} element(s)`, "success");
      return n;
    }
  } catch { /* */ }

  try {
    const first = clipboard[0];
    if (first?.id) {
      createSimilarFromSelection();
      toast("Paste — place instance (Create Similar)", "info");
      return 1;
    }
  } catch { /* */ }

  toast("Paste: use Copy tool then place, or Create Similar.", "info");
  return 0;
}

export function runModifyAction(id: ModifyActionId): void {
  const ids = selectionIds();
  const has = ids.length > 0;

  switch (id) {
    case "move":
      setAuthoringTool("move");
      toast(has ? "Move — click a base point, then the target" : "Move — click element, then base point, then target", "info");
      break;
    case "copy":
      copySelectionToClipboard();
      setAuthoringTool("copy");
      toast(has ? "Copy — click a base point, then the target" : "Copy — click element, base point, then target", "info");
      break;
    case "paste":
      pasteFromClipboard();
      break;
    case "rotate":
      setAuthoringTool("rotate");
      toast(has ? "Rotate — click the center, then the reference angle" : "Rotate: select elements first, then pick Rotate", "info");
      break;
    case "mirror":
      setAuthoringTool("mirror");
      toast(has ? "Mirror — click the mirror line start and end" : "Mirror: select elements first, then pick Mirror", "info");
      break;
    case "array":
      setAuthoringTool("array");
      toast("Array — click base point, enter count / spacing", "info");
      break;
    case "offset":
      setAuthoringTool("offset");
      toast("Offset — click a linear element, then offset side", "info");
      break;
    case "scale":
      try {
        gizmo.setMode("scale" as GizmoMode);
        (window as Any).__obs_setGizmo?.("scale");
        toast("Scale gizmo — drag handles on selection", "info");
      } catch {
        toast("Scale gizmo unavailable", "warn");
      }
      break;
    case "create-similar":
      try {
        createSimilarFromSelection();
        toast("Create Similar — place next instance", "info");
      } catch {
        (window as Any).__obsRevitParity?.createSimilar?.(ids[0]);
        toast("Create Similar", "info");
      }
      break;
    case "match-props":
      (window as Any).__obsRevitParity?.matchProperties?.(ids[0]);
      (ctx.features as any).bimParity?.matchProperties?.(ids[0]);
      toast("Match Properties — pick target", "info");
      break;
    case "select-similar":
      void (async () => {
        try {
          const sel = (window as Any).__obsSelection;
          if (!sel?.selectSimilar || !ids[0]) {
            toast("Select Similar works on an authored element - select one first.", "warn");
            return;
          }
          await sel.selectSimilar("native", ids[0]);
          toast("Select Similar", "success");
        } catch {
          toast("Select Similar failed", "warn");
        }
      })();
      break;
    case "align-x": {
      const n = alignSelectedAxis("x");
      toast(n ? `Aligned ${n} element(s) on X` : "Select at least two authored elements.", n ? "success" : "warn");
      break;
    }
    case "align-z": {
      const n = alignSelectedAxis("z");
      toast(n ? `Aligned ${n} element(s) on Z` : "Select at least two authored elements.", n ? "success" : "warn");
      break;
    }
    case "pin": {
      const n = pinSelected(true);
      toast(n ? `Pinned ${n} element(s)` : "Select authored element(s).", n ? "success" : "warn");
      break;
    }
    case "unpin": {
      const n = pinSelected(false);
      toast(n ? `Unpinned ${n} element(s)` : "No authored selection.", n ? "success" : "warn");
      break;
    }
    case "split-mid": {
      const n = splitSelectedAtMidpoint();
      toast(n ? `Split ${n} element(s)` : "Select wall / beam / MEP run(s).", n ? "success" : "warn");
      break;
    }
    case "join-walls": {
      try {
        const n = (window as Any).__obsAuthoring?.joinSelectedWalls?.() ?? 0;
        toast(n ? `Joined ${n} wall run(s)` : "Select authored walls near a corner.", n ? "success" : "warn");
      } catch {
        toast("Join walls unavailable", "warn");
      }
      break;
    }
    case "delete":
      if (!has) {
        toast("Nothing selected to delete.", "warn");
        return;
      }
      deleteSelectedElement();
      toast(`Deleted selection`, "success");
      break;
    default:
      break;
  }
}

/** Ordered list of modify actions for menus. */
export function listModifyActions(): ModifyActionDef[] {
  return listModifyCommandDefinitions().map((definition) => ({
    id: definition.id,
    label: definition.label,
    icon: definition.icon,
    shortcut: definition.commandAlias,
    needsSelection: definition.selection === "one",
    needsMulti: definition.selection === "two",
    danger: definition.danger,
    separatorBefore: definition.separatorBefore,
  }));
}

export function isModifyActionEnabled(def: ModifyActionDef, selectionCount: number): boolean {
  return resolveModifyCapability(def.id, {
    selectedCount: selectionCount,
    clipboardCount: getModifyClipboardCount(),
  }).enabled;
}

export function isModifyToolActive(id: ModifyActionId): boolean {
  try {
    const t = getActiveTool();
    return t === id;
  } catch {
    return false;
  }
}
