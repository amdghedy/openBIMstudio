/**
 * Out-of-Core Streaming & Memory Budget Manager
 *
 * Implements dynamic LOD evaluation (Screen-Space Error / SSE), progressive chunk streaming,
 * and memory budget enforcement (unloading distant off-screen high-poly meshes and swapping
 * with lightweight proxy impostors).
 */

import { BoundingBox3D, boxCenter, boxRadius } from "./spatial-octree";

export type ChunkLOD = 0 | 1 | 2 | 3; // 0: Full/Raw Mesh, 1: Simplified, 2: Low-poly Hull, 3: Bounding Impostor

export interface StreamingChunk {
  id: string;
  bbox: BoundingBox3D;
  elementCount: number;
  memoryBytes: number;
  currentLod: ChunkLOD;
  targetLod: ChunkLOD;
  isResident: boolean;
  isVisible: boolean;
  distanceToCamera: number;
  screenSpaceErrorPx: number;
  lastAccessTime: number;
}

export interface MemoryBudgetConfig {
  maxMemoryMb: number; // e.g. 512 MB
  sseThresholdPx: number; // screen space error tolerance (default: 16px)
  cameraFovDeg: number;
  viewportHeightPx: number;
  hysteresisFactor: number; // Prevents LOD thrashing
}

export interface StreamingMetrics {
  totalChunks: number;
  residentChunks: number;
  currentMemoryMb: number;
  maxMemoryMb: number;
  memoryUsagePercent: number;
  lodDistribution: Record<ChunkLOD, number>;
  visibleChunks: number;
  evictedCount: number;
}

export class MemoryBudgetManager {
  private chunks = new Map<string, StreamingChunk>();
  private config: MemoryBudgetConfig;
  private cameraPosition: [number, number, number] = [0, 0, 0];
  private evictedLifetime = 0;

  constructor(config: Partial<MemoryBudgetConfig> = {}) {
    this.config = {
      maxMemoryMb: config.maxMemoryMb ?? 512,
      sseThresholdPx: config.sseThresholdPx ?? 16,
      cameraFovDeg: config.cameraFovDeg ?? 60,
      viewportHeightPx: config.viewportHeightPx ?? 1080,
      hysteresisFactor: config.hysteresisFactor ?? 1.15,
    };
  }

  public registerChunk(chunk: Omit<StreamingChunk, "currentLod" | "targetLod" | "isResident" | "isVisible" | "distanceToCamera" | "screenSpaceErrorPx" | "lastAccessTime">): void {
    this.chunks.set(chunk.id, {
      ...chunk,
      currentLod: 3, // Start as lightweight impostor
      targetLod: 3,
      isResident: false,
      isVisible: false,
      distanceToCamera: Infinity,
      screenSpaceErrorPx: 0,
      lastAccessTime: Date.now(),
    });
  }

  public updateCamera(position: [number, number, number], fovDeg?: number, viewportH?: number): void {
    this.cameraPosition = position;
    if (fovDeg) this.config.cameraFovDeg = fovDeg;
    if (viewportH) this.config.viewportHeightPx = viewportH;
  }

  /**
   * Calculates Screen-Space Error (SSE) in pixels:
   * SSE = (geometricError * viewportHeight) / (2 * distance * tan(FOV / 2))
   */
  public calculateSSE(chunk: StreamingChunk): number {
    const center = boxCenter(chunk.bbox);
    const radius = boxRadius(chunk.bbox);

    const dx = center[0] - this.cameraPosition[0];
    const dy = center[1] - this.cameraPosition[1];
    const dz = center[2] - this.cameraPosition[2];
    const dist = Math.max(1.0, Math.sqrt(dx * dx + dy * dy + dz * dz));

    chunk.distanceToCamera = dist;

    // Geometric error estimate based on chunk radius and LOD
    const baseError = radius * 0.1;
    const fovRad = (this.config.cameraFovDeg * Math.PI) / 180;
    const sse = (baseError * this.config.viewportHeightPx) / (2 * dist * Math.tan(fovRad * 0.5));

    chunk.screenSpaceErrorPx = sse;
    return sse;
  }

