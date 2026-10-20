/** Structural analytical model — FEM-ready analytical lines & nodes. */
export interface AnalyticalNode {
  id: string;
  x: number; y: number; z: number;
  /** Support type. */
  support: "fixed" | "pinned" | "roller" | "free";
}
export interface AnalyticalMember {
  id: string;
  startNodeId: string;
  endNodeId: string;
  /** Element type this member represents. */
  sourceType: string;
  /** Section area (m²). */
  area: number;
  /** Young's modulus (Pa). */
  youngsModulus: number;
  /** Whether the member is released at start/end. */
  releaseStart?: boolean;
  releaseEnd?: boolean;
}
export interface AnalyticalLoad {
  id: string;
  memberId: string;
  type: "point" | "distributed";
  /** For point: [Fx, Fy, Fz] in N. For distributed: [wx, wy, wz] in N/m. */
  values: [number, number, number];
  /** Position along member (0=start, 1=end) — for point loads. */
  position?: number;
}

const nodes = new Map<string, AnalyticalNode>();
const members: AnalyticalMember[] = [];
const loads: AnalyticalLoad[] = [];
let idC = 0;

export function addNode(x: number, y: number, z: number, support: AnalyticalNode["support"] = "free"): AnalyticalNode {
  const n: AnalyticalNode = { id: `an-${++idC}`, x, y, z, support };
  nodes.set(n.id, n);
  return n;
}
export function addMember(startId: string, endId: string, sourceType: string, area: number, E = 200e9): AnalyticalMember {
  const m: AnalyticalMember = { id: `am-${++idC}`, startNodeId: startId, endNodeId: endId, sourceType, area, youngsModulus: E };
  members.push(m);
  return m;
}
export function addLoad(memberId: string, type: AnalyticalLoad["type"], values: [number, number, number], position?: number): AnalyticalLoad {
  const l: AnalyticalLoad = { id: `al-${++idC}`, memberId, type, values, position };
  loads.push(l);
  return l;
}
export function getNodes(): AnalyticalNode[] { return [...nodes.values()]; }
export function getMembers(): AnalyticalMember[] { return members; }
export function getLoads(): AnalyticalLoad[] { return loads; }

/** Export analytical model as a simplified stiffness matrix problem (JSON). */
export function exportAnalyticalModel(): { nodes: AnalyticalNode[]; members: AnalyticalMember[]; loads: AnalyticalLoad[] } {
  return { nodes: getNodes(), members, loads };
}

let installed = false;
export function setupAnalyticalModel() {
  if (installed) return; installed = true;
  (window as any).__obsAnalytical = { addNode, addMember, addLoad, getNodes, getMembers, getLoads, export: exportAnalyticalModel };
  console.log("[analytical-model] ready. Build FEM models via __obsAnalytical.");
}
