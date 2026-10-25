/**
 * Site & topography — toposolid, graded surface, building pad
 */
export interface TopoPoint {
  x: number;
  y: number;
  z: number;
}

export interface Toposolid {
  id: string;
  name: string;
  points: TopoPoint[];
  materialId?: string;
}

export interface BuildingPad {
  id: string;
  name: string;
  boundary: Array<{ x: number; y: number }>;
  levelElevation: number;
  hostTopoId?: string;
}

export interface ISiteTopoService {
  createToposolid(name: string, points: TopoPoint[]): Toposolid;
  createPad(name: string, boundary: Array<{ x: number; y: number }>, elevation: number): BuildingPad;
  listTopos(): Toposolid[];
  listPads(): BuildingPad[];
  getTopo(id: string): Toposolid | undefined;
}

let _instance: SiteTopoService | null = null;

export class SiteTopoService implements ISiteTopoService {
  private topos = new Map<string, Toposolid>();
  private pads = new Map<string, BuildingPad>();

  createToposolid(name: string, points: TopoPoint[]): Toposolid {
    const id = `topo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const t: Toposolid = { id, name, points: [...points] };
    this.topos.set(id, t);
    return t;
  }

  createPad(
    name: string,
    boundary: Array<{ x: number; y: number }>,
    elevation: number
  ): BuildingPad {
    const id = `pad_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const p: BuildingPad = { id, name, boundary: [...boundary], levelElevation: elevation };
    this.pads.set(id, p);
    return p;
  }

  listTopos(): Toposolid[] {
    return [...this.topos.values()];
  }

  listPads(): BuildingPad[] {
    return [...this.pads.values()];
  }

  getTopo(id: string): Toposolid | undefined {
    return this.topos.get(id);
  }
}

export function getSiteTopoService(): SiteTopoService {
  if (!_instance) _instance = new SiteTopoService();
  return _instance;
}
