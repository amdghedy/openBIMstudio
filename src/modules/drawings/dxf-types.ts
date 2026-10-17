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
}

export type DxfEntity =
  | {
      type: "LINE";
      layer: string;
      start: DxfPoint;
      end: DxfPoint;
      color?: number;
    }
  | {
      type: "CIRCLE";
      layer: string;
      center: DxfPoint;
      radius: number;
      color?: number;
    }
  | {
      type: "ARC";
      layer: string;
      center: DxfPoint;
      radius: number;
      startAngle: number; // degrees
      endAngle: number;
      color?: number;
    }
  | {
      type: "LWPOLYLINE";
      layer: string;
      points: DxfPoint[];
      closed?: boolean;
      color?: number;
    }
  | {
      type: "TEXT";
      layer: string;
      position: DxfPoint;
      height: number;
      value: string;
      rotation?: number;
      color?: number;
    }
  | {
      type: "POINT";
      layer: string;
      position: DxfPoint;
      color?: number;
    };

export interface DxfDocument {
  layers: DxfLayer[];
  entities: DxfEntity[];
  /** Drawing extents (model space). */
  extents?: { min: DxfPoint; max: DxfPoint };
  units?: "unitless" | "mm" | "m" | "in" | "ft";
  sourceFormat?: "dxf" | "dwg" | "cad-engine" | "unknown";
}
