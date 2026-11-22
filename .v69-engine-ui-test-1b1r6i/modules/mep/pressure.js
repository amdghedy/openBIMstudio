"use strict";
/**
 * MEP pressure-loss engineering — duct and pipe hydraulics.
 *
 * Complements sizing.ts (which picks standard sizes from flow/velocity)
 * with the physics RVT's system inspector reports: friction pressure
 * drop, fitting losses, and the available-pressure budget along the
 * worst path of a distribution tree.
 *
 * Methods:
 *   - Darcy–Weisbach: Δp = f · (L/Dh) · (ρv²/2)
 *   - Colebrook–White implicit friction factor, solved by Newton
 *     iteration (seeded by the Swamee–Jain explicit formula).
 *   - Laminar fallback f = 64/Re below Re = 2300.
 *   - Fittings via loss coefficients: Δp = ΣC · (ρv²/2).
 *   - Water systems report both pressure (Pa) and head (m).
 *
 * Fluid properties at 20 °C, 1 atm: air ρ=1.204 kg/m³, μ=1.81e-5 Pa·s;
 * water ρ=998.2 kg/m³, μ=1.002e-3 Pa·s.
 *
 * Fitting loss coefficients are typical ASHRAE/IDHA values for stock
 * fittings — approximate by design, not a substitute for manufacturer
 * data.
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FLUID = exports.ROUGHNESS = exports.FITTING_C = void 0;
exports.hydraulicDiameter = hydraulicDiameter;
exports.colebrook = colebrook;
exports.ductPressureDrop = ductPressureDrop;
exports.pipePressureDrop = pipePressureDrop;
exports.worstPath = worstPath;
exports.classifyFrictionRate = classifyFrictionRate;
exports.FITTING_C = {
    "elbow-90-radius": 0.22,
    "elbow-90-miter": 1.2,
    "elbow-45": 0.12,
    "tee-run": 0.1,
    "tee-branch": 1.0,
    "reducer": 0.15,
    "expansion": 0.6,
    "entrance": 0.5,
    "exit": 1.0,
    "damper": 0.2,
    "diffuser": 0.8,
    "check-valve": 2.0,
    "gate-valve-open": 0.15,
    "butterfly-valve": 0.5,
};
/** Surface roughness ε (m) for common materials. */
exports.ROUGHNESS = {
    "galvanized-steel": 0.00015,
    "spiral-duct": 0.00012,
    "flex-duct": 0.003,
    "fiberglass-board": 0.0009,
    "pvc": 0.0000015,
    "copper": 0.0000015,
    "steel-pipe": 0.000045,
    "pex": 0.000007,
    "concrete": 0.003,
};
/** Fluid property sets. */
exports.FLUID = {
    air: { rho: 1.204, mu: 1.81e-5 },
    water: { rho: 998.2, mu: 1.002e-3 },
};
/** Hydraulic diameter of a duct cross-section (m). */
function hydraulicDiameter(d) {
    if (d.diameter && d.diameter > 0)
        return d.diameter;
    if (d.width && d.height && d.width > 0 && d.height > 0) {
        return (2 * d.width * d.height) / (d.width + d.height);
    }
    throw new Error("duct segment needs diameter or width+height");
}
/** Colebrook–White friction factor via Newton on x = 1/√f. */
function colebrook(reynolds, relRough) {
    if (reynolds < 2300)
        return 64 / Math.max(reynolds, 1e-6); // laminar
    // Swamee–Jain seed.
    const f0 = 0.25 / Math.pow(Math.log10(relRough / 3.7 + 5.74 / Math.pow(reynolds, 0.9)), 2);
    let x = 1 / Math.sqrt(Math.max(f0, 1e-6));
    for (let i = 0; i < 30; i++) {
        const g = x + 2 * Math.log10(relRough / 3.7 + 2.51 * x / reynolds);
        const dg = 1 + (2 * 2.51 / reynolds) / (Math.LN10 * (relRough / 3.7 + 2.51 * x / reynolds));
        const step = g / dg;
        x -= step;
        if (Math.abs(step) < 1e-12)
            break;
    }
    const f = 1 / (x * x);
    return Math.min(Math.max(f, 64 / reynolds), 0.2);
}
/** Compute the pressure drop of a duct segment (air). */
function ductPressureDrop(seg) {
    const Dh = hydraulicDiameter(seg);
    const rho = seg.density ?? exports.FLUID.air.rho;
    const mu = seg.viscosity ?? exports.FLUID.air.mu;
    const area = areaOf(seg);
    const velocity = seg.flow / area;
    const reynolds = (rho * velocity * Dh) / mu;
    const eps = seg.roughness ?? exports.ROUGHNESS[seg.material ?? "galvanized-steel"];
    const f = colebrook(reynolds, eps / Dh);
    const vHead = (rho * velocity * velocity) / 2;
    const dpFriction = f * (seg.length / Dh) * vHead;
    let cSum = 0;
    for (const fit of seg.fittings ?? [])
        cSum += exports.FITTING_C[fit.kind] * (fit.count ?? 1);
    const dpFittings = cSum * vHead;
    return {
        velocity,
        hydraulicDiameter: Dh,
        reynolds,
        frictionFactor: f,
        dpFriction,
        dpFittings,
        dpTotal: dpFriction + dpFittings,
        frictionRate: seg.length > 0 ? dpFriction / seg.length : 0,
        headLoss: dpTotal0(dpFriction + dpFittings, rho),
    };
}
/** Compute the pressure/head loss of a pipe segment (water by default). */
function pipePressureDrop(seg) {
    const Dh = seg.diameter;
    const rho = seg.density ?? exports.FLUID.water.rho;
    const mu = seg.viscosity ?? exports.FLUID.water.mu;
    const area = (Math.PI * Dh * Dh) / 4;
    const velocity = seg.flow / area;
    const reynolds = (rho * velocity * Dh) / mu;
    const eps = seg.roughness ?? exports.ROUGHNESS[seg.material ?? "steel-pipe"];
    const f = colebrook(reynolds, eps / Dh);
    const vHead = (rho * velocity * velocity) / 2;
    const dpFriction = f * (seg.length / Dh) * vHead;
    let cSum = 0;
    for (const fit of seg.fittings ?? [])
        cSum += exports.FITTING_C[fit.kind] * (fit.count ?? 1);
    const dpFittings = cSum * vHead;
    return {
        velocity,
        hydraulicDiameter: Dh,
        reynolds,
        frictionFactor: f,
        dpFriction,
        dpFittings,
        dpTotal: dpFriction + dpFittings,
        frictionRate: seg.length > 0 ? dpFriction / seg.length : 0,
        headLoss: (dpFriction + dpFittings) / (rho * 9.80665),
    };
}
function areaOf(seg) {
    if (seg.diameter && seg.diameter > 0)
        return (Math.PI * seg.diameter * seg.diameter) / 4;
    if (seg.width && seg.height)
        return seg.width * seg.height;
    throw new Error("duct segment needs diameter or width+height");
}
function dpTotal0(dp, rho) {
    return dp / (rho * 9.80665);
}
/**
 * Find the critical (highest total drop) path from source to any sink.
 * Distribution trees are acyclic in practice; DFS guards against cycles
 * with a visited set.
 */
