"use strict";
/**
 * 3D frame finite-element solver (Euler-Bernoulli, 6 DOF per node).
 *
 * Extends the 2D solver (fem.ts) to full spatial frames — the analytical
 * model RVT maintains for structural columns / beams / braces:
 *
 *   - 12×12 prismatic frame element stiffness: axial (EA), torsion (GJ)
 *     and biaxial bending (EIzz strong / EIyy weak) with consistent
 *     (exact for Euler-Bernoulli) distributed-load vectors.
 *   - Local axes from the member direction + a reference vector: for a
 *     horizontal member local y points up (global +Z), for vertical
 *     members local y = global +X, local z = global +Y.
 *   - Member loads are specified in GLOBAL axes (wx, wy, wz / fx, fy, fz)
 *     and converted internally; nodal loads are forces + moments.
 *   - Nodes restrained per-DOF (ux..rz). Nodes connected only to truss
 *     members get their rotations auto-restrained (standard truss-model
 *     practice — no rotational stiffness would leave the system singular).
 *
 * Verification: cantilever tip deflection PL³/3EI, simply supported UDL
 * 5wL⁴/384EI, axial PL/EA, torsion TL/GJ and shear-frame sway Hh³/24EI
 * are all reproduced to machine precision by tests/structural-3d.test.cjs.
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.solveFrame3D = solveFrame3D;
exports.memberDeflectionProfile3D = memberDeflectionProfile3D;
exports.memberMomentProfile3D = memberMomentProfile3D;
/** Solve a dense linear system A x = b (Gaussian elimination, partial pivot). */
function solveDense(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(M[r][col]) > Math.abs(M[piv][col]))
                piv = r;
        }
        if (Math.abs(M[piv][col]) < 1e-18)
            return null;
        if (piv !== col)
            [M[piv], M[col]] = [M[col], M[piv]];
        for (let r = col + 1; r < n; r++) {
            const f = M[r][col] / M[col][col];
            if (f === 0)
                continue;
            for (let c = col; c <= n; c++)
                M[r][c] -= f * M[col][c];
        }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let s = M[r][n];
        for (let c = r + 1; c < n; c++)
            s -= M[r][c] * x[c];
        x[r] = s / M[r][r];
    }
    return x;
}
/** Local axes for a member: x̂ along A→B; ẑ = x̂ × aux (aux = +Z unless x̂ ≈ ±Z, then +X); ŷ = ẑ × x̂. */
function elemGeom(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-12)
        throw new Error(`zero-length member ${a.id}->${b.id}`);
    const x = [dx / L, dy / L, dz / L];
    const aux = Math.abs(x[2]) < 0.999 ? [0, 0, 1] : [1, 0, 0];
    // ẑ = x̂ × aux
    let z = [x[1] * aux[2] - x[2] * aux[1], x[2] * aux[0] - x[0] * aux[2], x[0] * aux[1] - x[1] * aux[0]];
    const zn = Math.hypot(z[0], z[1], z[2]);
    if (zn < 1e-12)
        throw new Error(`degenerate orientation for member ${a.id}->${b.id}`);
    z = [z[0] / zn, z[1] / zn, z[2] / zn];
    // ŷ = ẑ × x̂
    const y = [
        z[1] * x[2] - z[2] * x[1],
        z[2] * x[0] - z[0] * x[2],
        z[0] * x[1] - z[1] * x[0],
    ];
    // R rows are the local axes in global components → global→local is R·v.
    return { L, R: [x, y, z] };
}
/** Global 12-vector → local (T·v, T = diag(R,R,R,R) blocked per node). */
function toLocal12(g, v) {
    const out = new Array(12).fill(0);
    for (let n = 0; n < 4; n++) {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++)
                out[n * 3 + i] += g.R[i][j] * v[n * 3 + j];
        }
    }
    return out;
}
/** Local 12-vector → global (Tᵀ·v). */
function toGlobal12(g, v) {
    const out = new Array(12).fill(0);
    for (let n = 0; n < 4; n++) {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++)
                out[n * 3 + i] += g.R[j][i] * v[n * 3 + j];
        }
    }
    return out;
}
/** Local 12×12 stiffness: DOFs [u1 v1 w1 θx1 θy1 θz1 u2 v2 w2 θx2 θy2 θz2]. */
function localK(m, g) {
    const { L } = g;
    const G = m.G ?? m.E / (2 * (1 + 0.2));
    const k = Array.from({ length: 12 }, () => new Array(12).fill(0));
    const ea = m.E * m.A / L;
    k[0][0] = ea;
    k[0][6] = -ea;
    k[6][0] = -ea;
    k[6][6] = ea;
    if (m.truss || (m.Izz <= 0 && m.Iyy <= 0 && m.J <= 0))
        return k;
    const gj = G * m.J / L;
    k[3][3] = gj;
    k[3][9] = -gj;
    k[9][3] = -gj;
    k[9][9] = gj;
    const zz1 = m.E * m.Izz / Math.pow(L, 3);
    const zz2 = m.E * m.Izz / Math.pow(L, 2);
    const zz3 = m.E * m.Izz / L;
    // Bending in the local xy plane (deflection v, rotation θz, stiffness EIzz).
    k[1][1] = 12 * zz1;
    k[1][5] = 6 * zz2;
    k[1][7] = -12 * zz1;
    k[1][11] = 6 * zz2;
    k[5][1] = 6 * zz2;
    k[5][5] = 4 * zz3;
    k[5][7] = -6 * zz2;
    k[5][11] = 2 * zz3;
    k[7][1] = -12 * zz1;
    k[7][5] = -6 * zz2;
    k[7][7] = 12 * zz1;
    k[7][11] = -6 * zz2;
    k[11][1] = 6 * zz2;
    k[11][5] = 2 * zz3;
    k[11][7] = -6 * zz2;
    k[11][11] = 4 * zz3;
    const yy1 = m.E * m.Iyy / Math.pow(L, 3);
    const yy2 = m.E * m.Iyy / Math.pow(L, 2);
    const yy3 = m.E * m.Iyy / L;
    // Bending in the local xz plane (deflection w, rotation θy, stiffness EIyy).
    k[2][2] = 12 * yy1;
    k[2][4] = -6 * yy2;
    k[2][8] = -12 * yy1;
    k[2][10] = -6 * yy2;
    k[4][2] = -6 * yy2;
    k[4][4] = 4 * yy3;
    k[4][8] = 6 * yy2;
    k[4][10] = 2 * yy3;
    k[8][2] = -12 * yy1;
    k[8][4] = 6 * yy2;
    k[8][8] = 12 * yy1;
    k[8][10] = 6 * yy2;
    k[10][2] = -6 * yy2;
    k[10][4] = 2 * yy3;
    k[10][8] = 6 * yy2;
    k[10][10] = 4 * yy3;
    return k;
}
/**
 * Consistent load vector for the member's distributed/point loads.
 * Loads arrive in global axes; converted to local per unit length.
 */
