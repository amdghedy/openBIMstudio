/**
 * Undo/redo commands for sheet operations.
 *
 * Snapshot-based: every sheet/titleblock mutation captures a deep before/after
 * copy and pushes one history command whose apply/revert swap the snapshot
 * back through the sheet store. Works for any change shape (viewports,
 * annotations, sheet fields, titleblock fields) without per-field logic, and
 * never leaves the undo stack pointing at live objects the next edit would
 * mutate in place.
 */
import { history } from "../../features/history";
import {
  cloneSheet,
  cloneTitleblock,
  replaceSheet,
  replaceTitleblockSnapshot,
  insertSheet,
  deleteSheet,
} from "./sheets";
import type { SheetDef, TitleblockDef } from "../projects/types";

/**
 * Push the undoable command for a sheet-level change.
 *  - before && after → update (apply/revert swap the whole sheet snapshot)
 *  - before == null  → create (revert deletes it again)
 *  - after  == null  → delete (revert re-inserts it)
 */
export function pushSheetChange(label: string, before: SheetDef | null, after: SheetDef | null): void {
  if (before && after) {
    const b = cloneSheet(before);
    const a = cloneSheet(after);
    history.push({
      label,
      apply: () => { replaceSheet(a.id, a); },
      revert: () => { replaceSheet(b.id, b); },
    });
  } else if (!before && after) {
    const a = cloneSheet(after);
    history.push({
      label,
      apply: () => { insertSheet(a); },
      revert: () => { deleteSheet(a.id); },
    });
  } else if (before && !after) {
    const b = cloneSheet(before);
    history.push({
      label,
      apply: () => { deleteSheet(b.id); },
      revert: () => { insertSheet(b); },
    });
  }
}

/** Push the undoable command for a titleblock field change. */
export function pushTitleblockChange(label: string, before: TitleblockDef, after: TitleblockDef): void {
  const b = cloneTitleblock(before);
  const a = cloneTitleblock(after);
  history.push({
    label,
    apply: () => { replaceTitleblockSnapshot(a.id, a); },
    revert: () => { replaceTitleblockSnapshot(b.id, b); },
  });
}
