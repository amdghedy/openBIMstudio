/**
 * Rebar detailing — shared types.
 *
 * Pure data structures; no runtime deps. Defines the contract between
 * the shape library, layout engine, geometry generator, and host
 * integration.
 *
 * Design follows Revit's rebar model:
 *   - A RebarBar is a single length of steel with a shape (straight,
 *     L-bend, U-bar, stirrup) and a diameter.
 *   - A RebarLayout is a set of bars placed inside a host element
 *     (beam, column, slab) at computed positions with concrete cover.
 *   - The host element provides the bounding box; cover offsets bars
 *     inward from every face.
 *   - Stirrups wrap around the perimeter at a spacing; main bars run
 *     along the longitudinal axis.
 */

/** Standard rebar diameters per ISO 6935 / ASTM A615 (mm). */
export const REBAR_DIAMETERS = [6, 8, 10, 12, 16, 20, 25, 32, 40];

/** Rebar shape codes per ACI 315 (simplified — covers the 7 most common). */
export type RebarShapeCode =
  | "straight"    // straight bar, no bends
  | "L-bend"      // single 90° bend at one end (L-shape)
  | "double-L"    // 90° bends at both ends
  | "U-bar"       // 180° bend at one end (U-shape)
  | "stirrup"     // rectangular closed stirrup (4 bends)
  | "stirrup-open" // open stirrup (3 bends, one side open)
  | "candy";      // open stirrup alias (same as stirrup-open)

/** A point in 3D space (metres). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A 3D polyline segment — the centreline of a rebar. */
export interface RebarSegment {
  start: Vec3;
  end: Vec3;
  /** Bend radius at the start point (0 for straight segments). */
  startRadius?: number;
}

/** A single rebar bar: shape + diameter + centreline + metadata. */
export interface RebarBar {
  id: string;
  shape: RebarShapeCode;
  /** Bar diameter in metres (e.g. 0.016 for D16). */
  diameter: number;
  /** Centreline segments (polyline with optional bend radii). */
  segments: RebarSegment[];
  /** Total length in metres (sum of segment lengths + bend allowances). */
  totalLength: number;
  /** Mass in kg (length * area * density, density = 7850 kg/m³). */
  mass: number;
  /** Bar mark (e.g. "1", "2", "3a") for scheduling. */
  mark?: string;
  /** Bar role (main, top, bottom, stirrup, tie). */
  role: RebarRole;
}

/** Role of a bar within its host element. */
export type RebarRole =
  | "main-bottom"     // bottom longitudinal (tension reinforcement)
  | "main-top"        // top longitudinal (compression / hogging)
  | "main-side"       // side face bars (skin reinforcement)
  | "stirrup"         // transverse shear reinforcement (closed)
  | "stirrup-open"    // open stirrup (one side open)
  | "link"            // small tie in column
  | "mesh";           // welded wire fabric in slabs

/** Host element types that can contain rebar. */
export type RebarHostType = "beam" | "column" | "slab" | "footing" | "wall";

/** A host element's geometry + rebar configuration. */
export interface RebarHost {
  /** Host element type. */
  type: RebarHostType;
  /** Cross-section width (m) — for beams/columns: the shorter dimension. */
  width: number;
  /** Cross-section depth (m) — for beams/columns: the longer dimension. */
  depth: number;
  /** Element length (m) — for beams: span; for columns: height; for slabs: 0. */
  length: number;
  /** Element thickness (m) — for slabs/walls. */
  thickness: number;
  /** Element origin (world position of the centre of the bottom face). */
  origin: Vec3;
  /** Element longitudinal direction (unit vector, for beams/columns). */
  direction: Vec3;
  /** Concrete cover (m) — distance from concrete face to nearest bar surface. */
  cover: number;
}

/** Rebar layout configuration — the input to the layout engine. */
export interface RebarLayoutConfig {
  host: RebarHost;
  /** Main bar diameter (m). Default 0.016 (D16). */
  mainBarDiameter: number;
  /** Number of main bars (bottom). Default 2. */
  mainBarCountBottom: number;
  /** Number of main bars (top). Default 2. */
  mainBarCountTop: number;
  /** Stirrup diameter (m). Default 0.008 (D8). */
  stirrupDiameter: number;
  /** Stirrup spacing (m). Default 0.15. */
  stirrupSpacing: number;
  /** Stirrup shape. Default 'stirrup' (closed). */
  stirrupShape: RebarShapeCode;
  /** Extra side bars (skin reinforcement). Default 0. */
  sideBarCount: number;
  /** Side bar diameter (m). Default 0.012 (D12). */
  sideBarDiameter: number;
}

/** A complete rebar layout for a host element. */
export interface RebarLayout {
  host: RebarHost;
  bars: RebarBar[];
  /** Total steel mass (kg). */
  totalMass: number;
  /** Total steel volume (m³). */
  totalVolume: number;
  /** Steel ratio (volume of steel / volume of concrete). */
  steelRatio: number;
}

/** Default layout configuration. */
export const DEFAULT_REBAR_CONFIG: Partial<RebarLayoutConfig> = {
  mainBarDiameter: 0.016,
  mainBarCountBottom: 2,
  mainBarCountTop: 2,
  stirrupDiameter: 0.008,
  stirrupSpacing: 0.15,
  stirrupShape: "stirrup",
  sideBarCount: 0,
  sideBarDiameter: 0.012,
};

/** Steel density (kg/m³) — used for mass calculation. */
export const STEEL_DENSITY = 7850;

/** Compute cross-sectional area of a bar given its diameter (m). */
export function barArea(diameter: number): number {
  return Math.PI * diameter * diameter / 4;
}

/** Compute bar mass given length (m) and diameter (m). */
export function barMass(length: number, diameter: number): number {
  return length * barArea(diameter) * STEEL_DENSITY;
}

/** Standard bend radius per ACI 315 (4× bar diameter for standard hooks). */
export function bendRadius(diameter: number): number {
  return Math.max(0.03, 4 * diameter);
}
