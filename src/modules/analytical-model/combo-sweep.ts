/**
 * Load combination sweep — solve every factored combination against the
 * 3D analytical model and produce a governing envelope.
 *
 * Bridges the structural-loads manager (load cases + ASCE 7 / Eurocode
 * combinations) to the 3D frame solver (fem3d.ts). For each combination:
 * scale each case's loads by its factor, add self-weight for cases with a
 * non-zero selfWeightMultiplier, solve, and collect member forces,
 * reactions and deflection. The envelope tracks, per member, the extremes
 * of axial force / shear / bending / deflection and which combination
 * governs each — the same governing-case logic engineers read off RVT +
 * Robot results.
 *
 * Load application conventions (LoadCase from structural-loads-ui):
 *   - type "point" + targetId of a node  → nodal force (N) along direction.
 *   - type "point" + targetId of a member → point load at midspan (N).
 *   - type "line" + targetId of a member → UDL on that member (N/m).
 *   - type "line" without targetId       → UDL applied to ALL members of
 *     the role implied by the case name ("wind" → columns, others → beams);
 *     an explicit `roleForUntargeted` option overrides the heuristic.
 *   - selfWeightMultiplier ≠ 0          → density · A · multiplier UDL
 *     downward on every member.
 *   - magnitude units: N, N/m, N·m (the UI dialog converts kN → N).
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */

import {
  solveFrame3D,
  memberMomentProfile3D,
  type Fem3DModel,
  type Fem3DResult,
  type MemberForces3D,
  type MemberUdl3D,
  type MemberPointLoad3D,
  type NodalLoad3D,
} from "./fem3d";

export interface SweepLoadCase {
  id: string;
  name: string;
  category: string;
  selfWeightMultiplier: number;
  type: "point" | "line" | "area" | "moment" | "body";
  magnitude: number;
  direction?: { x: number; y: number; z: number };
  targetId?: string;
}

export interface SweepLoadCombination {
  id: string;
  name: string;
  cases: Array<{ caseId: string; factor: number }>;
}

export interface SweepOptions {
  /** Density for self-weight (N/m³). Default 24000. */
  density?: number;
  /** Role for untargeted "line" cases: "columns" | "beams" | "auto". Default "auto". */
  roleForUntargeted?: "columns" | "beams" | "auto";
}

export interface ComboResult {
  name: string;
  result: Fem3DResult;
}

export interface MemberEnvelope {
  memberId: string;
  /** Axial extremes (N) — positive tension — with governing combination. */
  NTension: { value: number; combo: string };
  NCompression: { value: number; combo: string };
  /** Resultant shear extreme (N). */
  VMax: { value: number; combo: string };
  /** Strong-axis bending extremes (N·m). */
  MzMax: { value: number; combo: string };
  MzMin: { value: number; combo: string };
  /** Max |translational deflection| at the member's nodes (m). */
  deflMax: { value: number; combo: string };
}

export interface SweepReport {
  results: ComboResult[];
  envelope: Map<string, MemberEnvelope>;
  /** Per combination: Σ vertical reaction vs Σ applied vertical load (N). */
  equilibrium: { combo: string; reactionSumZ: number; loadSumZ: number; ok: boolean }[];
  warnings: string[];
}

