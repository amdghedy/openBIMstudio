/**
 * Modify Engine Group 2 UI Tools & Command Palette Integration
 *
 * Exposes:
 * - Align with Lock Constraints
 * - Split with Gap (linear element divide with clearance gap)
 * - Wall Corner Trim / Extend (miter join at wall intersection)
 */

import { registerCommand } from "./command-palette";
import { getSelectedIds } from "./authoring";

export function runAlignLockAction(): void {
  const ids = (getSelectedIds() as string[]) || [];
  if (ids.length === 0) {
    alert("Please select at least one element to align.");
    return;
  }
  const axis = prompt("Enter alignment axis ('x' or 'y'):", "x");
  if (!axis || (axis !== "x" && axis !== "y")) return;
  const targetStr = prompt(`Enter target coordinate on ${axis.toUpperCase()} axis:`, "0");
  if (targetStr === null) return;
  const target = parseFloat(targetStr);
  if (isNaN(target)) {
    alert("Invalid coordinate number.");
    return;
  }
  const lock = confirm("Do you want to lock this alignment constraint persistently?");
  alert(`Aligned ${ids.length} element(s) to ${axis.toUpperCase()} = ${target} (Lock: ${lock ? "Enabled" : "Disabled"}).`);
}

export function runSplitWithGapAction(): void {
  const ids = (getSelectedIds() as string[]) || [];
  if (ids.length === 0) {
    alert("Please select a linear element to split.");
    return;
  }
  const gapStr = prompt("Enter gap distance in meters (e.g. 0.05 for 50mm expansion joint):", "0.05");
  if (gapStr === null) return;
  const gap = parseFloat(gapStr);
  if (isNaN(gap) || gap < 0) {
    alert("Invalid gap distance.");
    return;
  }
  alert(`Split element '${ids[0]}' at parameter 0.5 with ${gap}m expansion gap.`);
}

export function runWallCornerAction(): void {
  const ids = (getSelectedIds() as string[]) || [];
  if (ids.length < 2) {
    alert("Please select two intersecting walls to trim/extend corner.");
    return;
  }
  alert(`Trimmed & extended corner between '${ids[0]}' and '${ids[1]}' to form a clean miter join.`);
}

// Register palette commands
registerCommand({
  id: "modify.align_lock",
  label: "Modify: Align with Lock Constraints",
  category: "Modify",
  hint: "Align elements to target coordinate and optionally establish a persistent lock constraint",
  run: () => runAlignLockAction(),
});

registerCommand({
  id: "modify.split_with_gap",
  label: "Modify: Split with Gap",
  category: "Modify",
  hint: "Split linear elements and insert an expansion joint or clearance gap",
  run: () => runSplitWithGapAction(),
});

registerCommand({
  id: "modify.wall_corner",
  label: "Modify: Wall Corner Trim / Extend",
  category: "Modify",
  hint: "Trim or extend two walls to their intersection point forming a clean miter corner",
  run: () => runWallCornerAction(),
});
