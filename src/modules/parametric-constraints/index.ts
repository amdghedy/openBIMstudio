export * from "./types";
export * from "./solver-bridge";

// NOTE: this module used to call require("./types") inside the setup bag
// below. `require` does not exist in a Vite ESM browser bundle, so
// setupParametricConstraints() threw at runtime and critical-gaps-boot's
// safe() swallowed it — even the console-level constraint API was dead.
// All calls now go through proper static ESM imports.
import {
  lockDimension,
  addEquality,
  addAlignment,
  addParallel,
  addPerpendicular,
  getConstraints,
  getAllConstraints,
  removeConstraint,
  toggleConstraint,
  isLocked,
  getLockedValue,
} from "./types";

let installed = false;
export function setupParametricConstraints() {
  if (installed) return; installed = true;
  (window as any).__obsConstraints = {
    lock: (e1: string, e2: string, v: number) => lockDimension(e1, e2, v),
    equality: (ids: string[], label: string) => addEquality(ids, label),
    align: (e1: string, e2: string) => addAlignment(e1, e2),
    parallel: (e1: string, e2: string) => addParallel(e1, e2),
    perpendicular: (e1: string, e2: string) => addPerpendicular(e1, e2),
    get: (id: string) => getConstraints(id),
    all: () => getAllConstraints(),
    remove: (id: string) => removeConstraint(id),
    toggle: (id: string) => toggleConstraint(id),
    isLocked: (e1: string, e2: string) => isLocked(e1, e2),
    lockedValue: (e1: string, e2: string) => getLockedValue(e1, e2),
  };
  console.log("[parametric-constraints] ready. Lock dims, equality, alignment, parallel, perpendicular.");
}
