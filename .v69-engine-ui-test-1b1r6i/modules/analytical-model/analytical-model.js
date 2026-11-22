"use strict";
/**
 * Analytical model auto-generation from the physical authored model.
 *
 * The signature structural workflow a RVT competitor must own: physical
 * columns / beams / braces are scanned and their ANALYTICAL lines are
 * generated automatically, with:
 *
 *   - Node welding — members that meet (beam end onto column top, stacked
 *     columns through a level, brace into a beam-column joint) share ONE
 *     analytical node. Horizontal position must match (≤ 10 mm); vertical
 *     gaps up to `weldTolerance` (default 0.4 m ≈ RVT's 15" analytical
 *     adjustment) are snapped, and every snap is reported in diagnostics.
 *   - Section inference — rectangular sections from the physical
 *     dimensions (beam depth = height, width = thickness; column square
 *     on its thickness). Torsion constant J from Roark's St-Venant
 *     approximation for rectangles.
 *   - Base fixity — nodes at the model's lowest elevation that terminate a
 *     column become supports (fixed or pinned per option), like RVT
 *     assigning foundation conditions to the lowest analytical nodes.
 *   - Material defaults — E = 30 GPa, ν = 0.2 (normal-weight concrete);
 *     density 24 kN/m³ feeds self-weight multipliers.
 *
 * Z conventions follow the authoring defaults: columns run elevation →
 * elevation + height; beams justify BOTTOM (analytical line at
 * params.elevation, exactly where the supporting column tops end);
 * braces run (start, elevation) → (end, elevation + height).
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rectTorsionConstant = rectTorsionConstant;
exports.generateAnalyticalModel = generateAnalyticalModel;
exports.selfWeightUdls = selfWeightUdls;
/** Roark's St-Venant torsion constant for a rectangle b × h (b ≤ h). */
function rectTorsionConstant(b, h) {
    if (b <= 0 || h <= 0)
        return 0;
    const [bMin, hMax] = b <= h ? [b, h] : [h, b];
    return bMin * bMin * bMin * hMax *
        (1 / 3 - 0.21 * (bMin / hMax) * (1 - Math.pow(bMin, 4) / (12 * hMax * hMax * hMax * hMax)));
}
/** Rectangular section properties: A, Izz (strong — depth vertical), Iyy (weak), J. */
function rectSection(width, depth) {
    const A = width * depth;
    const Izz = width * Math.pow(depth, 3) / 12; // bending about z, deflection in y (vertical loads)
    const Iyy = depth * Math.pow(width, 3) / 12; // bending about y, deflection in z (lateral loads)
    const J = rectTorsionConstant(width, depth);
    return { A, Izz, Iyy, J };
}
function find(parent, i) {
    while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    return i;
}
function union(parent, rank, a, b) {
    const ra = find(parent, a);
    const rb = find(parent, b);
    if (ra === rb)
        return;
    if (rank[ra] < rank[rb])
        parent[ra] = rb;
    else if (rank[ra] > rank[rb])
        parent[rb] = ra;
    else {
        parent[rb] = ra;
        rank[ra]++;
    }
}
/**
 * Generate the analytical frame model from authored structural elements.
 * Non-structural types (walls, slabs, doors…) are skipped; columns, beams
 * and braces become frame members.
 */
