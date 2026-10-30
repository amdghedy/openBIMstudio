/** Shared types for the Drawings / DXF / DWG engine. */

export interface DxfPoint {
  x: number;
  y: number;
  z?: number;
}

export interface DxfLayer {
  name: string;
  color: number; // ACI color index 1-255
  lineType?: string;
  frozen?: boolean;
  locked?: boolean;
  /** Layer switched off (negative colour in DXF, "off" flag in DWG). */
  off?: boolean;
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
  /** Entity types that were present but not drawn, with counts. */
  skipped?: Record<string, number>;
}
