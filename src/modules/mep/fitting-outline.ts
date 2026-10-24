/**
 * Plan outlines for MEP tees, crosses, wyes and caps (pure, no THREE).
 *
 * Each arm is a rectangle of the duct/pipe width running from the junction centre. The outline of the
 * union is every arm's two side lines minus the parts that lie inside another arm - exactly what a
 * Revit tee looks like in plan (run continues, branch opens into it, no end caps where runs join).
 */
export interface Seg { x1: number; z1: number; x2: number; z2: number }

export type ArmKind = "tee" | "cross" | "wye";

/** Same stub length as the 3D fitting so plan and 3D agree. */
export function fittingArmLength(thickness: number, height: number, bendRadius: number | undefined, isRound: boolean): number {
  const w = Math.max(thickness, 0.08);
  const fallback = (isRound ? thickness : Math.max(thickness, height)) / 2;
  const r = Math.max(Number.isFinite(bendRadius as number) && (bendRadius as number) > 0 ? (bendRadius as number) : fallback, 0.04);
  return Math.max(r * 2.4, w * 1.6);
}

/** Arm directions (radians, CCW from east): main run both ways + branch(es). */
export function fittingArmAngles(kind: ArmKind, aIn: number, aOut: number): number[] {
  const arms = [aIn, aIn + Math.PI, aOut];
  if (kind === "cross") arms.push(aOut + Math.PI);
  else if (kind === "wye") arms.push((aIn + aOut) / 2);
  return arms;
}

/** Remove from segment s the parts inside an oriented rectangle (centre line c + d*[0,len], half width hw). */
function subtractRect(s: Seg, cx: number, cz: number, dx: number, dz: number, len: number, hw: number): Seg[] {
  // segment in the rect's local frame: u along arm, v across
  const loc = (x: number, z: number) => ({ u: (x - cx) * dx + (z - cz) * dz, v: -(x - cx) * dz + (z - cz) * dx });
  const a = loc(s.x1, s.z1), b = loc(s.x2, s.z2);
  // parametric interval [t0,t1] where the segment is inside u in [0,len], |v| < hw
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number): boolean => {          // p*t <= q
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  const du = b.u - a.u, dv = b.v - a.v;
  const inside =
    clip(-du, a.u - 0) && clip(du, len - a.u) &&
    clip(-dv, a.v + hw) && clip(dv, hw - a.v);
  if (!inside || t1 - t0 < 1e-9) return [s];
  const at = (t: number) => ({ x: s.x1 + (s.x2 - s.x1) * t, z: s.z1 + (s.z2 - s.z1) * t });
  const out: Seg[] = [];
  if (t0 > 1e-9) { const p = at(t0); out.push({ x1: s.x1, z1: s.z1, x2: p.x, z2: p.z }); }
  if (t1 < 1 - 1e-9) { const p = at(t1); out.push({ x1: p.x, z1: p.z, x2: s.x2, z2: s.z2 }); }
  return out;
}

export function fittingOutlineSegments(cx: number, cz: number, angles: number[], width: number, armLen: number): Seg[] {
  const hw = Math.max(width, 0.01) / 2;
  const eps = 0.0005;
  const dirs = angles.map((a) => ({ dx: Math.cos(a), dz: Math.sin(a) }));
  let result: Seg[] = [];
  dirs.forEach((d, i) => {
    const nx = -d.dz, nz = d.dx;
    for (const side of [1, -1]) {
      let pieces: Seg[] = [{
        x1: cx + nx * hw * side, z1: cz + nz * hw * side,
        x2: cx + d.dx * armLen + nx * hw * side, z2: cz + d.dz * armLen + nz * hw * side,
      }];
      dirs.forEach((o, j) => {
        if (j === i) return;
        // slightly shrunk so boundaries shared with a collinear arm are kept
        pieces = pieces.flatMap((p) => subtractRect(p, cx, cz, o.dx, o.dz, armLen, hw - eps));
      });
      result = result.concat(pieces);
    }
  });
  return result.filter((s) => Math.hypot(s.x2 - s.x1, s.z2 - s.z1) > 1e-6);
}

/** End cap: a closing line across the run at the junction, plus the short body. */
export function capOutlineSegments(cx: number, cz: number, angle: number, width: number, bodyLen: number): Seg[] {
  const hw = Math.max(width, 0.01) / 2;
  const dx = Math.cos(angle), dz = Math.sin(angle), nx = -dz, nz = dx;
  const ex = cx + dx * bodyLen, ez = cz + dz * bodyLen;
  return [
    { x1: cx + nx * hw, z1: cz + nz * hw, x2: ex + nx * hw, z2: ez + nz * hw },
    { x1: cx - nx * hw, z1: cz - nz * hw, x2: ex - nx * hw, z2: ez - nz * hw },
    { x1: ex + nx * hw, z1: ez + nz * hw, x2: ex - nx * hw, z2: ez - nz * hw },
  ];
}

/** Cut the opening of a branch arm out of a segment (used to open a host run's side line at a tee). */
export function openBranchInSegment(s: Seg, cx: number, cz: number, branchAngle: number, armLen: number, width: number): Seg[] {
  return subtractRect(s, cx, cz, Math.cos(branchAngle), Math.sin(branchAngle), armLen, Math.max(width, 0.01) / 2 - 0.0005);
}

/** Branch directions of a tee / cross / wye (everything except the main run). */
export function fittingBranchAngles(kind: ArmKind, aIn: number, aOut: number): number[] {
  return fittingArmAngles(kind, aIn, aOut).slice(2);
}

/** Reducer / transition: trapezoid from the full run width to `outRatio` of it, along `angle`. */
export function transitionOutlineSegments(cx: number, cz: number, angle: number, width: number, length: number, outRatio = 0.6): Seg[] {
  const dx = Math.cos(angle), dz = Math.sin(angle), nx = -dz, nz = dx;
  const hw1 = Math.max(width, 0.01) / 2, hw2 = hw1 * outRatio, h = length / 2;
  const a1 = { x: cx - dx * h + nx * hw1, z: cz - dz * h + nz * hw1 }, a2 = { x: cx - dx * h - nx * hw1, z: cz - dz * h - nz * hw1 };
  const b1 = { x: cx + dx * h + nx * hw2, z: cz + dz * h + nz * hw2 }, b2 = { x: cx + dx * h - nx * hw2, z: cz + dz * h - nz * hw2 };
  // sides only; the two ends join the connected runs (no end lines, like the other joined fittings)
  return [
    { x1: a1.x, z1: a1.z, x2: b1.x, z2: b1.z },
    { x1: a2.x, z1: a2.z, x2: b2.x, z2: b2.z },
  ];
}

/** Coupling / union: the run width over a short body, with two coupling rings across the run. */
export function unionOutlineSegments(cx: number, cz: number, angle: number, width: number, length: number): Seg[] {
  const dx = Math.cos(angle), dz = Math.sin(angle), nx = -dz, nz = dx;
  const hw = Math.max(width, 0.01) / 2 * 1.08, h = length / 2;
  const P = (u: number, v: number) => ({ x: cx + dx * u + nx * v, z: cz + dz * u + nz * v });
  const seg = (a: { x: number; z: number }, b: { x: number; z: number }): Seg => ({ x1: a.x, z1: a.z, x2: b.x, z2: b.z });
  return [
    seg(P(-h, hw), P(h, hw)), seg(P(-h, -hw), P(h, -hw)),
    seg(P(-h, hw), P(-h, -hw)), seg(P(h, hw), P(h, -hw)),
  ];
}
