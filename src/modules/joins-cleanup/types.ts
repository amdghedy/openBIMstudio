/**
 * OpenBIMStudio — Geometry Joins & Cleanup (P1)
 */

export type JoinType = "butt" | "miter" | "square-off" | "none";

export interface JoinRule {
  id: string;
  categoryA: string;
  categoryB: string;
  joinType: JoinType;
  priority: number;
  enabled: boolean;
}

export interface JoinResult {
  elementIdA: string;
  elementIdB: string;
  success: boolean;
  joinTypeApplied: JoinType;
  geometryUpdated: boolean;
  error?: string;
}

export interface CleanupOptions {
  walls: boolean;
  floors: boolean;
  roofs: boolean;
  openings: boolean;
  maxDistance: number;
}

export interface IJoinsCleanupService {
  registerRule(rule: Omit<JoinRule, "id">): string;
  autoJoin(elementIds?: string[]): Promise<JoinResult[]>;
  cleanup(options: Partial<CleanupOptions>): Promise<{ fixed: number; failed: number }>;
  recutHostOpenings(hostId: string): Promise<boolean>;
  setJoinType(elementIdA: string, elementIdB: string, type: JoinType): boolean;
}
