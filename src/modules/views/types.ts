/**
 * View definitions â€” the single source of truth for every 2D projection.
 *
 * A ViewDef is a *configuration*. It contains no geometry; it describes how
 * to project the element model onto a plane. The generator produces a
 * Scene2D from a ViewDef + the element model. The renderer draws the Scene2D.
 *
 * This separation is what lets plan / section / elevation share the same
 * renderer, annotation engine, and selection system.
 */

export type ViewKind =
  | "plan"
  | "rcp"
  | "section"
  | "elevation"
  | "detail"
  | "drafting"
  | "3d"
  | "schedule"
  | "legend";

export type Discipline = "ARC" | "STR" | "MEP" | "COORD";

export interface PlanConfig {
  levelId: string;
  levelElevation: number;
  cutHeight: number;
  topHeight: number;
  bottomDepth: number;
  viewDepth: number;
}

export interface SectionConfig {
  cutLine: { x1: number; z1: number; x2: number; z2: number };
  lookDir: "left" | "right";
  top: number;
  bottom: number;
  farClip: number;
}

export interface ElevationConfig {
  direction: "north" | "south" | "east" | "west";
  origin: [number, number, number];
  farClip: number;
}

export interface DetailConfig {
  parentViewId: string;
  region: { x: number; y: number; w: number; h: number };
  zoom: number;
}

export interface ViewDef {
  id: string;
  kind: ViewKind;
  name: string;
  scale: number;
  discipline: Discipline;
  templateId?: string;
  crop: { x: number; y: number; w: number; h: number } | null;
  plan?: PlanConfig;
  section?: SectionConfig;
  elevation?: ElevationConfig;
  detail?: DetailConfig;
  createdAt: number;
  updatedAt: number;
}