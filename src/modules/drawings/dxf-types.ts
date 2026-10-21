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
    })
  | (DxfEntityBase & {
      type: "TEXT";
      position: DxfPoint;
      height: number;
      value: string;
      rotation?: number;
    })
  | (DxfEntityBase & {
      type: "POINT";
      position: DxfPoint;
    });

export type DxfUnits = "unitless" | "mm" | "cm" | "m" | "in" | "ft";

export interface DxfDocument {
  layers: DxfLayer[];
  entities: DxfEntity[];
  /** Drawing extents (model space), computed from the entities. */
  extents?: { min: DxfPoint; max: DxfPoint };
  /** Drawing units as declared by the file ($INSUNITS). */
  units?: DxfUnits;
  sourceFormat?: "dxf" | "dwg" | "cad-engine" | "unknown";
  /** Entity types that were present but not drawn, with counts. */
  skipped?: Record<string, number>;
}
