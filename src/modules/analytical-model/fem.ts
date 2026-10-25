/**
 * 2D frame finite-element solver (Euler-Bernoulli) for the analytical model.
 *
 * Supports the day-one structural workflow a Revit competitor needs:
 * define analytical lines for beams/columns/braces, apply gravity and
 * lateral loads, get displacements, reactions and member end forces, then
 * feed them into member code checks (checks.ts).
 *
 * Element: 2-node frame element with 3 DOF per node (ux, uy, rz) — axial
 * plus bending. Truss (pin-ended) members are modelled with the `truss`
 * flag and carry axial force only.
 *
 * Load model:
 *   - Nodal loads (fx, fy, mz) in global axes.
 *   - Member uniformly distributed loads (wx, wy) in global axes, turned
 *     into consistent (exact for Euler-Bernoulli) nodal load vectors.
 *   - Member point loads at a parametric position t ∈ [0,1]; for exact
 *     interior results place the point load at a node.
 *
 * With consistent load vectors, nodal displacements of prismatic
 * Euler-Bernoulli members are exact — a simply supported beam modelled as
 * two elements reproduces 5wL⁴/384EI at midspan to machine precision.
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */

export interface FemNode {
  id: string;
  x: number;
  y: number;
  /** true = restrained (support). */
  ux?: boolean;
  uy?: boolean;
  rz?: boolean;
}

export interface FemMember {
  id: string;
  nodeA: string;
  nodeB: string;
  /** Young's modulus (Pa). */
  E: number;
  /** Cross-section area (m²). */
  A: number;
  /** Second moment of area about bending axis (m⁴). */
  I: number;
  /** Pin-ended (axial only) member. */
  truss?: boolean;
}

export interface NodalLoad {
  nodeId: string;
  fx?: number;
  fy?: number;
  mz?: number;
}

/** Uniformly distributed load on a member, global axes (N/m). */
export interface MemberUdl {
  memberId: string;
  wx?: number;
  wy?: number;
}

/** Point load on a member at t ∈ [0,1] along it, global axes (N). */
export interface MemberPointLoad {
  memberId: string;
  t: number;
  fx?: number;
  fy?: number;
}

export interface FemModel {
  nodes: FemNode[];
  members: FemMember[];
  nodalLoads?: NodalLoad[];
  memberUdls?: MemberUdl[];
  memberPointLoads?: MemberPointLoad[];
}

export interface MemberEndForces {
  /** Axial force at end A/B — positive tension (N). */
  N1: number;
  N2: number;
  /** Shear at end A/B (N), positive = local +y on the element face. */
  V1: number;
  V2: number;
  /** Bending moment at end A/B (N·m), positive = sagging. */
  M1: number;
  M2: number;
}

export interface FemResult {
  /** Displacement per node id: [dx, dy, rz] (m, rad). */
  displacements: Map<string, [number, number, number]>;
  /** Support reactions: [nodeId, fx, fy, mz] (N, N·m). */
  reactions: { nodeId: string; fx: number; fy: number; mz: number }[];
  /** Member end forces per member id (local axes). */
  memberForces: Map<string, MemberEndForces>;
  /** Diagnostics. */
  ndof: number;
  maxDeflection: number;
}

/** Solve a dense linear system A x = b (Gaussian elimination, partial pivot). */
function solveDense(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-18) return null;
    if (piv !== col) [M[piv], M[col]] = [M[col], M[piv]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

interface ElemGeom {
  L: number;
  c: number;
  s: number;
}

function elemGeom(a: FemNode, b: FemNode): ElemGeom {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-12) throw new Error(`zero-length member ${a.id}->${b.id}`);
  return { L, c: dx / L, s: dy / L };
}

/** Local stiffness for a frame member (6x6, DOFs u1 v1 th1 u2 v2 th2). */
function localK(m: FemMember, g: ElemGeom): number[][] {
  const { L } = g;
  const ea = m.E * m.A / L;
  const k: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0));
  k[0][0] = ea; k[0][3] = -ea;
  k[3][0] = -ea; k[3][3] = ea;
  if (!m.truss && m.I > 0) {
    const e1 = m.E * m.I / Math.pow(L, 3);
    const e2 = m.E * m.I / Math.pow(L, 2);
    k[1][1] = 12 * e1; k[1][2] = 6 * e2; k[1][4] = -12 * e1; k[1][5] = 6 * e2;
    k[2][1] = 6 * e2; k[2][2] = 4 * m.E * m.I / L; k[2][4] = -6 * e2; k[2][5] = 2 * m.E * m.I / L;
    k[4][1] = -12 * e1; k[4][2] = -6 * e2; k[4][4] = 12 * e1; k[4][5] = -6 * e2;
    k[5][1] = 6 * e2; k[5][2] = 2 * m.E * m.I / L; k[5][4] = -6 * e2; k[5][5] = 4 * m.E * m.I / L;
  }
  return k;
}