function generateAnalyticalModel(elements, opts = {}) {
    const E = opts.E ?? 30e9;
    const density = opts.density ?? 24000;
    const poisson = opts.poisson ?? 0.2;
    const G = E / (2 * (1 + poisson));
    const baseFixity = opts.baseFixity ?? "fixed";
    const braceAsTruss = opts.braceAsTruss ?? true;
    const weldTol = opts.weldTolerance ?? 0.4;
    const warnings = [];
    const joints = [];
    const pushJoint = (x, y, z, owner) => {
        joints.push({ x, y, z, p: joints.length, owner });
        return joints.length - 1;
    };
    const sources = [];
    let columns = 0;
    let beams = 0;
    let braces = 0;
    for (const el of elements) {
        const p = el.params;
        if (el.type === "column") {
            if (!p.point) {
                warnings.push(`column ${el.id}: missing point — skipped`);
                continue;
            }
            const [x, y] = p.point;
            const z0 = p.elevation;
            const z1 = p.elevation + (p.height ?? 3);
            const a = pushJoint(x, y, z0, el.id);
            const b = pushJoint(x, y, z1, el.id);
            const width = p.width ?? p.thickness;
            sources.push({ id: el.id, a, b, role: "column", truss: false, width, depth: p.thickness });
            columns++;
        }
        else if (el.type === "beam") {
            if (!p.start || !p.end) {
                warnings.push(`beam ${el.id}: missing start/end — skipped`);
                continue;
            }
            const a = pushJoint(p.start[0], p.start[1], p.elevation, el.id);
            const b = pushJoint(p.end[0], p.end[1], p.elevation, el.id);
            sources.push({ id: el.id, a, b, role: "beam", truss: false, width: p.thickness, depth: p.height });
            beams++;
        }
        else if (el.type === "brace") {
            if (!p.start || !p.end) {
                warnings.push(`brace ${el.id}: missing start/end — skipped`);
                continue;
            }
            const a = pushJoint(p.start[0], p.start[1], p.elevation, el.id);
            const b = pushJoint(p.end[0], p.end[1], p.elevation + (p.height ?? 1.5), el.id);
            sources.push({
                id: el.id, a, b, role: "brace", truss: braceAsTruss,
                width: p.thickness, depth: p.thickness,
            });
            braces++;
        }
        // Other types (walls, slabs…) are not frame members — skipped silently.
    }
    // ── Weld joints: same plan position (≤ 10 mm), vertical gap ≤ weldTol ────
    // Sort by z so the snap target is deterministic (members weld to the
    // highest joint in their cluster — matches beam-top / column-top joins).
    const order = joints.map((_, i) => i).sort((i, j) => joints[i].z - joints[j].z || joints[i].x - joints[j].x);
    const parent = joints.map((_, i) => i);
    const rank = joints.map(() => 0);
    let weldedAdjustments = 0;
    let maxWeldDz = 0;
    for (let oi = 0; oi < order.length; oi++) {
        for (let oj = oi + 1; oj < order.length; oj++) {
            const i = order[oi];
            const j = order[oj];
            const dz = joints[j].z - joints[i].z;
            if (dz > weldTol)
                break; // sorted by z — no further candidate can weld
            if (Math.hypot(joints[j].x - joints[i].x, joints[j].y - joints[i].y) > 0.01)
                continue;
            union(parent, rank, i, j);
            weldedAdjustments++;
            maxWeldDz = Math.max(maxWeldDz, dz);
        }
    }
    // Cluster representative = highest joint (max z) in each group.
    const clusters = new Map();
    for (let i = 0; i < joints.length; i++) {
        const r = find(parent, i);
        const cur = clusters.get(r);
        if (!cur || joints[i].z >= cur.z) {
            clusters.set(r, { x: joints[i].x, y: joints[i].y, z: joints[i].z });
        }
    }
    const clusterIds = [...clusters.keys()];
    const clusterToNode = new Map();
    const nodes = clusterIds.map((r, idx) => {
        clusterToNode.set(r, idx);
        const c = clusters.get(r);
        return { id: `an-n${idx}`, x: c.x, y: c.y, z: c.z };
    });
    // ── Members ──────────────────────────────────────────────────────────────
    const members = [];
    const memberRoles = new Map();
    for (const s of sources) {
        const na = clusterToNode.get(find(parent, s.a));
        const nb = clusterToNode.get(find(parent, s.b));
        if (na === nb) {
            warnings.push(`${s.role} ${s.id}: both ends land on one node (zero length) — skipped`);
            continue;
        }
        const { A, Izz, Iyy, J } = rectSection(s.width, s.depth);
        const mid = `${s.role}-${s.id}`;
        members.push({
            id: mid,
            nodeA: nodes[na].id,
            nodeB: nodes[nb].id,
            E, G,
            A, Izz, Iyy, J,
            truss: s.truss || undefined,
        });
        memberRoles.set(mid, { elementId: s.id, role: s.role });
        if (A <= 0)
            warnings.push(`${s.role} ${s.id}: zero section area`);
    }
    // ── Brace landing diagnostics: a brace end that shares its joint with no
    // other element produces a floating node — axial-only members cannot hold
    // it, and the solve would fail with a singular system. Say so up front.
    for (const src of sources.filter((x) => x.role === "brace")) {
        for (const ji of [src.a, src.b]) {
            const root = find(parent, ji);
            const shares = joints.some((j, k) => find(parent, k) === root && j.owner !== src.id);
            if (!shares)
                warnings.push(`brace ${src.id}: end does not land on the frame (no joint within ${weldTol} m) — the structure will be unstable`);
        }
    }
    // ── Base fixity: nodes at the model's lowest elevation that terminate a
    // bending member become supports (stacked columns weld through and never
    // get supports there — they are continuous through the joint).
    const minZ = nodes.reduce((m, n) => Math.min(m, n.z), Infinity);
    for (const n of nodes) {
        if (n.z > minZ + 0.05)
            continue;
        const hasBendingEnd = members.some((m) => m.truss !== true && (m.nodeA === n.id || m.nodeB === n.id));
        if (!hasBendingEnd)
            continue;
        if (baseFixity === "fixed") {
            n.ux = true;
            n.uy = true;
            n.uz = true;
            n.rx = true;
            n.ry = true;
            n.rz = true;
        }
        else {
            n.ux = true;
            n.uy = true;
            n.uz = true;
        }
    }
    return {
        model: { nodes, members },
        memberRoles,
        diagnostics: {
            columns, beams, braces,
            nodes: nodes.length,
            weldedAdjustments,
            maxWeldDz,
            warnings,
        },
    };
}
/**
 * Self-weight UDLs for every frame member: w = density · A (N/m), downward
 * (global −Z). Multiply by the load case's selfWeightMultiplier when
 * assembling combination loads.
 */
function selfWeightUdls(gen, density = 24000) {
    const out = [];
    for (const m of gen.model.members) {
        out.push({ memberId: m.id, wz: -density * m.A });
    }
    return out;
}