function memberFixedEndLoads(m, g, udl, pt) {
    const { L, R } = g;
    const f = new Array(12).fill(0);
    if (m.truss) {
        // Axial components only.
        if (udl) {
            const qx = R[0][0] * (udl.wx ?? 0) + R[0][1] * (udl.wy ?? 0) + R[0][2] * (udl.wz ?? 0);
            f[0] += qx * L / 2;
            f[6] += qx * L / 2;
        }
        if (pt) {
            const t = Math.min(1, Math.max(0, pt.t));
            const px = R[0][0] * (pt.fx ?? 0) + R[0][1] * (pt.fy ?? 0) + R[0][2] * (pt.fz ?? 0);
            f[0] += px * (1 - t);
            f[6] += px * t;
        }
        return f;
    }
    if (udl) {
        const gx = udl.wx ?? 0;
        const gy = udl.wy ?? 0;
        const gz = udl.wz ?? 0;
        // Local components: q_l = R · q_g (per unit length).
        const qx = R[0][0] * gx + R[0][1] * gy + R[0][2] * gz;
        const qy = R[1][0] * gx + R[1][1] * gy + R[1][2] * gz;
        const qz = R[2][0] * gx + R[2][1] * gy + R[2][2] * gz;
        f[0] += qx * L / 2;
        f[6] += qx * L / 2;
        f[1] += qy * L / 2;
        f[7] += qy * L / 2;
        f[5] += qy * L * L / 12;
        f[11] += -qy * L * L / 12;
        f[2] += qz * L / 2;
        f[8] += qz * L / 2;
        f[4] += -qz * L * L / 12;
        f[10] += qz * L * L / 12;
    }
    if (pt) {
        const t = Math.min(1, Math.max(0, pt.t));
        const px = R[0][0] * (pt.fx ?? 0) + R[0][1] * (pt.fy ?? 0) + R[0][2] * (pt.fz ?? 0);
        const py = R[1][0] * (pt.fx ?? 0) + R[1][1] * (pt.fy ?? 0) + R[1][2] * (pt.fz ?? 0);
        const pz = R[2][0] * (pt.fx ?? 0) + R[2][1] * (pt.fy ?? 0) + R[2][2] * (pt.fz ?? 0);
        f[0] += px * (1 - t);
        f[6] += px * t;
        f[1] += py * (1 - 3 * t * t + 2 * t * t * t);
        f[5] += py * L * (t - 2 * t * t + t * t * t);
        f[7] += py * (3 * t * t - 2 * t * t * t);
        f[11] += py * L * (-t * t + t * t * t);
        f[2] += pz * (1 - 3 * t * t + 2 * t * t * t);
        f[4] += -pz * L * (t - 2 * t * t + t * t * t);
        f[8] += pz * (3 * t * t - 2 * t * t * t);
        f[10] += pz * L * (-t * t + t * t * t);
    }
    return f;
}
/**
 * Solve the spatial frame. Throws on unstable models (missing supports,
 * mechanisms). Member loads and nodal loads are given in global axes.
 */
