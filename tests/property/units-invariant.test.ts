import fc from 'fast-check';
import { units } from '../../src/core/units';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

// Unit consistency (#98 invariant 9) for src/core/units.ts (SI storage,
// display conversion at the boundary only): conversion round-trips are
// identities, area is length squared, volume is length cubed, imperial
// and metric scales agree, and format → parse round-trips within the
// formatting precision. There is no dedicated units test file on main;
// this is the first property cover for the module.

function relNear(a: number, b: number, tol = 1e-12): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}

// (9a) mm → m → mm identity, and m identity: parsing a value with an
// explicit suffix returns the exact SI value.
fc.assert(
  fc.property(fc.double({ min: 0.001, max: 1e6, noNaN: true, noDefaultInfinity: true }), (v) => {
    if (!relNear(units.parseLength(`${v}mm`) ?? NaN, v * 1e-3)) return false;
    if (!relNear(units.parseLength(`${v}m`) ?? NaN, v)) return false;
    if (!relNear(units.parseLength(`${v}cm`) ?? NaN, v * 1e-2)) return false;
    return true;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (9b) Dimensional correctness: area is length squared, volume is length
// cubed — parsing "L m" squared equals parsing "L² m²", and likewise
// for volume. Note the parser only accepts the superscript spellings
// (m²/m³, as the formatter emits); the ASCII spellings "m2"/"m3" return
// null — an observed parser wart, recorded in pr-description-pe09.md,
// not fixed here.
fc.assert(
  fc.property(fc.double({ min: 0.01, max: 1000, noNaN: true, noDefaultInfinity: true }), (L) => {
    const len = units.parseLength(`${L}m`);
    const area = units.parseArea(`${L * L}m²`);
    if (len === null || area === null) return false;
    if (!relNear(len * len, area)) return false;
    const vol = units.parseVolume(`${L * L * L}m³`);
    if (vol === null) return false;
    return relNear(len * len * len, vol);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (9c) Imperial/metric agreement: feet and inches are the same scale
// (1 ft = 12 in = 0.3048 m), and mm/cm/m agree with each other.
fc.assert(
  fc.property(fc.double({ min: 0.001, max: 1e6, noNaN: true, noDefaultInfinity: true }), (v) => {
    const ft = units.parseLength(`${v}ft`);
    const inch = units.parseLength(`${v * 12}in`);
    if (ft === null || inch === null) return false;
    if (!relNear(ft, inch)) return false;
    if (!relNear(ft, v * 0.3048)) return false;
    const mm = units.parseLength(`${v * 1000}mm`);
    const cm = units.parseLength(`${v * 100}cm`);
    if (mm === null || cm === null) return false;
    return relNear(mm, v) && relNear(cm, v);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (9d) Area and volume unit scales: 1 m2 = 1e6 mm2, 1 m3 = 1e9 mm3, and
// angles: 180 deg = π rad.
fc.assert(
  fc.property(fc.double({ min: 0.001, max: 1e6, noNaN: true, noDefaultInfinity: true }), (v) => {
    const m2 = units.parseArea(`${v}m²`);
    const mm2 = units.parseArea(`${v * 1e6}mm²`);
    if (m2 === null || mm2 === null) return false;
    if (!relNear(m2, mm2)) return false;
    const m3 = units.parseVolume(`${v}m³`);
    const mm3 = units.parseVolume(`${v * 1e9}mm³`);
    if (m3 === null || mm3 === null) return false;
    return relNear(m3, mm3);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

fc.assert(
  fc.property(fc.constant(0), () => {
    const halfTurn = units.parseAngle('180deg');
    if (halfTurn === null || !relNear(halfTurn, Math.PI)) return false;
    const rad = units.parseAngle(`${Math.PI}rad`);
    if (rad === null || !relNear(rad, Math.PI)) return false;
    return true;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (9e) Format → parse round-trip: formatting an SI length and parsing it
// back recovers the value within the formatting precision (6 decimals in
// mm ⇒ ≤ 5e-7 mm = 5e-10 m error).
fc.assert(
  fc.property(fc.double({ min: 0.01, max: 0.9, noNaN: true, noDefaultInfinity: true }), (x) => {
    const formatted = units.formatLength(x, { unit: 'mm', precision: 6 });
    const back = units.parseLength(formatted);
    if (back === null) return false;
    return Math.abs(back - x) <= 1e-9;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

console.log(`PASS units-invariant (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
