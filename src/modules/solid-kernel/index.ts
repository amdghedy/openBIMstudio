/**
 * Solid geometry kernel — public barrel (Design spec MODULE 2.7–2.9, 2.12).
 */
export { meshVolume, profileArea, sweepProfile, type IndexedMesh, type Pt3, type ProfilePt } from "../adaptive";
export * from "./tolerance";
export * from "./brep";
export * from "./forms";
export * from "./csg";
export * from "./general-csg";
export * from "./shell";
export * from "./loft";
export * from "./voids";
export * from "./validate";
export * from "./validation-gate";
export * from "./boolean-postcondition";
// NOTE: ./three-boolean is intentionally NOT re-exported here. It
// imports `three` / `three-csg-ts`, and Node tests compile this barrel
// into a /tmp dir where external modules do not resolve. Import it
// directly (src/modules/solid-kernel/three-boolean) where needed.
