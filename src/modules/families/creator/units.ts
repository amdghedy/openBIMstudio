// Free family creator, slice 1: length parsing.
// All results are in metres, the unit the family engine stores.

export type LengthUnit = "m" | "cm" | "mm" | "ft" | "in";

const TO_M: Record<LengthUnit, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };

function parseFraction(s: string): number | null {
  const t = s.trim();
  if (!t) return 0;
  // "7 1/2", "1/2", "7.5", "7"
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return null;
}

/**
 * Parse one length. Accepts "3525 mm", "3.525 m", "115 ft", "10 in",
 * feet-inches such as 3'-6 1/2" or 3' 6", and a bare number (uses
 * `defaultUnit`). Returns null when the text is not a clear length, so a
 * caller never guesses.
 */
export function parseLength(text: string, defaultUnit: LengthUnit = "mm"): number | null {
  const v = parseLengthRaw(text, defaultUnit);
  // Drop binary float noise such as 0.7000000000000001 (nanometre precision).
  return v === null ? null : Math.round(v * 1e9) / 1e9;
}

function parseLengthRaw(text: string, defaultUnit: LengthUnit): number | null {
  const s = String(text ?? "").trim().replace(/[\u2032\u2019]/g, "'").replace(/[\u2033\u201D]/g, '"');
  if (!s) return null;

  // feet and optional inches: 3'-6 1/2"  /  3' 6"  /  3'
  const fi = /^(\d+(?:\.\d+)?)\s*'\s*(?:-?\s*(\d+(?:\s+\d+\/\d+|\/\d+|\.\d+)?)\s*"?)?$/.exec(s);
  if (fi) {
    const feet = Number(fi[1]);
    const inches = fi[2] === undefined ? 0 : parseFraction(fi[2]);
    if (inches === null) return null;
    return feet * TO_M.ft + inches * TO_M.in;
  }
  // inches only: 12"
  const io = /^(\d+(?:\s+\d+\/\d+|\/\d+|\.\d+)?)\s*"$/.exec(s);
  if (io) {
    const v = parseFraction(io[1]);
    return v === null ? null : v * TO_M.in;
  }
  const m = /^(\d+(?:\.\d+)?)\s*(mm|cm|m|ft|in|feet|foot|inch|inches)?$/i.exec(s);
  if (!m) return null;
  let unit = (m[2] ?? defaultUnit).toLowerCase();
  if (unit === "feet" || unit === "foot") unit = "ft";
  if (unit === "inch" || unit === "inches") unit = "in";
  return Number(m[1]) * TO_M[unit as LengthUnit];
}

/** Format metres as millimetres for display and IFC properties. */
export function toMillimetres(m: number): number {
  return Math.round(m * 1000 * 1000) / 1000;
}