  /**
   * Evaluates optimal LOD for each chunk and returns actionable transitions
   */
  public evaluateStreaming(visibleChunkIds?: Set<string>): {
    toLoad: string[];
    toEvict: string[];
    downgraded: string[];
  } {
    const toLoad: string[] = [];
    const toEvict: string[] = [];
    const downgraded: string[] = [];

    const now = Date.now();

    for (const chunk of this.chunks.values()) {
      chunk.isVisible = visibleChunkIds ? visibleChunkIds.has(chunk.id) : true;
      const sse = this.calculateSSE(chunk);

      if (!chunk.isVisible) {
        // Off-screen chunk: target lightweight LOD 3 or evict
        chunk.targetLod = 3;
        if (chunk.isResident && chunk.distanceToCamera > 100) {
          toEvict.push(chunk.id);
        }
      } else {
        // In-frustum: determine LOD based on screen error
        if (sse > this.config.sseThresholdPx * 2) {
          chunk.targetLod = 0; // Full detail
        } else if (sse > this.config.sseThresholdPx) {
          chunk.targetLod = 1; // Medium
        } else if (sse > this.config.sseThresholdPx * 0.5) {
          chunk.targetLod = 2; // Low
        } else {
          chunk.targetLod = 3; // Impostor
        }

        chunk.lastAccessTime = now;

        if (!chunk.isResident) {
          toLoad.push(chunk.id);
        } else if (chunk.currentLod > chunk.targetLod) {
          toLoad.push(chunk.id); // Upgrade detail
        } else if (chunk.currentLod < chunk.targetLod) {
          downgraded.push(chunk.id);
        }
      }
    }

    // Enforce memory budget
    this.enforceBudget();

    return { toLoad, toEvict, downgraded };
  }

  /**
   * Unloads chunks if memory consumption exceeds maximum allowance
   */
  public enforceBudget(): { evictedCount: number; memoryFreedMb: number } {
    let currentBytes = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.isResident) {
        currentBytes += chunk.memoryBytes;
      }
    }

    const maxBytes = this.config.maxMemoryMb * 1024 * 1024;
    let evictedCount = 0;
    let freedBytes = 0;

    if (currentBytes > maxBytes) {
      // Sort candidates: invisible first, then highest camera distance
      const candidates = Array.from(this.chunks.values())
        .filter((c) => c.isResident)
        .sort((a, b) => {
          if (a.isVisible !== b.isVisible) return a.isVisible ? 1 : -1;
          return b.distanceToCamera - a.distanceToCamera;
        });

      for (const candidate of candidates) {
        if (currentBytes <= maxBytes) break;
        candidate.isResident = false;
        candidate.currentLod = 3;
        currentBytes -= candidate.memoryBytes;
        freedBytes += candidate.memoryBytes;
        evictedCount++;
        this.evictedLifetime++;
      }
    }

    return {
      evictedCount,
      memoryFreedMb: freedBytes / (1024 * 1024),
    };
  }

  public setChunkResident(id: string, resident: boolean, lod: ChunkLOD = 0): void {
    const chunk = this.chunks.get(id);
    if (!chunk) return;
    chunk.isResident = resident;
    chunk.currentLod = lod;
    if (resident) {
      chunk.lastAccessTime = Date.now();
    }
  }

  public getMetrics(): StreamingMetrics {
    let residentBytes = 0;
    let residentCount = 0;
    let visibleCount = 0;
    const lodDist: Record<ChunkLOD, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };

    for (const chunk of this.chunks.values()) {
      if (chunk.isVisible) visibleCount++;
      if (chunk.isResident) {
        residentCount++;
        residentBytes += chunk.memoryBytes;
        lodDist[chunk.currentLod]++;
      } else {
        lodDist[3]++;
      }
    }

    const currentMb = residentBytes / (1024 * 1024);
    const usagePercent = (currentMb / this.config.maxMemoryMb) * 100;

    return {
      totalChunks: this.chunks.size,
      residentChunks: residentCount,
      currentMemoryMb: parseFloat(currentMb.toFixed(2)),
      maxMemoryMb: this.config.maxMemoryMb,
      memoryUsagePercent: parseFloat(usagePercent.toFixed(1)),
      lodDistribution: lodDist,
      visibleChunks: visibleCount,
      evictedCount: this.evictedLifetime,
    };
  }

  public setMaxMemoryMb(mb: number): void {
    this.config.maxMemoryMb = Math.max(64, mb);
    this.enforceBudget();
  }
}

let _defaultManager: MemoryBudgetManager | null = null;
export function getMemoryBudgetManager(): MemoryBudgetManager {
  if (!_defaultManager) {
    _defaultManager = new MemoryBudgetManager();
  }
  return _defaultManager;
}