function solveFrame3D(model) {
    const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
    const nodeIndex = new Map(model.nodes.map((n, i) => [n.id, i]));
    const ndof = model.nodes.length * 6;
    const K = Array.from({ length: ndof }, () => new Array(ndof).fill(0));
    const F = new Array(ndof).fill(0);
    const udlByMember = new Map();
    for (const u of model.memberUdls ?? []) {
        const arr = udlByMember.get(u.memberId) ?? [];
        arr.push(u);
        udlByMember.set(u.memberId, arr);
    }
    const ptByMember = new Map();
    for (const p of model.memberPointLoads ?? []) {
        const arr = ptByMember.get(p.memberId) ?? [];
        arr.push(p);
        ptByMember.set(p.memberId, arr);
    }
    for (const m of model.members) {
        const a = nodeById.get(m.nodeA);
        const b = nodeById.get(m.nodeB);
        if (!a || !b)
            throw new Error(`member ${m.id}: unknown node`);
        const g = elemGeom(a, b);
        const kl = localK(m, g);
        const dofs = [0, 1, 2, 3, 4, 5].map((d) => nodeIndex.get(m.nodeA) * 6 + d)
            .concat([0, 1, 2, 3, 4, 5].map((d) => nodeIndex.get(m.nodeB) * 6 + d));
        // Kg = Tᵀ Kl T — T maps global 12-vectors to local (blocks of R), so
        // Kg = Rᵀ·Kl·R. (f_l = R·f_g ⇒ f_g = Rᵀ·Kl·R·u_g.)
        const Tm = Array.from({ length: 12 }, () => new Array(12).fill(0));
        for (let n = 0; n < 4; n++) {
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++)
                    Tm[n * 3 + i][n * 3 + j] = g.R[i][j]; // global→local blocks
            }
        }
        const kg = Array.from({ length: 12 }, () => new Array(12).fill(0));
        for (let i = 0; i < 12; i++) {
            for (let j = 0; j < 12; j++) {
                let s = 0;
                for (let p = 0; p < 12; p++) {
                    const a1 = Tm[p][i];
                    if (a1 === 0)
                        continue;
                    const row = kl[p];
                    let s2 = 0;
                    for (let q = 0; q < 12; q++)
                        s2 += row[q] * Tm[q][j];
                    s += a1 * s2;
                }
                kg[i][j] = s;
            }
        }
        for (let i = 0; i < 12; i++) {
            for (let j = 0; j < 12; j++)
                K[dofs[i]][dofs[j]] += kg[i][j];
        }
        // Consistent load vectors for this member's loads.
        const udls = udlByMember.get(m.id) ?? [];
        const pts = ptByMember.get(m.id) ?? [];
        if (udls.length || pts.length) {
            const feqLocal = new Array(12).fill(0);
            for (const u of udls) {
                const fu = memberFixedEndLoads(m, g, u, undefined);
                for (let i = 0; i < 12; i++)
                    feqLocal[i] += fu[i];
            }
            for (const p of pts) {
                const fp = memberFixedEndLoads(m, g, undefined, p);
                for (let i = 0; i < 12; i++)
                    feqLocal[i] += fp[i];
            }
            const feqGlobal = toGlobal12(g, feqLocal);
            for (let i = 0; i < 12; i++)
                F[dofs[i]] += feqGlobal[i];
        }
    }
    for (const nl of model.nodalLoads ?? []) {
        const i = nodeIndex.get(nl.nodeId);
        if (i === undefined)
            throw new Error(`nodal load: unknown node ${nl.nodeId}`);
        F[i * 6] += nl.fx ?? 0;
        F[i * 6 + 1] += nl.fy ?? 0;
        F[i * 6 + 2] += nl.fz ?? 0;
        F[i * 6 + 3] += nl.mx ?? 0;
        F[i * 6 + 4] += nl.my ?? 0;
        F[i * 6 + 5] += nl.mz ?? 0;
    }
    // ── Boundary conditions ──────────────────────────────────────────────────
    // Nodes connected only to truss members have no rotational stiffness —
    // auto-restrain all their rotations.
    const bendingNodes = new Set();
    for (const m of model.members) {
        if (!m.truss) {
            bendingNodes.add(m.nodeA);
            bendingNodes.add(m.nodeB);
        }
    }
    const free = [];
    const fixed = [];
    for (let i = 0; i < model.nodes.length; i++) {
        const n = model.nodes[i];
        for (let d = 0; d < 6; d++) {
            const explicit = d === 0 ? n.ux : d === 1 ? n.uy : d === 2 ? n.uz
                : d === 3 ? n.rx : d === 4 ? n.ry : n.rz;
            const restrained = d >= 3 ? (explicit || !bendingNodes.has(n.id)) : explicit;
            (restrained ? fixed : free).push(i * 6 + d);
        }
    }
    if (free.length === 0)
        throw new Error("model has no free dof");
    const Kff = free.map((r) => free.map((c) => K[r][c]));
    const Ff = free.map((r) => F[r]);
    const uf = solveDense(Kff, Ff);
    if (!uf)
        throw new Error("structure unstable or singular (check supports/fixity)");
    const U = new Array(ndof).fill(0);
    free.forEach((d, k) => (U[d] = uf[k]));
    // ── Recover displacements, member forces and reactions ──────────────────
    const displacements = new Map();
    for (const n of model.nodes) {
        const i = nodeIndex.get(n.id);
        displacements.set(n.id, [U[i * 6], U[i * 6 + 1], U[i * 6 + 2], U[i * 6 + 3], U[i * 6 + 4], U[i * 6 + 5]]);
    }
    const z = new Array(ndof).fill(0);
    const memberForces = new Map();
    for (const m of model.members) {
        const a = nodeById.get(m.nodeA);
        const b = nodeById.get(m.nodeB);
        const g = elemGeom(a, b);
        const dofs = [0, 1, 2, 3, 4, 5].map((d) => nodeIndex.get(m.nodeA) * 6 + d)
            .concat([0, 1, 2, 3, 4, 5].map((d) => nodeIndex.get(m.nodeB) * 6 + d));
        const uGlobal = dofs.map((d) => U[d]);
        const uLocal = toLocal12(g, uGlobal);
        const kl = localK(m, g);
        const udls = udlByMember.get(m.id) ?? [];
        const pts = ptByMember.get(m.id) ?? [];
        const feqLocal = new Array(12).fill(0);
        for (const u of udls) {
            const fu = memberFixedEndLoads(m, g, u, undefined);
            for (let i = 0; i < 12; i++)
                feqLocal[i] += fu[i];
        }
        for (const p of pts) {
            const fp = memberFixedEndLoads(m, g, undefined, p);
            for (let i = 0; i < 12; i++)
                feqLocal[i] += fp[i];
        }
        // Internal element end forces in local axes: f = K u − f_eq.
        const fInt = new Array(12).fill(0);
        for (let i = 0; i < 12; i++) {
            let s = 0;
            for (let j = 0; j < 12; j++)
                s += kl[i][j] * uLocal[j];
            fInt[i] = s - feqLocal[i];
        }
        memberForces.set(m.id, {
            N1: -fInt[0],
            N2: fInt[6],
            T1: -fInt[3],
            T2: fInt[9],
            Vy1: fInt[1],
            Vy2: -fInt[7],
            Vz1: fInt[2],
            Vz2: -fInt[8],
            My1: -fInt[4],
            My2: fInt[10],
            Mz1: -fInt[5],
            Mz2: fInt[11],
        });
        const zLocalG = toGlobal12(g, fInt);
        for (let i = 0; i < 12; i++)
            z[dofs[i]] += zLocalG[i];
    }
    const reactions = [];
    for (const n of model.nodes) {
        const i = nodeIndex.get(n.id);
        const nl = (model.nodalLoads ?? []).find((l) => l.nodeId === n.id);
        const comp = (d) => {
            const explicit = d === 0 ? n.ux : d === 1 ? n.uy : d === 2 ? n.uz
                : d === 3 ? n.rx : d === 4 ? n.ry : n.rz;
            const restrained = d >= 3 ? (explicit || !bendingNodes.has(n.id)) : explicit;
            if (!restrained)
                return 0;
            const applied = d === 0 ? (nl?.fx ?? 0) : d === 1 ? (nl?.fy ?? 0) : d === 2 ? (nl?.fz ?? 0)
                : d === 3 ? (nl?.mx ?? 0) : d === 4 ? (nl?.my ?? 0) : (nl?.mz ?? 0);
            // Auto-restrained truss rotations carry no meaningful reaction.
            if (d >= 3 && !explicit && !bendingNodes.has(n.id))
                return 0;
            return z[i * 6 + d] - applied;
        };
        if (n.ux || n.uy || n.uz || n.rx || n.ry || n.rz) {
            reactions.push({
                nodeId: n.id,
                fx: comp(0), fy: comp(1), fz: comp(2),
                mx: comp(3), my: comp(4), mz: comp(5),
            });
        }
    }
    let maxDeflection = 0;
    for (const [, d] of displacements) {
        maxDeflection = Math.max(maxDeflection, Math.hypot(d[0], d[1], d[2]));
    }
    return { displacements, reactions, memberForces, ndof, maxDeflection };
}
/**
 * Deflection profile along a member in local y (metres) — Hermite
 * interpolation of end displacements plus the UDL particular solution,
 * exact for uniformly loaded prismatic members. Point loads between nodes
 * are not captured between endpoints (place them at nodes for exactness).
 */
