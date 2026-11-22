"use strict";
/**
 * Electrical quick engineering — voltage drop, conductor selection, checks.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 * Complements src/modules/mep/electrical.ts (panels/circuits schedules).
 *
 * Method:
 *   - Conductor DC resistance per IEC 60228 at 20 °C, corrected to the
 *     operating temperature with the temperature coefficient of copper
 *     (α ≈ 0.00393 /K; aluminium ≈ 0.00403 /K).
 *   - Voltage drop for single-phase uses the full loop (2·L); for
 *     three-phase the line-to-neutral path uses √3·L, and the load's power
 *     factor weighs resistance and reactance: ΔV = I·k·(R'·cosφ + X'·sinφ).
 *   - Ampacity reference: IEC 60364-5-52 Table B.52.4, method C (clipped
 *     direct), PVC insulation, two loaded conductors, 30 °C ambient — a
 *     typical reference that must be re-checked against the actual
 *     installation method and any derating.
 *
 * All results are checking aids; the governing installation code wins.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONDUCTOR_SIZES = exports.AMPACITY_CU_PVC_C = exports.ALPHA_AL = exports.ALPHA_CU = exports.AL_RESISTANCE_FACTOR = exports.CU_RESISTANCE_OHM_KM = void 0;
exports.conductorResistanceOhmKm = conductorResistanceOhmKm;
exports.voltageDrop = voltageDrop;
exports.maxCableLengthForDrop = maxCableLengthForDrop;
exports.selectConductor = selectConductor;
exports.conductorCheck = conductorCheck;
/** IEC 60228 DC resistance of copper conductors (Ω/km at 20 °C). */
exports.CU_RESISTANCE_OHM_KM = {
    "1.5": 12.1, "2.5": 7.41, "4": 4.61, "6": 3.08, "10": 1.83,
    "16": 1.15, "25": 0.727, "35": 0.524, "50": 0.387, "70": 0.268,
    "95": 0.193, "120": 0.153, "150": 0.124, "185": 0.0991, "240": 0.0754,
};
/** Aluminium resistivity factor vs copper for the same cross-section. */
exports.AL_RESISTANCE_FACTOR = 1.64;
/** Temperature coefficient of resistance (per K). */
exports.ALPHA_CU = 0.00393;
exports.ALPHA_AL = 0.00403;
/**
 * Reference ampacity (A) — Cu, PVC insulated, method C (clipped direct),
 * two loaded conductors, 30 °C ambient (IEC 60364-5-52 B.52.4 style).
 */
exports.AMPACITY_CU_PVC_C = {
    "1.5": 17.5, "2.5": 24, "4": 32, "6": 41, "10": 57, "16": 76,
    "25": 101, "35": 125, "50": 153, "70": 196, "95": 238, "120": 276,
    "150": 319, "185": 364, "240": 430,
};
/** Conductor sizes (mm^2) in ascending order. */
exports.CONDUCTOR_SIZES = Object.keys(exports.CU_RESISTANCE_OHM_KM)
    .map(Number)
    .sort((a, b) => a - b);
/** Resistance of one conductor at operating temperature (Ω/km). */
function conductorResistanceOhmKm(sizeMm2, material = "cu", operatingTempC = 70) {
    const key = String(sizeMm2);
    const cu20 = exports.CU_RESISTANCE_OHM_KM[key];
    if (cu20 == null)
        return 0;
    const alpha = material === "al" ? exports.ALPHA_AL : exports.ALPHA_CU;
    const r = cu20 * (1 + alpha * (operatingTempC - 20));
    return material === "al" ? r * exports.AL_RESISTANCE_FACTOR : r;
}
/**
 * Voltage drop of a feeder. Accepts the actual load current; percent drop
 * is referenced to the given system voltage.
 */
