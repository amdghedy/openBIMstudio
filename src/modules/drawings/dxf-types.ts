/** Shared types for the Drawings / DXF / DWG engine. */

export interface DxfPoint {
  x: number;
  y: number;
  z?: number;
}

export interface DxfLayer {
  name: string;
  color: number; // ACI color index 1-255
  /** 24-bit true colour (0xRRGGBB) from DXF group 420 — wins over ACI when present. */
  rgb?: number;
  lineType?: string;
  frozen?: boolean;
  locked?: boolean;
  /** Layer switched off (negative colour in DXF, "off" flag in DWG). */
  off?: boolean;
  /** Default lineweight in mm (DXF group 370 / 100); undefined = default. */
  lineweight?: number;
  /** Layer transparency in percent 0-90 (DXF group 440); 0/undefined = opaque. */
  transparency?: number;
  /** DXF group 290: does this layer plot? undefined = plots. */
  plot?: boolean;
}

/** Fields every entity carries. */
interface DxfEntityBase {
  layer: string;
  /** ACI colour; undefined = BYLAYER. */
  color?: number;
  /** 24-bit true colour (0xRRGGBB) when the entity has one. */
  rgb?: number;
  /** Linetype name; undefined = BYLAYER. */
  lineType?: string;
  /** Lineweight in mm; undefined = BYLAYER. */
  lineweight?: number;
  /** Per-entity linetype scale (DXF group 48); undefined = 1. */
  ltScale?: number;
  /** Entity transparency in percent 0-90 (DXF group 440); 0/undefined = opaque. */
  transparency?: number;
}

/** Hatch data carried on a closed polyline (`points` is the outer loop). */
export interface DxfHatch {
  solid: boolean;
  pattern?: string;
  /** Pattern angle in degrees. */
  angle?: number;
  /** Pattern scale (DXF group 41). */
  scale?: number;
  /** All boundary loops, outer first (even-odd fill). */
  loops: DxfPoint[][];
  /**
   * Real pattern definition read from the file (acadrust engine): one entry
   * per pattern line family. Angles are radians in pattern space; `offset`
   * is the perpendicular spacing vector between lines; `dashes` alternate
   * dash/gap lengths along the line (positive dash, negative gap). When
   * present the renderer draws the actual ANSI/ISO pattern instead of a
   * generic fallback.
   */
  patternLines?: Array<{
    angle: number;
    base: [number, number];
    offset: [number, number];
    dashes: number[];
  }>;
  /** WIPEOUT: solid fill with the drawing background (masks what is behind it). */
  wipeout?: boolean;
}

export type DxfEntity =
  | (DxfEntityBase & {
      type: "LINE";
      start: DxfPoint;
      end: DxfPoint;
    })
  | (DxfEntityBase & {
      type: "RAY";
      /** Point the ray starts at. */
      start: DxfPoint;
      /** Direction of the infinite extension. */
      direction: DxfPoint;
    })
  | (DxfEntityBase & {
      type: "XLINE";
      /** A point on the infinite construction line. */
      start: DxfPoint;
      /** Direction of the line (both ways). */
      direction: DxfPoint;
    })
  | (DxfEntityBase & {
      type: "CIRCLE";
      center: DxfPoint;
      radius: number;
    })
  | (DxfEntityBase & {
      type: "ARC";
      center: DxfPoint;
      radius: number;
      startAngle: number; // degrees, counter-clockwise
      endAngle: number;
    })
  | (DxfEntityBase & {
      type: "LWPOLYLINE";
      points: DxfPoint[];
      closed?: boolean;
      /** Present when this polyline is the boundary of a hatch / solid fill. */
      hatch?: DxfHatch;
    })
  | (DxfEntityBase & {
      type: "TEXT";
      position: DxfPoint;
      height: number;
      value: string;
      rotation?: number;
      /** Horizontal anchor of `position`; default left. */
      align?: "left" | "center" | "right";
      /** Vertical anchor of `position`; default baseline. */
      valign?: "top" | "middle" | "bottom" | "baseline";
      /** Text style name (STYLE table). */
      style?: string;
      /** Font file / family from the style or an inline \\f code (e.g. "simplex.shx", "Arial"). */
      font?: string;
      bold?: boolean;
      italic?: boolean;
      /** Width factor (1 = normal). */
      widthFactor?: number;
      /** Oblique angle in degrees (positive leans right). */
      oblique?: number;
      /** DXF group 71 flag 2: mirrored horizontally (reads backwards). */
      backwards?: boolean;
      /** DXF group 71 flag 4: flipped vertically (reads upside down). */
      upsideDown?: boolean;
    })
  | (DxfEntityBase & {
      type: "POINT";
      position: DxfPoint;
    });