function dirUnit(d?: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const v = d ?? { x: 0, y: 0, z: -1 };
  const n = Math.hypot(v.x, v.y, v.z);
  if (n < 1e-12) return { x: 0, y: 0, z: -1 };
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

function shearResultant(f: MemberForces3D): number {
  return Math.max(Math.hypot(f.Vy1, f.Vz1), Math.hypot(f.Vy2, f.Vz2));
}

/**
 * Sweep all combinations. Throws through solveFrame3D on unstable models;
 * a combination that fails to solve is reported in warnings, not thrown
 * (the remaining combinations still produce an envelope).
 */
export function sweepCombinations(
  model: Fem3DModel,
  cases: SweepLoadCase[],
  combinations: SweepLoadCombination[],
  opts: SweepOptions = {},
): SweepReport {
  const density = opts.density ?? 24000;
  const roleForUntargeted = opts.roleForUntargeted ?? "auto";
  const warnings: string[] = [];

  const nodeIds = new Set(model.nodes.map((n) => n.id));
  const memberById = new Map(model.members.map((m) => [m.id, m]));
  const roles = new Map<string, string>();
  // Member naming convention from analytical-model.ts: `<role>-<elementId>`.
  for (const m of model.members) {
    const role = m.id.startsWith("column-") ? "column"
      : m.id.startsWith("beam-") ? "beam"
      : m.id.startsWith("brace-") ? "brace"
      : "other";
    roles.set(m.id, role);
  }

  const results: ComboResult[] = [];
  const equilibrium: SweepReport["equilibrium"] = [];
  const envelope = new Map<string, MemberEnvelope>();
  const deflAtMember = (mId: string, res: Fem3DResult): number => {
    const m = memberById.get(mId);
    if (!m) return 0;
    const da = res.displacements.get(m.nodeA);
    const db = res.displacements.get(m.nodeB);
    const mag = (d?: number[]) => (d ? Math.hypot(d[0], d[1], d[2]) : 0);
    return Math.max(mag(da), mag(db));
  };

  for (const comb of combinations) {
    const nodalLoads: NodalLoad3D[] = [];
    const udls: MemberUdl3D[] = [];
    const pointLoads: MemberPointLoad3D[] = [];

    for (const entry of comb.cases) {
      const lc = cases.find((c) => c.id === entry.caseId);
      if (!lc) {
        warnings.push(`combination '${comb.name}': unknown case '${entry.caseId}' — skipped`);
        continue;
      }
      const f = entry.factor;
      const d = dirUnit(lc.direction);

      if (lc.selfWeightMultiplier !== 0) {
        // w = density · multiplier · factor (N/m³) applied per member as
        // density · A · multiplier · factor downward.
        const wUnit = density * lc.selfWeightMultiplier * f;
        for (const m of model.members) {
          udls.push({ memberId: m.id, wz: -wUnit * m.A });
        }
      }

      if (lc.type === "point") {
        if (lc.targetId && nodeIds.has(lc.targetId)) {
          nodalLoads.push({
            nodeId: lc.targetId,
            fx: d.x * lc.magnitude * f,
            fy: d.y * lc.magnitude * f,
            fz: d.z * lc.magnitude * f,
          });
        } else if (lc.targetId && memberById.has(lc.targetId)) {
          pointLoads.push({
            memberId: lc.targetId,
            t: 0.5,
            fx: d.x * lc.magnitude * f,
            fy: d.y * lc.magnitude * f,
            fz: d.z * lc.magnitude * f,
          });
        } else if (lc.targetId) {
          warnings.push(`case '${lc.name}': target '${lc.targetId}' not found — skipped`);
        } else {
          warnings.push(`case '${lc.name}': point load without target — skipped`);
        }
      } else if (lc.type === "line") {
        const w = lc.magnitude * f;
        if (lc.targetId && memberById.has(lc.targetId)) {
          udls.push({ memberId: lc.targetId, wx: d.x * w, wy: d.y * w, wz: d.z * w });
        } else if (lc.targetId) {
          warnings.push(`case '${lc.name}': target '${lc.targetId}' not found — skipped`);
        } else {
          let role: string;
          if (roleForUntargeted !== "auto") {
            role = roleForUntargeted === "columns" ? "column" : "beam";
          } else {
            const cat = String(lc.category ?? "").toLowerCase();
            role = cat.includes("wind") || cat.includes("seismic") || cat.includes("earth") ? "column" : "beam";
          }
          let applied = 0;
          for (const m of model.members) {
            if (roles.get(m.id) !== role) continue;
            udls.push({ memberId: m.id, wx: d.x * w, wy: d.y * w, wz: d.z * w });
            applied++;
          }
          if (applied === 0) warnings.push(`case '${lc.name}': no ${role} members to receive the load`);
        }
      } else if (lc.type === "moment") {
        if (lc.targetId && nodeIds.has(lc.targetId)) {
          nodalLoads.push({
            nodeId: lc.targetId,
            mx: d.x * lc.magnitude * f,
            my: d.y * lc.magnitude * f,
            mz: d.z * lc.magnitude * f,
          });
        } else {
          warnings.push(`case '${lc.name}': moment load needs a node target — skipped`);
        }
      } else {
        warnings.push(`case '${lc.name}': load type '${lc.type}' is not supported by the frame sweep — skipped`);
      }
    }

    const comboModel: Fem3DModel = { ...model, nodalLoads, memberUdls: udls, memberPointLoads: pointLoads };
    try {
      const result = solveFrame3D(comboModel);
      results.push({ name: comb.name, result });

      const reactionSumZ = result.reactions.reduce((s, r) => s + r.fz, 0);
      // Σ applied vertical load: nodal fz + point fz + UDL wz · member length.
      let loadSumZ = nodalLoads.reduce((s, n) => s + (n.fz ?? 0), 0)
        + pointLoads.reduce((s, p) => s + (p.fz ?? 0), 0);
      for (const u of udls) {
        const m = memberById.get(u.memberId);
        if (!m) continue;
        const a = model.nodes.find((n) => n.id === m.nodeA)!;
        const b = model.nodes.find((n) => n.id === m.nodeB)!;
        loadSumZ += (u.wz ?? 0) * Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      }
      equilibrium.push({
        combo: comb.name,
        reactionSumZ,
        loadSumZ,
        // Reactions OPPOSE the applied load: ΣR = −ΣF (exact for a valid solve).
        ok: Math.abs(reactionSumZ + loadSumZ) <= Math.max(1e-6, 1e-6 * Math.abs(loadSumZ)),
      });

      // Envelope update. Bending extremes come from the member moment
      // PROFILE (end moments alone miss the midspan governing moment of
      // single-span members).
      for (const [mId, f] of result.memberForces) {
        let env = envelope.get(mId);
        if (!env) {
          env = {
            memberId: mId,
            NTension: { value: -Infinity, combo: "" },
            NCompression: { value: Infinity, combo: "" },
            VMax: { value: -Infinity, combo: "" },
            MzMax: { value: -Infinity, combo: "" },
            MzMin: { value: Infinity, combo: "" },
            deflMax: { value: -Infinity, combo: "" },
          };
          envelope.set(mId, env);
        }
        if (f.N1 > env.NTension.value) env.NTension = { value: f.N1, combo: comb.name };
        if (f.N1 < env.NCompression.value) env.NCompression = { value: f.N1, combo: comb.name };
        if (shearResultant(f) > env.VMax.value) env.VMax = { value: shearResultant(f), combo: comb.name };
        try {
          const prof = memberMomentProfile3D(comboModel, result, mId, 11);
          for (const p of prof) {
            if (p.mz > env.MzMax.value) env.MzMax = { value: p.mz, combo: comb.name };
            if (p.mz < env.MzMin.value) env.MzMin = { value: p.mz, combo: comb.name };
          }
        } catch {
          // Profile unavailable — fall back to end moments.
          if (f.Mz1 > env.MzMax.value) env.MzMax = { value: f.Mz1, combo: comb.name };
          if (f.Mz1 < env.MzMin.value) env.MzMin = { value: f.Mz1, combo: comb.name };
        }
        const d = deflAtMember(mId, result);
        if (d > env.deflMax.value) env.deflMax = { value: d, combo: comb.name };
      }
    } catch (e) {
      warnings.push(`combination '${comb.name}' failed to solve: ${(e as Error).message}`);
    }
  }

  return { results, envelope, equilibrium, warnings };
}