function memberDeflectionProfile3D(model, result, memberId, samples = 21) {
    const m = model.members.find((mm) => mm.id === memberId);
    if (!m)
        throw new Error(`unknown member ${memberId}`);
    const a = model.nodes.find((n) => n.id === m.nodeA);
    const b = model.nodes.find((n) => n.id === m.nodeB);
    const g = elemGeom(a, b);
    const da = result.displacements.get(m.nodeA);
    const db = result.displacements.get(m.nodeB);
    const uGlobal = [...da.slice(0, 3), ...da.slice(3), ...db.slice(0, 3), ...db.slice(3)];
    const u = toLocal12(g, uGlobal);
    const { L, R } = g;
    let qy = 0;
    for (const udl of model.memberUdls ?? []) {
        if (udl.memberId !== memberId)
            continue;
        const gx = udl.wx ?? 0;
        const gy = udl.wy ?? 0;
        const gz = udl.wz ?? 0;
        qy += R[1][0] * gx + R[1][1] * gy + R[1][2] * gz;
    }
    const out = [];
    const EI = m.truss ? 0 : m.E * m.Izz;
    for (let k = 0; k < samples; k++) {
        const xi = k / (samples - 1);
        const x = xi * L;
        const N1 = 1 - 3 * xi * xi + 2 * xi * xi * xi;
        const N2 = L * (xi - 2 * xi * xi + xi * xi * xi);
        const N3 = 3 * xi * xi - 2 * xi * xi * xi;
        const N4 = L * (-xi * xi + xi * xi * xi);
        let v = N1 * u[1] + N2 * u[5] + N3 * u[7] + N4 * u[11];
        if (qy !== 0 && EI > 0) {
            v += (qy * x * x * (L - x) * (L - x)) / (24 * EI);
        }
        out.push({ x, v });
    }
    return out;
}
/**
 * Bending-moment profile along a member from its end forces and member
 * loads, by section statics: M(x) = M_end + V_end·x + q·x²/2 — exact for
 * uniformly loaded members (point loads between nodes are not captured;
 * place them at nodes). Strong axis: mz = Mz1 + Vy1·x + qy·x²/2 (sagging
 * positive). Weak axis: my = My1 + Vz1·x + qz·x²/2.
 */