function voltageDrop(input) {
    const pf = input.powerFactor == null ? 1 : Math.min(1, Math.max(0, input.powerFactor));
    const sinPhi = Math.sqrt(Math.max(0, 1 - pf * pf));
    const rOhmKm = conductorResistanceOhmKm(input.conductorMm2, input.material ?? "cu", input.operatingTempC ?? 70);
    const xOhmKm = input.reactanceOhmKm ?? 0.08;
    const k = input.phase === 1 ? 2 : Math.sqrt(3);
    const km = input.lengthM / 1000;
    const resistanceOhm = k * km * rOhmKm;
    const reactanceOhm = k * km * xOhmKm;
    const dropV = input.currentA * (resistanceOhm * pf + reactanceOhm * sinPhi);
    return {
        dropV,
        dropPercent: input.voltageV > 0 ? (dropV / input.voltageV) * 100 : 0,
        resistanceOhm,
        reactanceOhm,
        pathFactor: k,
    };
}
/**
 * Maximum one-way length (m) for a permitted voltage-drop percentage.
 * Same model as `voltageDrop`; inverts the equation analytically.
 */
function maxCableLengthForDrop(input) {
    const pf = input.powerFactor == null ? 1 : Math.min(1, Math.max(0, input.powerFactor));
    const sinPhi = Math.sqrt(Math.max(0, 1 - pf * pf));
    const rOhmKm = conductorResistanceOhmKm(input.conductorMm2, input.material ?? "cu", input.operatingTempC ?? 70);
    const xOhmKm = input.reactanceOhmKm ?? 0.08;
    const k = input.phase === 1 ? 2 : Math.sqrt(3);
    const allowedV = (input.maxDropPercent / 100) * input.voltageV;
    const perAmpPerKm = k * (rOhmKm * pf + xOhmKm * sinPhi);
    if (perAmpPerKm <= 0 || input.currentA <= 0)
        return 0;
    return (allowedV / (input.currentA * perAmpPerKm)) * 1000;
}
/**
 * Smallest standard conductor whose reference ampacity covers the design
 * current. Returns 0 when nothing in the table fits.
 */
function selectConductor(designCurrentA, material = "cu") {
    // Reference table is for copper; aluminium is derated ~0.78 from copper.
    const needed = material === "al" ? designCurrentA / 0.78 : designCurrentA;
    for (const size of exports.CONDUCTOR_SIZES) {
        const iz = exports.AMPACITY_CU_PVC_C[String(size)];
        if (iz != null && iz >= needed)
            return { mm2: size, ampacityA: iz };
    }
    return null;
}
/**
 * Classic overcurrent coordination check (IEC 60364-4-43 style):
 *   Ib ≤ In ≤ Iz   (design current ≤ breaker rating ≤ cable ampacity)
 * plus an optional voltage-drop advisory.
 */
function conductorCheck(input) {
    const findings = [];
    const iz = exports.AMPACITY_CU_PVC_C[String(input.conductorMm2)] ?? 0;
    if (iz === 0)
        findings.push(`Unknown conductor size ${input.conductorMm2} mm^2.`);
    if (input.designCurrentA > input.breakerRatingA) {
        findings.push(`Design current ${input.designCurrentA} A exceeds the ${input.breakerRatingA} A breaker — upsize the breaker or trim the load.`);
    }
    if (iz > 0 && input.breakerRatingA > iz) {
        findings.push(`Breaker ${input.breakerRatingA} A exceeds conductor ampacity ${iz} A (${input.conductorMm2} mm^2) — In ≤ Iz violated.`);
    }
    if (iz > 0 && input.designCurrentA > iz) {
        findings.push(`Design current ${input.designCurrentA} A exceeds conductor ampacity ${iz} A — upsize the cable.`);
    }
    let dropPercent = null;
    if (input.lengthM != null && input.voltageV != null && input.voltageV > 0) {
        const vd = voltageDrop({
            phase: input.phase ?? 3,
            voltageV: input.voltageV,
            currentA: input.designCurrentA,
            lengthM: input.lengthM,
            conductorMm2: input.conductorMm2,
            powerFactor: input.powerFactor,
            material: input.material ?? "cu",
        });
        dropPercent = vd.dropPercent;
        const limit = input.maxDropPercent ?? 3;
        if (vd.dropPercent > limit) {
            findings.push(`Voltage drop ${vd.dropPercent.toFixed(2)}% exceeds the ${limit}% limit — upsize or shorten the run.`);
        }
    }
    return { ok: findings.length === 0, findings, dropPercent };
}
