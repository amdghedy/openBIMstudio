/**
 * Geometry Joins & Cleanup (P1) — Wall/floor/roof joins + host opening recut
 */
export type JoinType = "butt" | "miter" | "square-off" | "none";
export type HostCategory = "wall" | "floor" | "roof" | "ceiling";

export interface JoinPair {
  id: string;
  elementA: string;
  elementB: string;
  joinType: JoinType;
  location?: { x: number; y: number; z: number };
  resolved: boolean;
}

export interface OpeningRecutRequest {
  hostId: string;
  openingIds: string[];
}

export interface JoinElementRef {
  id: string;
  category: string;
  geometry?: unknown;
}

export interface IJoinsCleanupService {
  autoJoin(elementIds?: string[]): Promise<JoinPair[]>;
  setJoinType(pairId: string, type: JoinType): boolean;
  recutOpenings(hostId: string): Promise<boolean>;
  listJoins(): JoinPair[];
  clearJoins(): void;
  setHandlers(
    listElements: () => JoinElementRef[],
    joinFn: (a: string, b: string, type: JoinType) => Promise<boolean>,
    recutFn: (hostId: string) => Promise<boolean>
  ): void;
}