function memberMomentProfile3D(model, result, memberId, samples = 21) {
    const m = model.members.find((mm) => mm.id === memberId);
    if (!m)
        throw new Error(`unknown member ${memberId}`);
    const a = model.nodes.find((n) => n.id === m.nodeA);
    const b = model.nodes.find((n) => n.id === m.nodeB);
    const g = elemGeom(a, b);
    const f = result.memberForces.get(memberId);
    if (!f)
        throw new Error(`no forces for member ${memberId}`);
    // Local UDL components (per unit length).
    let qy = 0;
    let qz = 0;
    for (const udl of model.memberUdls ?? []) {
        if (udl.memberId !== memberId)
            continue;
        const gx = udl.wx ?? 0;
        const gy = udl.wy ?? 0;
        const gz = udl.wz ?? 0;
        qy += g.R[1][0] * gx + g.R[1][1] * gy + g.R[1][2] * gz;
        qz += g.R[2][0] * gx + g.R[2][1] * gy + g.R[2][2] * gz;
    }
    const out = [];
    const { L } = g;
    for (let k = 0; k < samples; k++) {
        const x = (k / (samples - 1)) * L;
        const mz = f.Mz1 + f.Vy1 * x + (qy * x * x) / 2;
        const my = f.My1 + f.Vz1 * x + (qz * x * x) / 2;
        out.push({ x, mz, my });
    }
    return out;
}
