/**
 * Mitred end faces for thick linear elements (walls, beams, braces, strips).
 * Rule (orientation independent): looking from the joint along each body AWAY from it,
 *   self-left meets peer-right, self-right meets peer-left.
 *
 * Join-status semantics (all orientation independent, all deterministic):
 *   "allow"     — full miter: both faces cut to the shared miter line (classic corner).
 *   "disallow"  — square end, no join.
 *   "butt"      — square end, no join (alias kept for RVT imports).
 *   "extended"  — the whole square end plane slides OUT along the body axis until the
 *                 outer face corner reaches the peer's far-face plane (the wall "runs
 *                 long" into the corner; end stays square, flush with the peer's far side).
 *   "chamfer"   — ONE face is cut to the convex miter point, the other stays square at
 *                 the original end: a flat diagonal chamfer across the outside of the turn.
 * Degenerate inputs (no peer, parallel peers, cut/extend beyond maxMiterFactor × the
 * thicknesses) fall back to a plain square end — never an unbounded miter.
 */
export type V2 = [number, number];
export interface JoinPeer { id: string; start: V2; end: V2; thickness: number; joinStatus?: string }
export interface EndFaces { left: V2; right: V2; joined: boolean }

function hit(p: V2, d: V2, q: V2, e: V2): V2 | null {
  const det = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(det) < 1e-9) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / det;
  return [p[0] + t * d[0], p[1] + t * d[1]];
}

/** null when no element ends at this point (caller handles T junctions / free ends). */
export function mitreEndFaces(
  end: V2, dir: V2, halfT: number, atStart: boolean, selfId: string, peers: JoinPeer[], maxMiterFactor = 6,
): EndFaces | null {
  const nx = -dir[1], nz = dir[0];
  const plainL: V2 = [end[0] + nx * halfT, end[1] + nz * halfT];
  const plainR: V2 = [end[0] - nx * halfT, end[1] - nz * halfT];
  const self = peers.find((p) => p.id === selfId);
  const selfStatus = String(self?.joinStatus ?? "allow");
  if (selfStatus === "disallow" || selfStatus === "butt") return { left: plainL, right: plainR, joined: false };

  const tol = Math.max(0.2, halfT * 3);
  let best: { peer: JoinPeer; at: V2; other: V2; d: number; cross: number } | null = null;
  const uA: V2 = atStart ? [dir[0], dir[1]] : [-dir[0], -dir[1]];
  for (const o of peers) {
    if (o.id === selfId) continue;
    const s = String(o.joinStatus ?? "allow");
    if (s === "disallow" || s === "butt") continue;
    for (const [at, other] of [[o.start, o.end], [o.end, o.start]] as [V2, V2][]) {
      const d = Math.hypot(at[0] - end[0], at[1] - end[1]);
      if (d > tol) continue;
      const len = Math.hypot(other[0] - at[0], other[1] - at[1]);
      if (len < 1e-6) continue;
      const uB: V2 = [(other[0] - at[0]) / len, (other[1] - at[1]) / len];
      const cross = Math.abs(uA[0] * uB[1] - uA[1] * uB[0]);
      if (!best || d < best.d - 1e-3 || (Math.abs(d - best.d) <= 1e-3 && cross > best.cross)) best = { peer: o, at, other, d, cross };
    }
  }
  if (!best) return null;

  const { peer, at, other } = best;
  const bl = Math.hypot(other[0] - at[0], other[1] - at[1]);
  const uB: V2 = [(other[0] - at[0]) / bl, (other[1] - at[1]) / bl];
  const crossS = uA[0] * uB[1] - uA[1] * uB[0];
  if (Math.abs(crossS) < 1e-3) {
    const cont = uA[0] * uB[0] + uA[1] * uB[1] < 0;
    return { left: plainL, right: plainR, joined: cont };
  }

  const hB = Math.max(0.005, (Number(peer.thickness) > 0 ? Number(peer.thickness) : 0.2) / 2);
  const nA: V2 = [-uA[1], uA[0]];
  const nB: V2 = [-uB[1], uB[0]];
  const aL: V2 = [end[0] + nA[0] * halfT, end[1] + nA[1] * halfT];
  const aR: V2 = [end[0] - nA[0] * halfT, end[1] - nA[1] * halfT];
  const bL: V2 = [at[0] + nB[0] * hB, at[1] + nB[1] * hB];
  const bR: V2 = [at[0] - nB[0] * hB, at[1] - nB[1] * hB];
  const limit = Math.max(halfT, hB) * maxMiterFactor;

  // "extended": slide the whole square end plane out along the body axis (−uA)
  // until the outer-face corner reaches the peer's far-face plane.
  if (selfStatus === "extended") {
    // Signed side of the turn decides which plain corner is the OUTER one:
    // crossS < 0 → outer corner is on the aL face line, crossS > 0 → aR.
    const away: V2 = [-uA[0], -uA[1]];
    const pFarL = hit(aL, away, bR, uB);
    const pFarR = hit(aR, away, bL, uB);
    const sL = pFarL ? (pFarL[0] - aL[0]) * away[0] + (pFarL[1] - aL[1]) * away[1] : -1;
    const sR = pFarR ? (pFarR[0] - aR[0]) * away[0] + (pFarR[1] - aR[1]) * away[1] : -1;
    // Both offsets are equal for a clean corner; accept the largest finite positive.
    const s = Math.max(sL, sR);
    if (Number.isFinite(s) && s > 1e-9 && s <= limit) {
      const eL: V2 = [aL[0] + away[0] * s, aL[1] + away[1] * s];
      const eR: V2 = [aR[0] + away[0] * s, aR[1] + away[1] * s];
      return atStart ? { left: eL, right: eR, joined: true } : { left: eR, right: eL, joined: true };
    }
    return { left: plainL, right: plainR, joined: false };
  }

  const cL = hit(aL, uA, bR, uB);
  const cR = hit(aR, uA, bL, uB);

  // "chamfer": cut ONE face to its miter point (the convex side of the turn),
  // keep the other face square at the original end.
  if (selfStatus === "chamfer") {
    const okL = !!cL && Math.hypot(cL[0] - end[0], cL[1] - end[1]) <= limit;
    const okR = !!cR && Math.hypot(cR[0] - end[0], cR[1] - end[1]) <= limit;
    let faceL: V2 = aL;
    let faceR: V2 = aR;
    if (crossS < 0 && okL) faceL = cL!;
    else if (crossS > 0 && okR) faceR = cR!;
    return atStart ? { left: faceL, right: faceR, joined: okL || okR } : { left: faceR, right: faceL, joined: okL || okR };
  }

  const okL = !!cL && Math.hypot(cL[0] - end[0], cL[1] - end[1]) <= limit;
  const okR = !!cR && Math.hypot(cR[0] - end[0], cR[1] - end[1]) <= limit;
  const faceL: V2 = okL ? cL! : aL;
  const faceR: V2 = okR ? cR! : aR;
  return atStart ? { left: faceL, right: faceR, joined: true } : { left: faceR, right: faceL, joined: true };
}