export * from "./types";
let installed = false;
export function setupParametricConstraints() {
  if (installed) return; installed = true;
  (window as any).__obsConstraints = { lock: (e1: string, e2: string, v: number) => require("./types").lockDimension(e1, e2, v), equality: (ids: string[], label: string) => require("./types").addEquality(ids, label), align: (e1: string, e2: string) => require("./types").addAlignment(e1, e2), get: (id: string) => require("./types").getConstraints(id), all: () => require("./types").getAllConstraints(), remove: (id: string) => require("./types").removeConstraint(id), toggle: (id: string) => require("./types").toggleConstraint(id), isLocked: (e1: string, e2: string) => require("./types").isLocked(e1, e2), lockedValue: (e1: string, e2: string) => require("./types").getLockedValue(e1, e2) };
  console.log("[parametric-constraints] ready. Lock dims, equality, alignment.");
}