/** Transform local 6-vector to global (Tᵀ f). */
function toGlobal6(g: ElemGeom, f: number[]): number[] {
  const { c, s } = g;
  const out = new Array(6).fill(0);
  // T maps global→local per node: [u_l] = [c s; -s c][u_g, v_g], θ unchanged.
  // Tᵀ = transpose blocks.
  out[0] = c * f[0] - s * f[1];
  out[1] = s * f[0] + c * f[1];
  out[2] = f[2];
  out[3] = c * f[3] - s * f[4];
  out[4] = s * f[3] + c * f[4];
  out[5] = f[5];
  return out;
}

/** Transform global 6-vector to local (T f). */
function toLocal6(g: ElemGeom, f: number[]): number[] {
  const { c, s } = g;
  const out = new Array(6).fill(0);
  out[0] = c * f[0] + s * f[1];
  out[1] = -s * f[0] + c * f[1];
  out[2] = f[2];
  out[3] = c * f[3] + s * f[4];
  out[4] = -s * f[3] + c * f[4];
  out[5] = f[5];
  return out;
}

/**
 * Solve the frame. Throws on unstable models (missing supports, mechanism).
 */
export function solveFrame(model: FemModel): FemResult {
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const memberById = new Map(model.members.map((m) => [m.id, m]));
  const nodeIndex = new Map(model.nodes.map((n, i) => [n.id, i]));
  const ndof = model.nodes.length * 3;

  // ── Assemble K and load vector ───────────────────────────────────────────
  const K: number[][] = Array.from({ length: ndof }, () => new Array(ndof).fill(0));
  const F = new Array(ndof).fill(0);

  for (const m of model.members) {
    const a = nodeById.get(m.nodeA);
    const b = nodeById.get(m.nodeB);
    if (!a || !b) throw new Error(`member ${m.id}: unknown node`);
    const g = elemGeom(a, b);
    const kl = localK(m, g);
    // Global element stiffness: Kg = Tᵀ Kl T (T per-node blocks [[c,s,0],[-s,c,0],[0,0,1]]).
    const T = transMatrix(g);
    const Tt = transpose(T);
    const tmp = matMul(kl, T);
    const kg = matMul(Tt, tmp);
    const dofs = [nodeIndex.get(m.nodeA)! * 3, nodeIndex.get(m.nodeA)! * 3 + 1, nodeIndex.get(m.nodeA)! * 3 + 2,
      nodeIndex.get(m.nodeB)! * 3, nodeIndex.get(m.nodeB)! * 3 + 1, nodeIndex.get(m.nodeB)! * 3 + 2];
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) K[dofs[i]][dofs[j]] += kg[i][j];
    }

    // ── Consistent load vector for member loads ────────────────────────────
    const feqLocal = new Array(6).fill(0);
    for (const u of model.memberUdls ?? []) {
      if (u.memberId !== m.id) continue;
      const wx = u.wx ?? 0;
      const wy = u.wy ?? 0;
      // Global → local components (per unit length).
      const qx = wx * g.c + wy * g.s;
      const qy = -wx * g.s + wy * g.c;
      const { L } = g;
      feqLocal[0] += qx * L / 2;
      feqLocal[3] += qx * L / 2;
      feqLocal[1] += qy * L / 2;
      feqLocal[4] += qy * L / 2;
      feqLocal[2] += qy * L * L / 12;
      feqLocal[5] += -qy * L * L / 12;
    }
    for (const p of model.memberPointLoads ?? []) {
      if (p.memberId !== m.id) continue;
      const t = Math.min(1, Math.max(0, p.t));
      const fx = p.fx ?? 0;
      const fy = p.fy ?? 0;
      const px = fx * g.c + fy * g.s;
      const py = -fx * g.s + fy * g.c;
      const { L } = g;
      feqLocal[0] += px * (1 - t);
      feqLocal[3] += px * t;
      feqLocal[1] += py * (1 - 3 * t * t + 2 * t * t * t);
      feqLocal[2] += py * L * (t - 2 * t * t + t * t * t);
      feqLocal[4] += py * (3 * t * t - 2 * t * t * t);
      feqLocal[5] += py * L * (-t * t + t * t * t);
    }
    if (feqLocal.some((v) => v !== 0)) {
      const feqGlobal = toGlobal6(g, feqLocal);
      for (let i = 0; i < 6; i++) F[dofs[i]] += feqGlobal[i];
    }
  }

  for (const nl of model.nodalLoads ?? []) {
    const i = nodeIndex.get(nl.nodeId);
    if (i === undefined) throw new Error(`nodal load: unknown node ${nl.nodeId}`);
    F[i * 3] += nl.fx ?? 0;
    F[i * 3 + 1] += nl.fy ?? 0;
    F[i * 3 + 2] += nl.mz ?? 0;
  }

  // ── Boundary conditions ──────────────────────────────────────────────────
  // Nodes connected only to truss members have no rotational stiffness;
  // auto-restrain their rz (standard truss-model practice) so the system
  // stays non-singular.
  const bendingNodes = new Set<string>();
  for (const m of model.members) {
    if (!m.truss) {
      bendingNodes.add(m.nodeA);
      bendingNodes.add(m.nodeB);
    }
  }
  const free: number[] = [];
  const fixed: number[] = [];
  for (let i = 0; i < model.nodes.length; i++) {
    const n = model.nodes[i];
    for (let d = 0; d < 3; d++) {
      const restrained = d === 0 ? n.ux : d === 1 ? n.uy : n.rz || !bendingNodes.has(n.id);
      (restrained ? fixed : free).push(i * 3 + d);
    }
  }
  if (free.length === 0) throw new Error("model has no free dof");
  const Kff = free.map((r) => free.map((c) => K[r][c]));
  const Ff = free.map((r) => F[r]);
  const uf = solveDense(Kff, Ff);
  if (!uf) throw new Error("structure unstable or singular (check supports/fixity)");

  const U = new Array(ndof).fill(0);
  free.forEach((d, k) => (U[d] = uf[k]));

  // ── Recover reactions and member forces ─────────────────────────────────
  const displacements = new Map<string, [number, number, number]>();
  for (const n of model.nodes) {
    const i = nodeIndex.get(n.id)!;
    displacements.set(n.id, [U[i * 3], U[i * 3 + 1], U[i * 3 + 2]]);
  }

  // Total internal global force vector: z = Σ Kg u_e (per element).
  const z = new Array(ndof).fill(0);
  const memberForces = new Map<string, MemberEndForces>();
  for (const m of model.members) {
    const a = nodeById.get(m.nodeA);
    const b = nodeById.get(m.nodeB);
    const g = elemGeom(a!, b!);
    const dofs = [nodeIndex.get(m.nodeA)! * 3, nodeIndex.get(m.nodeA)! * 3 + 1, nodeIndex.get(m.nodeA)! * 3 + 2,
      nodeIndex.get(m.nodeB)! * 3, nodeIndex.get(m.nodeB)! * 3 + 1, nodeIndex.get(m.nodeB)! * 3 + 2];
    const uGlobal = dofs.map((d) => U[d]);
    const uLocal = toLocal6(g, uGlobal);
    const kl = localK(m, g);

    // Repeat the equivalent load assembly for this member (local).
    const feqLocal = new Array(6).fill(0);
    for (const u of model.memberUdls ?? []) {
      if (u.memberId !== m.id) continue;
      const wx = u.wx ?? 0;
      const wy = u.wy ?? 0;
      const qx = wx * g.c + wy * g.s;
      const qy = -wx * g.s + wy * g.c;
      const { L } = g;
      feqLocal[0] += qx * L / 2;
      feqLocal[3] += qx * L / 2;
      feqLocal[1] += qy * L / 2;
      feqLocal[4] += qy * L / 2;
      feqLocal[2] += qy * L * L / 12;
      feqLocal[5] += -qy * L * L / 12;
    }
    for (const p of model.memberPointLoads ?? []) {
      if (p.memberId !== m.id) continue;
      const t = Math.min(1, Math.max(0, p.t));
      const fx = p.fx ?? 0;
      const fy = p.fy ?? 0;
      const px = fx * g.c + fy * g.s;
      const py = -fx * g.s + fy * g.c;
      const { L } = g;
      feqLocal[0] += px * (1 - t);
      feqLocal[3] += px * t;
      feqLocal[1] += py * (1 - 3 * t * t + 2 * t * t * t);
      feqLocal[2] += py * L * (t - 2 * t * t + t * t * t);
      feqLocal[4] += py * (3 * t * t - 2 * t * t * t);
      feqLocal[5] += py * L * (-t * t + t * t * t);
    }

    // Internal element end forces in local axes: f = K u − f_eq.
    const fInt = new Array(6).fill(0);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) fInt[i] += kl[i][j] * uLocal[j];
      fInt[i] -= feqLocal[i];
    }
    memberForces.set(m.id, {
      N1: -fInt[0],
      N2: fInt[3],
      V1: fInt[1],
      V2: -fInt[4],
      M1: -fInt[2],
      M2: fInt[5],
    });

    const zLocalG = toGlobal6(g, fInt);
    for (let i = 0; i < 6; i++) z[dofs[i]] += zLocalG[i];
  }

  const reactions: FemResult["reactions"] = [];
  for (const n of model.nodes) {
    const i = nodeIndex.get(n.id)!;
    const restrained = n.ux || n.uy || n.rz || !bendingNodes.has(n.id);
    if (!restrained) continue;
    const nl = (model.nodalLoads ?? []).find((l) => l.nodeId === n.id);
    reactions.push({
      nodeId: n.id,
      fx: z[i * 3] - (n.ux ? (nl?.fx ?? 0) : 0),
      fy: z[i * 3 + 1] - (n.uy ? (nl?.fy ?? 0) : 0),
      // Only report mz if the user explicitly pinned rotation.
      mz: n.rz ? z[i * 3 + 2] - (nl?.mz ?? 0) : 0,
    });
  }

  let maxDeflection = 0;
  for (const [, d] of displacements) maxDeflection = Math.max(maxDeflection, Math.hypot(d[0], d[1]));

  return { displacements, reactions, memberForces, ndof, maxDeflection };
}