function worstPath(net) {
    const out = new Map();
    for (const e of net.edges) {
        if (!out.has(e.from))
            out.set(e.from, []);
        out.get(e.from).push(e);
    }
    const sinks = new Set(net.sinks ?? net.edges
        .filter((e) => !net.edges.some((o) => o.from === e.to))
        .map((e) => e.to));
    let best = { edgeIds: [], nodes: [net.source], totalDp: 0 };
    const visited = new Set([net.source]);
    const dfs = (node, edgeIds, nodes, dp) => {
        if (sinks.has(node) && dp > best.totalDp) {
            best = { edgeIds: [...edgeIds], nodes: [...nodes], totalDp: dp };
        }
        for (const e of out.get(node) ?? []) {
            if (visited.has(e.to))
                continue; // cycle guard
            visited.add(e.to);
            edgeIds.push(e.id);
            nodes.push(e.to);
            dfs(e.to, edgeIds, nodes, dp + e.dp);
            edgeIds.pop();
            nodes.pop();
            visited.delete(e.to);
        }
    };
    dfs(net.source, [], [net.source], 0);
    return best;
}
/**
 * Classify a duct sizing against a friction budget — the quick health
 * metric designers read off the ASHRAE friction chart.
 */
function classifyFrictionRate(rate) {
    if (rate < 0.4)
        return "low";
    if (rate <= 1.0)
        return "recommended"; // ASHRAE low-velocity design band
    return "high";
}
