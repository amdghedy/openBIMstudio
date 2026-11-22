"use strict";
/**
 * Steel section catalog — metric properties for common rolled shapes.
 *
 * Values are metricated from AISC v15 (W shapes, ASTM A992: Fy = 345 MPa)
 * and European IPE/HEA tables (S275: Fy = 275 MPa). Figures are rounded to
 * catalog precision; they are intended for preliminary design and model
 * sanity checks — verify against the current controlling standard before
 * fabrication.
 *
 * Pure data + helpers: no DOM, no three.js. Safe to unit-test in Node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STEEL_SECTIONS = void 0;
exports.findSection = findSection;
const IN2M = 0.0254;
const IN2_TO_M2 = IN2M * IN2M;
const IN3_TO_M3 = IN2_TO_M2 * IN2M;
const IN4_TO_M4 = IN3_TO_M3 * IN2M;
function w(id, d_in, tw_in, bf_in, A_in2, Ix_in4, Zx_in3) {
    return {
        id,
        family: "W",
        d: d_in * IN2M,
        tw: tw_in * IN2M,
        bf: bf_in * IN2M,
        A: A_in2 * IN2_TO_M2,
        Ix: Ix_in4 * IN4_TO_M4,
        Zx: Zx_in3 * IN3_TO_M3,
        Fy: 345e6,
    };
}
function metric(id, family, d_mm, tw_mm, bf_mm, A_cm2, Ix_cm4, Zx_cm3) {
    return {
        id,
        family,
        d: d_mm / 1000,
        tw: tw_mm / 1000,
        bf: bf_mm / 1000,
        A: A_cm2 * 1e-4,
        Ix: Ix_cm4 * 1e-8,
        Zx: Zx_cm3 * 1e-6,
        Fy: 275e6,
    };
}
/** Catalog. IDs are case-insensitive lookup keys. */
exports.STEEL_SECTIONS = [
    // ── AISC W shapes (ASTM A992, Fy = 345 MPa) ──────────────────────────────
    w("W10X12", 9.87, 0.19, 3.96, 3.54, 53.8, 12.6),
    w("W12X26", 12.2, 0.23, 6.49, 7.65, 204, 37.2),
    w("W14X22", 13.7, 0.23, 5.0, 6.49, 199, 33.1),
    w("W16X26", 15.7, 0.25, 5.5, 7.68, 301, 44.1),
    w("W18X35", 17.7, 0.3, 6.0, 10.3, 510, 66.5),
    w("W18X40", 17.9, 0.315, 6.02, 11.8, 612, 78.4),
    w("W21X44", 20.7, 0.35, 6.5, 13.0, 843, 95.4),
    w("W12X40", 11.9, 0.295, 8.01, 11.7, 307, 57.0),
    w("W14X53", 13.9, 0.37, 8.06, 15.6, 541, 87.1),
    w("W16X31", 15.9, 0.275, 5.53, 9.13, 375, 54.0),
    // ── IPE (S275) ───────────────────────────────────────────────────────────
    metric("IPE200", "IPE", 200, 6.5, 100, 28.5, 1943, 220.6),
    metric("IPE250", "IPE", 250, 7.5, 125, 42.2, 4020, 366.6),
    metric("IPE300", "IPE", 300, 7.5, 150, 53.8, 8356, 628.4),
    metric("IPE360", "IPE", 360, 8.0, 170, 72.7, 16270, 1019),
    metric("IPE400", "IPE", 400, 8.6, 180, 84.5, 23130, 1307),
    // ── HEA (S275) ───────────────────────────────────────────────────────────
    metric("HEA200", "HEA", 190, 6.5, 200, 53.8, 3692, 429.9),
    metric("HEA240", "HEA", 230, 7.5, 240, 76.8, 7763, 744.6),
    metric("HEA300", "HEA", 290, 8.5, 300, 112.5, 18260, 1383.2),
    metric("HEA360", "HEA", 350, 10.0, 300, 142.8, 33040, 2082),
];
/** Look up a section by id (case-insensitive). */
function findSection(id) {
    const key = id.replace(/\s+/g, "").toUpperCase();
    return exports.STEEL_SECTIONS.find((s) => s.id.toUpperCase() === key);
}
