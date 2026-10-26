/**
 * Navigation engine — ViewCube orientation mapping, camera transitions,
 * BIM-aware framing and the NavigationController.
 *
 * DOM-free like every other src/modules engine; the viewer integration
 * lives in src/features/viewcube.ts.
 */
export * from "./types";
export * from "./orientation";
export * from "./framing";
export * from "./transitions";
export * from "./home-state";
export * from "./controller";
