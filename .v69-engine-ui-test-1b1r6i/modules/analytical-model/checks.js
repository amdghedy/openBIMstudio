"use strict";
/**
 * Member code checks — preliminary steel and reinforced-concrete checks fed
 * by the 2D frame solver (fem.ts).
 *
 * Scope (deliberately):
 *   - Steel: compact I-shaped sections, fully braced, strong-axis bending
 *     (φMp = 0.9·Fy·Zx), shear (φVn = 1.0·0.6·Fy·Aw), and deflection
 *     limits. No lateral-torsional buckling, no holes, no axial interaction
 *     yet — this is a preliminary sizing tool, not a replacement for a
 *     full design code engine.
 *   - RC: singly reinforced rectangular sections in flexure (ACI-style
 *     rectangular stress block) plus one-way shear with vertical stirrups.
 *
 * Every result carries the assumptions in `notes` so downstream reports can
 * print them next to the numbers.
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkSteel = checkSteel;
exports.checkRcBeam = checkRcBeam;
/** Check a steel I-section against bending/shear/deflection demand. */
function checkSteel(section, demand, opts = {}) {
    const notes = [
        "compact section, fully braced, strong-axis bending",
    ];
    const phiB = opts.phiB ?? 0.9;
    const phiV = opts.phiV ?? 1.0;
    const Fy = opts.Fy ?? section.Fy;
    const Aw = section.d * section.tw;
    const phiMp = phiB * Fy * section.Zx;
    const phiVn = phiV * 0.6 * Fy * Aw;
    const deflLimit = demand.span / (opts.deflSpanFraction ? 1 / opts.deflSpanFraction : 240);
    const flexUtil = demand.Mu / phiMp;
    const shearUtil = demand.Vu / phiVn;
    const deflUtil = demand.deflection / deflLimit;
    const utilization = Math.max(flexUtil, shearUtil, deflUtil);
    if (flexUtil > 1)
        notes.push("flexural over-stress");
    if (shearUtil > 1)
        notes.push("shear over-stress");
    if (deflUtil > 1)
        notes.push("deflection exceeds limit");
    return {
        sectionId: section.id,
        flexUtil,
        shearUtil,
        deflUtil,
        utilization,
        pass: utilization <= 1,
        phiMp,
        phiVn,
        deflLimit,
        notes,
    };
}
/**
 * Size flexural reinforcement for a singly reinforced rectangular RC
 * section (ACI 318-style rectangular stress block, SI units) and report
 * the concrete shear capacity plus required stirrup spacing.
 */
function checkRcBeam(input, opts = {}) {
    const notes = ["singly reinforced, rectangular stress block"];
    const Mu = opts.Mu ?? 0;
    const Vu = opts.Vu ?? 0;
    const phiB = opts.phiB ?? 0.9;
    const phiV = opts.phiV ?? 0.75;
    const Av = opts.Av ?? 100e-6;
    const { b, d, fc, fy } = input;
    // ρ from Rn: Rn = Mu / (φ b d²); ρ = 0.85fc/fy (1 − √(1 − 2Rn/(0.85fc)))
    const Rn = Mu / (phiB * b * d * d);
    const disc = 1 - (2 * Rn) / (0.85 * fc);
    let AsReq = 0;
    let a = 0;
    if (disc >= 0 && Rn > 0) {
        const rho = ((0.85 * fc) / fy) * (1 - Math.sqrt(disc));
        AsReq = rho * b * d;
        a = (AsReq * fy) / (0.85 * fc * b);
    }
    else if (Rn > 0) {
        notes.push("section too small for the required moment (no tension-controlled solution)");
    }
    const phiMn = phiB * AsReq * fy * (d - a / 2);
    // Concrete shear: φVc = φ · 0.17 · √f'c(MPa) · b·d  (N, SI)
    const phiVc = phiV * 0.17 * Math.sqrt(fc / 1e6) * 1e6 * b * d;
    const shearUtil = phiVc > 0 ? Vu / phiVc : Infinity;
    // Stirrups: Vu > φVc/2 → need stirrups; s = Av·fy·d / max(Vu − φVc/2, ε)
    let stirrupSpacing = null;
    if (Vu > phiVc / 2) {
        const demand = Math.max(Vu - phiVc / 2, 1);
        stirrupSpacing = Math.min((Av * fy * d) / demand, d / 2, 0.6);
        notes.push("stirrups required");
    }
    const flexUtil = phiMn > 0 ? Mu / phiMn : Mu > 0 ? Infinity : 0;
    const pass = flexUtil <= 1.001 && shearUtil <= 2 && !(Rn > 0 && AsReq === 0);
    return {
        AsReq,
        a,
        phiMn,
        phiVc,
        stirrupSpacing,
        flexUtil,
        shearUtil,
        pass,
        notes,
    };
}
