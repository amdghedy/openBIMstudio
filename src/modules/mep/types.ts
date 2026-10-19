/**
 * MEP Auto-Routing — shared types.
 *
 * Pure data structures; no runtime deps. Imported by:
 *   - router.ts (A* over 3D voxel grid)
 *   - sizing.ts (ASHRAE sizing rules)
 *   - index.ts (boot)
 *   - ../features/mep-fabrication.ts (UI command)
 */

/** MEP system classification — drives sizing + IFC entity + display color. */
export type MepSystem =
  | "supply-air"      // conditioned supply air duct
  | "return-air"      // return air duct
  | "exhaust-air"     // exhaust / relief air duct
  | "outside-air"     // outdoor air duct
  | "chilled-water"   // chilled water pipe (cooling coil feed)
  | "hot-water"       // hot water pipe (heating coil feed)
  | "domestic-cold"   // domestic cold water
  | "domestic-hot"    // domestic hot water
  | "sanitary"        // sanitary drainage
  | "condensate"      // HVAC condensate drain
  | "gas"             // fuel gas pipe
  | "medical-vacuum"  // medical vacuum pipe
  | "medical-oxygen"  // medical oxygen pipe
  | "cable-tray"      // cable tray (electrical)
  | "conduit";        // conduit (electrical)

/** Linear MEP element type this system maps to. */
export type MepElementType = "duct" | "pipe" | "cable-tray" | "conduit";

/** 3D point in metres. */
export interface Vec3 {
  x: number;
  y: number; // vertical (world up)
  z: number;
}

/** A 3D axis-aligned bounding box used for obstacle collision. */
export interface AABB {
  min: Vec3;
  max: Vec3;
}

/** A requested route between two terminals. */
export interface RouteRequest {
  /** Start point in world metres. */
  start: Vec3;
  /** End point in world metres. */
  end: Vec3;
  /** System classification — drives sizing + display color. */
  system: MepSystem;
  /** Volumetric flow rate at the start (m^3/s for air, L/s for water). */
  flowRate: number;
  /** Optional: list of obstacle AABBs to avoid (walls, beams, columns). */
  obstacles?: AABB[];
  /** Optional: waypoints the route must pass through (in order). */
  via?: Vec3[];
  /** Optional: maximum allowable velocity (m/s). Used for sizing. Defaults per system. */
  maxVelocity?: number;
  /** Optional: voxel grid resolution in metres. Default 0.25 m. */
  voxelSize?: number;
  /** Optional: clearance from obstacles in metres. Default 0.1 m. */
  clearance?: number;
  /** Optional: maximum number of A* iterations before giving up. Default 5000. */
  maxIterations?: number;
}

/** A single leg of a routed path. */
export interface RouteLeg {
  /** Start of this leg (metres). */
  start: Vec3;
  /** End of this leg (metres). */
  end: Vec3;
  /** Length in metres. */
  length: number;
  /** Direction angle (radians, atan2 of dz, dx) - for the XY plan. */
  planAngle: number;
  /** True if this leg changes elevation (vertical run). */
  isVertical: boolean;
}

/** The result of a successful route. */
export interface RouteResult {
  /** The system this route serves. */
  system: MepSystem;
  /** The element type to create (duct / pipe / tray / conduit). */
  elementType: MepElementType;
  /** Sized dimensions for the linear elements. */
  size: MepSize;
  /** Ordered list of legs forming the path. Waypoints are where bends occur. */
  legs: RouteLeg[];
  /** Total path length in metres. */
  totalLength: number;
  /** Number of bends (each requires a fitting). */
  bendCount: number;
  /** Estimated pressure drop in Pa (for ducts) or bar (for pipes). */
  pressureDrop: number;
  /** Voxel grid resolution used. */
  voxelSize: number;
}

/** Sized cross-section for a linear MEP element. */
export interface MepSize {
  /** For ducts: width (m). For pipes: diameter (m). For trays: width (m). For conduits: diameter (m). */
  thickness: number;
  /** For ducts: height (m). For pipes: same as thickness (round). For trays: depth (m). For conduits: same as thickness. */
  height: number;
  /** Resulting velocity in m/s (used for sizing validation). */
  velocity: number;
  /** Cross-sectional area in m^2. */
  area: number;
  /** Sizing rule that produced this size, for audit. */
  rule: string;
}

/** Result of a sizing computation. */
export interface SizingResult {
  size: MepSize;
  /** Warnings (e.g. "velocity above 6 m/s - noisy"). */
  warnings: string[];
}

/** Convert a MepSystem to its corresponding element type. */
export function elementTypeFor(system: MepSystem): MepElementType {
  switch (system) {
    case "supply-air":
    case "return-air":
    case "exhaust-air":
    case "outside-air":
      return "duct";
    case "chilled-water":
    case "hot-water":
    case "domestic-cold":
    case "domestic-hot":
    case "sanitary":
    case "condensate":
    case "gas":
    case "medical-vacuum":
    case "medical-oxygen":
      return "pipe";
    case "cable-tray":
      return "cable-tray";
    case "conduit":
      return "conduit";
  }
}

/** IFC entity for an MEP element type. */
export function ifcEntityFor(elementType: MepElementType): string {
  switch (elementType) {
    case "duct": return "IfcDuctSegment";
    case "pipe": return "IfcPipeSegment";
    case "cable-tray": return "IfcCableCarrierSegment";
    case "conduit": return "IfcCableCarrierSegment";
  }
}

/** Display color for an MEP system. */
export function colorFor(system: MepSystem): string {
  switch (system) {
    case "supply-air": return "#3b82f6";      // blue
    case "return-air": return "#10b981";      // green
    case "exhaust-air": return "#ef4444";      // red
    case "outside-air": return "#06b6d4";      // cyan
    case "chilled-water": return "#0ea5e9";    // sky
    case "hot-water": return "#f97316";        // orange
    case "domestic-cold": return "#22c55e";   // green
    case "domestic-hot": return "#dc2626";     // red
    case "sanitary": return "#7c3aed";         // violet
    case "condensate": return "#a855f7";       // purple
    case "gas": return "#facc15";              // yellow
    case "medical-vacuum": return "#94a3b8";   // slate
    case "medical-oxygen": return "#22d3ee";   // light cyan
    case "cable-tray": return "#f59e0b";      // amber
    case "conduit": return "#a855f7";          // purple
  }
}
