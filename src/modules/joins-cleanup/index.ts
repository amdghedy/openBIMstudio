/**
 * Joins & Cleanup Service — wall/floor/roof joins + host opening recuts (Revit join parity)
 */
import type { IJoinsCleanupService, JoinElementRef, JoinPair, JoinType } from "./types";

let _instance: JoinsCleanupService | null = null;

export class JoinsCleanupService implements IJoinsCleanupService {
  private joins = new Map<string, JoinPair>();
  private listElements: (() => JoinElementRef[]) | null = null;
  private joinFn: ((a: string, b: string, type: JoinType) => Promise<boolean>) | null = null;
  private recutFn: ((hostId: string) => Promise<boolean>) | null = null;

  setHandlers(
    listElements: () => JoinElementRef[],
    joinFn: (a: string, b: string, type: JoinType) => Promise<boolean>,
    recutFn: (hostId: string) => Promise<boolean>
  ): void {
    this.listElements = listElements;
    this.joinFn = joinFn;
    this.recutFn = recutFn;
  }

  async autoJoin(elementIds?: string[]): Promise<JoinPair[]> {
    const els = this.listElements?.() ?? [];
    const set = elementIds ? new Set(elementIds) : null;
    const candidates = set ? els.filter((e) => set.has(e.id)) : els;
    const hosts = candidates.filter((e) =>
      /wall|floor|roof|ceiling/i.test(e.category)
    );
    const created: JoinPair[] = [];
    for (let i = 0; i < hosts.length; i++) {
      for (let j = i + 1; j < hosts.length; j++) {
        const a = hosts[i];
        const b = hosts[j];
        if (a.category !== b.category && !(isWallLike(a.category) && isWallLike(b.category))) continue;
        const id = `join_${a.id}_${b.id}`;
        if (this.joins.has(id)) continue;
        const type: JoinType = isWallLike(a.category) ? "miter" : "butt";
        let resolved = false;
        if (this.joinFn) {
          try {
            resolved = await this.joinFn(a.id, b.id, type);
          } catch {
            resolved = false;
          }
        }
        const pair: JoinPair = {
          id,
          elementA: a.id,
          elementB: b.id,
          joinType: type,
          resolved,
        };
        this.joins.set(id, pair);
        created.push(pair);
      }
    }
    return created;
  }

  setJoinType(pairId: string, type: JoinType): boolean {
    const p = this.joins.get(pairId);
    if (!p) return false;
    p.joinType = type;
    p.resolved = false;
    return true;
  }

  async recutOpenings(hostId: string): Promise<boolean> {
    if (!this.recutFn) return false;
    try {
      return await this.recutFn(hostId);
    } catch {
      return false;
    }
  }

  listJoins(): JoinPair[] {
    return [...this.joins.values()];
  }

  clearJoins(): void {
    this.joins.clear();
  }
}

function isWallLike(cat: string): boolean {
  return /wall/i.test(cat);
}

export function getJoinsCleanupService(): JoinsCleanupService {
  if (!_instance) _instance = new JoinsCleanupService();
  return _instance;
}

export type { IJoinsCleanupService, JoinPair, JoinType };