function transMatrix(g: ElemGeom): number[][] {
  const { c, s } = g;
  const nodeBlock = [[c, s, 0], [-s, c, 0], [0, 0, 1]];
  return [
    ...nodeBlock.map((r) => [...r]),
    ...nodeBlock.map((r) => [...r]),
  ];
}

function transpose(M: number[][]): number[][] {
  const n = M.length;
  const out = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i][j] = M[j][i];
  return out;
}

function matMul(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const out = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const a = A[i][k];
      if (a === 0) continue;
      for (let j = 0; j < n; j++) out[i][j] += a * B[k][j];
    }
  }
  return out;
}

/**
 * Deflection profile along a member (local y displacement, metres), from
 * Hermite interpolation of end displacements plus the UDL particular
 * solution — exact for uniformly loaded prismatic members. Point loads
 * between nodes are not captured between endpoints (place them at nodes).
 */
export function memberDeflectionProfile(
  model: FemModel,
  result: FemResult,
  memberId: string,
  samples = 21,
): { x: number; v: number }[] {
  const m = model.members.find((mm) => mm.id === memberId);
  if (!m) throw new Error(`unknown member ${memberId}`);
  const a = model.nodes.find((n) => n.id === m.nodeA)!;
  const b = model.nodes.find((n) => n.id === m.nodeB)!;
  const g = elemGeom(a, b);
  const da = result.displacements.get(m.nodeA)!;
  const db = result.displacements.get(m.nodeB)!;
  const uGlobal = [da[0], da[1], da[2], db[0], db[1], db[2]];
  const u = toLocal6(g, uGlobal);
  const { L } = g;

  // Sum of UDL components in local y.
  let qy = 0;
  for (const udl of model.memberUdls ?? []) {
    if (udl.memberId !== memberId) continue;
    const wx = udl.wx ?? 0;
    const wy = udl.wy ?? 0;
    qy += -wx * g.s + wy * g.c;
  }

  const out: { x: number; v: number }[] = [];
  const EI = m.truss ? 0 : m.E * m.I;
  for (let k = 0; k < samples; k++) {
    const xi = k / (samples - 1);
    const x = xi * L;
    // Hermite shape functions (θ in radians).
    const N1 = 1 - 3 * xi * xi + 2 * xi * xi * xi;
    const N2 = L * (xi - 2 * xi * xi + xi * xi * xi);
    const N3 = 3 * xi * xi - 2 * xi * xi * xi;
    const N4 = L * (-xi * xi + xi * xi * xi);
    let v = N1 * u[1] + N2 * u[2] + N3 * u[4] + N4 * u[5];
    if (qy !== 0 && EI > 0) {
      // Particular solution for UDL on a fixed-fixed span (zero end values).
      v += (qy * x * x * (L - x) * (L - x)) / (24 * EI);
    }
    out.push({ x, v });
  }
  return out;
}
