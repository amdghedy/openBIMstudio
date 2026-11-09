/**
 * Architectural wall type catalog (RVT-like type picker data).
 * Layers string format: "Name thickness|#hex; Name thickness|#hex; ..."
 * consumed by parseWallLayers / buildCompoundWall.
 */

export interface WallTypePreset {
  id: string;
  name: string;
  kind: "basic" | "compound" | "curtain";
  thickness: number;
  height: number;
  layers?: string;
  /** Curtain system extras */
  panelType?: string;
  mullionProfile?: string;
  description: string;
}

export const WALL_TYPE_PRESETS: WallTypePreset[] = [
  {
    id: "basic-generic-200",
    name: "Basic Wall: Generic 200mm",
    kind: "basic",
    thickness: 0.2,
    height: 3.0,
    description: "Single-layer generic partition",
  },
  {
    id: "compound-exterior",
    name: "Basic Wall: Compound Exterior",
    kind: "compound",
    thickness: 0.255,
    height: 3.0,
    layers:
      "Exterior Finish 0.025|#c4b59a; Structure Core 0.20|#a8a29e; Interior Finish 0.03|#e7e5e4",
    description: "Finish | core | finish exterior wall",
  },
  {
    id: "compound-interior",
    name: "Basic Wall: Interior Partition",
    kind: "compound",
    thickness: 0.125,
    height: 3.0,
    layers: "Gypsum 0.0125|#f5f5f4; Stud Core 0.10|#d6d3d1; Gypsum 0.0125|#f5f5f4",
    description: "Double-board partition with stud core",
  },
  {
    id: "compound-concrete",
    name: "Basic Wall: Concrete 300mm",
    kind: "compound",
    thickness: 0.3,
    height: 3.0,
    layers: "Concrete Core 0.30|#9ca3af",
    description: "Structural concrete wall",
  },
  {
    id: "curtain-system",
    name: "Curtain Wall: Glazed System",
    kind: "curtain",
    thickness: 0.12,
    height: 3.5,
    panelType: "glazed",
    mullionProfile: "rect",
    description: "Mullion + glazed panel system",
  },
  {
    id: "curtain-solid",
    name: "Curtain Wall: Solid Panel",
    kind: "curtain",
    thickness: 0.12,
    height: 3.5,
    panelType: "solid",
    mullionProfile: "rect",
    description: "Mullion + solid panel system",
  },
];

export function getWallTypePreset(id: string): WallTypePreset | undefined {
  return WALL_TYPE_PRESETS.find((p) => p.id === id);
}

export function listWallTypePresets(): WallTypePreset[] {
  return [...WALL_TYPE_PRESETS];
}
