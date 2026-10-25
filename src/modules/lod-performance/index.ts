/**
 * LOD & performance manager — instance groups, LOD levels, stats
 */
export type LODLevel = 0 | 1 | 2 | 3;

export interface PerfStats {
  elementCount: number;
  visibleCount: number;
  instanceGroups: number;
  lod: LODLevel;
  lastCullMs: number;
}

export interface ILODPerformanceService {
  setLOD(level: LODLevel): void;
  getLOD(): LODLevel;
  registerInstanceGroup(key: string, elementIds: string[]): void;
  getStats(): PerfStats;
  setCounts(total: number, visible: number): void;
}

let _instance: LODPerformanceService | null = null;

export class LODPerformanceService implements ILODPerformanceService {
  private lod: LODLevel = 2;
  private groups = new Map<string, string[]>();
  private total = 0;
  private visible = 0;
  private lastCullMs = 0;

  setLOD(level: LODLevel): void {
    this.lod = level;
  }

  getLOD(): LODLevel {
    return this.lod;
  }

  registerInstanceGroup(key: string, elementIds: string[]): void {
    this.groups.set(key, elementIds);
  }

  setCounts(total: number, visible: number): void {
    this.total = total;
    this.visible = visible;
  }

  markCullDuration(ms: number): void {
    this.lastCullMs = ms;
  }

  getStats(): PerfStats {
    return {
      elementCount: this.total,
      visibleCount: this.visible,
      instanceGroups: this.groups.size,
      lod: this.lod,
      lastCullMs: this.lastCullMs,
    };
  }
}

export function getLODPerformanceService(): LODPerformanceService {
  if (!_instance) _instance = new LODPerformanceService();
  return _instance;
}