/** A paper-space viewport showing a window of model space. */
export interface DxfViewport {
  /** Centre on the sheet. */
  center: DxfPoint;
  width: number;
  height: number;
  /** Model-space point shown at the viewport centre. */
  viewCenter: DxfPoint;
  /** Model-space height shown through the viewport. */
  viewHeight: number;
  /** View twist in degrees. */
  twist?: number;
}

export interface DxfLayout {
  name: string;
  entities: DxfEntity[];
  viewports: DxfViewport[];
}

export type DxfUnits = "unitless" | "mm" | "cm" | "m" | "in" | "ft";

/** A STYLE-table record (text style) as read from the file. */
export interface DxfTextStyle {
  /** Primary font: SHX file name ("txt.shx") or TrueType family ("Arial"). */
  font?: string;
  /** Big-font file name for the extended character set (DXF group 4). */
  bigFont?: string;
  /** Fixed height (DXF group 40); 0/undefined = height set per entity. */
  height?: number;
  /** Width factor (DXF group 41). */
  width?: number;
  /** Oblique angle in degrees (DXF group 50). */
  oblique?: number;
  bold?: boolean;
  italic?: boolean;
  /** DXF group 71 flag 2: drawn backwards. */
  backwards?: boolean;
  /** DXF group 71 flag 4: drawn upside down. */
  upsideDown?: boolean;
}

/** A DIMSTYLE-table record (dimension style) as read from the file — the values needed to draw dimensions natively. */
export interface DxfDimStyle {
  /** DIMSCALE (group 40) — overall scale applied to every size. */
  scale?: number;
  /** DIMTXT (group 140) — dimension text height. */
  textHeight?: number;
  /** DIMASZ (group 41) — arrowhead size. */
  arrowSize?: number;
  /** DIMEXO (group 42) — extension-line offset from the measured origin. */
  extOffset?: number;
  /** DIMEXE (group 44) — extension past the dimension line. */
  extExtend?: number;
  /** DIMGAP (group 147) — gap around the dimension text. */
  textGap?: number;
}

export interface DxfDocument {
  layers: DxfLayer[];
  entities: DxfEntity[];
  /** Drawing extents (model space), computed from the entities. */
  extents?: { min: DxfPoint; max: DxfPoint };
  /** Drawing units as declared by the file ($INSUNITS). */
  units?: DxfUnits;
  sourceFormat?: "dxf" | "dwg" | "cad-engine" | "unknown";
  /** Paper-space layouts (sheets). */
  layouts?: DxfLayout[];
  /** Linetype name (upper case) -> dash pattern in drawing units (+dash, -gap, 0 dot). */
  linetypes?: Record<string, number[]>;
  /** Global linetype scale ($LTSCALE). */
  ltscale?: number;
  /** STYLE table (text styles) by upper-case name, as read from the file. */
  textStyles?: Record<string, DxfTextStyle>;
  /** DIMSTYLE table names, as read from the file. */
  dimStyles?: string[];
  /** DIMSTYLE table by upper-case name, with the values needed for native dimension drawing. */
  dimStyleTable?: Record<string, DxfDimStyle>;
  /** Entity types that were present but not drawn, with counts. */
  skipped?: Record<string, number>;
}
