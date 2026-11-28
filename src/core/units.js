// openbim-fix:v3:applied -- do not re-apply the earlier fix scripts
/**
 * Unit system service.
 *
 * Internal storage is always SI: metres, m², m³, kilograms, radians, kelvin.
 * Display conversion happens only at the UI boundary via this module.
 *
 * Two independent axes:
 *   • LengthUnit — the length display unit (mm, cm, m, ft, ft-in)
 *   • UnitSystem — a bundle that pins every kind to a coherent family
 *
 * Most projects only need to set the UnitSystem; power users can override
 * individual kinds.
 */
import { i18n } from "./i18n";
/* ─────────────────────────────────────────────────────────────────────── */
const STORAGE_SYSTEM = "obs.units.system";
const STORAGE_CONFIG = "obs.units.config";
const SYSTEM_PRESETS = {
    "metric-mm": { length: "mm", area: "m2", volume: "m3", mass: "kg", angle: "deg", temperature: "C" },
    "metric-cm": { length: "cm", area: "m2", volume: "m3", mass: "kg", angle: "deg", temperature: "C" },
    "metric-m": { length: "m", area: "m2", volume: "m3", mass: "kg", angle: "deg", temperature: "C" },
    "imperial-in": { length: "in", area: "ft2", volume: "ft3", mass: "lb", angle: "deg", temperature: "F" },
    "imperial-ft": { length: "ft", area: "ft2", volume: "ft3", mass: "lb", angle: "deg", temperature: "F" },
};
/* ── Conversion factors to SI (metres, m², m³, kilograms, radians, kelvin) */
const LENGTH_TO_M = {
    mm: 1e-3,
    cm: 1e-2,
    m: 1,
    in: 0.0254,
    ft: 0.3048,
};
const AREA_TO_M2 = {
    mm2: 1e-6,
    cm2: 1e-4,
    m2: 1,
    ft2: 0.09290304,
    in2: 0.00064516,
};
const VOLUME_TO_M3 = {
    mm3: 1e-9,
    cm3: 1e-6,
    m3: 1,
    ft3: 0.028316846592,
    in3: 1.6387064e-5,
    l: 1e-3,
};
const MASS_TO_KG = {
    g: 1e-3,
    kg: 1,
    t: 1000,
    lb: 0.45359237,
    oz: 0.028349523125,
};
const ANGLE_TO_RAD = {
    deg: Math.PI / 180,
    rad: 1,
    grad: Math.PI / 200,
};
/* Unit suffix strings per locale. Kept here because they are not language
   strings — they are notation, and mostly identical across locales. The
   differences (e.g. "m" vs "м" in Cyrillic) are handled by the formatter. */
const LENGTH_SUFFIX = {
    mm: "mm", cm: "cm", m: "m", ft: "ft", in: "in", "ft-in": "",
};
const AREA_SUFFIX = {
    mm2: "mm²", cm2: "cm²", m2: "m²", ft2: "ft²", in2: "in²",
};
const VOLUME_SUFFIX = {
    mm3: "mm³", cm3: "cm³", m3: "m³", ft3: "ft³", in3: "in³", l: "L",
};
const MASS_SUFFIX = {
    g: "g", kg: "kg", t: "t", lb: "lb", oz: "oz",
};
const ANGLE_SUFFIX = {
    deg: "°", rad: "rad", grad: "grad",
};
const TEMP_SUFFIX = {
    C: "°C", F: "°F", K: "K",
};
class UnitsService {
    system = "metric-m";
    config = { ...SYSTEM_PRESETS["metric-m"] };
    listeners = new Set();
    booted = false;
    /* ── Lifecycle ──────────────────────────────────────────────────── */
    boot() {
        if (this.booted)
            return;
        this.booted = true;
        try {
            const sys = localStorage.getItem(STORAGE_SYSTEM);
            if (sys && sys in SYSTEM_PRESETS) {
                this.system = sys;
                this.config = { ...SYSTEM_PRESETS[sys] };
            }
            const rawCfg = localStorage.getItem(STORAGE_CONFIG);
            if (rawCfg) {
                const parsed = JSON.parse(rawCfg);
                this.config = { ...this.config, ...parsed };
            }
        }
        catch { /* */ }
    }
    getSystem() { return this.system; }
    setSystem(system) {
        if (!(system in SYSTEM_PRESETS))
            return;
        this.system = system;
        this.config = { ...SYSTEM_PRESETS[system] };
        this.persist();
        this.emit();
    }
    getConfig() { return { ...this.config }; }
    setLengthUnit(u) { this.config.length = u; this.persist(); this.emit(); }
    setAreaUnit(u) { this.config.area = u; this.persist(); this.emit(); }
    setVolumeUnit(u) { this.config.volume = u; this.persist(); this.emit(); }
    setMassUnit(u) { this.config.mass = u; this.persist(); this.emit(); }
    setAngleUnit(u) { this.config.angle = u; this.persist(); this.emit(); }
    setTemperatureUnit(u) { this.config.temperature = u; this.persist(); this.emit(); }
    onChange(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    emit() {
        for (const cb of this.listeners) {
            try {
                cb(this.config, this.system);
            }
            catch { /* */ }
        }
    }
    persist() {
        try {
            localStorage.setItem(STORAGE_SYSTEM, this.system);
            localStorage.setItem(STORAGE_CONFIG, JSON.stringify(this.config));
        }
        catch { /* */ }
    }
    /* ── Display ────────────────────────────────────────────────────── */
    formatLength(meters, opts = {}) {
        const unit = opts.unit ?? this.config.length;
        const precision = opts.precision ?? defaultLengthPrecision(unit);
        const showUnit = opts.withUnit !== false;
        if (unit === "ft-in") {
            return formatFeetInches(meters, {
                precision,
                showUnit,
                fractions: opts.fractions !== false,
                denominator: opts.fractionDenominator ?? 16,
            });
        }
        const value = meters / LENGTH_TO_M[unit];
        const num = formatNumberLocale(value, precision);
        if (!showUnit)
            return num;
        return `${num}\u2009${LENGTH_SUFFIX[unit]}`;
    }
    formatArea(m2, opts = {}) {
        const unit = opts.unit ?? this.config.area;
        const precision = opts.precision ?? 2;
        const value = m2 / AREA_TO_M2[unit];
        const num = formatNumberLocale(value, precision);
        if (opts.withUnit === false)
            return num;
        return `${num}\u2009${AREA_SUFFIX[unit]}`;
    }
    formatVolume(m3, opts = {}) {
        const unit = opts.unit ?? this.config.volume;
        const precision = opts.precision ?? 3;
        const value = m3 / VOLUME_TO_M3[unit];
        const num = formatNumberLocale(value, precision);
        if (opts.withUnit === false)
            return num;
        return `${num}\u2009${VOLUME_SUFFIX[unit]}`;
    }
    formatMass(kg, opts = {}) {
        const unit = opts.unit ?? this.config.mass;
        const precision = opts.precision ?? 2;
        const value = kg / MASS_TO_KG[unit];
        const num = formatNumberLocale(value, precision);
        if (opts.withUnit === false)
            return num;
        return `${num}\u2009${MASS_SUFFIX[unit]}`;
    }
    /** Angles stored in radians. */
    formatAngle(radians, opts = {}) {
        const unit = opts.unit ?? this.config.angle;
        const precision = opts.precision ?? 2;
        const value = radians / ANGLE_TO_RAD[unit];
        const num = formatNumberLocale(value, precision);
        if (opts.withUnit === false)
            return num;
        return `${num}\u2009${ANGLE_SUFFIX[unit]}`;
    }
    /** Temperatures stored in kelvin. */
    formatTemperature(kelvin, opts = {}) {
        const unit = opts.unit ?? this.config.temperature;
        const value = unit === "C" ? kelvin - 273.15 :
            unit === "F" ? (kelvin - 273.15) * 9 / 5 + 32 :
                kelvin;
        const precision = opts.precision ?? 1;
        const num = formatNumberLocale(value, precision);
        if (opts.withUnit === false)
            return num;
        return `${num}\u2009${TEMP_SUFFIX[unit]}`;
    }
    /* ── Parse (user input → SI) ────────────────────────────────────── */
    parseLength(input) {
        return parseDimension(input, this.config.length);
    }
    parseArea(input) {
        const r = parseDimension(input, this.config.area);
        if (r == null)
            return null;
        return r;
    }
    parseVolume(input) {
        return parseDimension(input, this.config.volume);
    }
    parseMass(input) {
        return parseDimension(input, this.config.mass);
    }
    parseAngle(input) {
        const r = parseDimension(input, this.config.angle);
        if (r == null)
            return null;
        return r;
    }
    /** BIM-style: interpret a user-typed length against the display unit,
     *  or against an explicit suffix if the user typed one.
     *  Returns metres. */
    parseLengthInput(input, fallbackUnit) {
        const cleaned = String(input ?? "").trim();
        if (!cleaned)
            return null;
        return parseLengthString(cleaned, fallbackUnit ?? this.config.length);
    }
    /* ── Unit metadata for UI ───────────────────────────────────────── */
    lengthUnits() { return ["mm", "cm", "m", "ft", "in", "ft-in"]; }
    areaUnits() { return ["mm2", "cm2", "m2", "ft2", "in2"]; }
    volumeUnits() { return ["mm3", "cm3", "m3", "ft3", "in3", "l"]; }
    massUnits() { return ["g", "kg", "t", "lb", "oz"]; }
    angleUnits() { return ["deg", "rad", "grad"]; }
    systems() {
        return ["metric-mm", "metric-cm", "metric-m", "imperial-in", "imperial-ft"];
    }
}
/* ── Formatting helpers ──────────────────────────────────────────────── */
function formatNumberLocale(value, precision) {
    if (!Number.isFinite(value))
        return "—";
    const locale = i18n.getLocale();
    try {
        return new Intl.NumberFormat(locale, {
            minimumFractionDigits: 0,
            maximumFractionDigits: precision,
            useGrouping: Math.abs(value) >= 10000,
        }).format(value);
    }
    catch {
        return value.toFixed(precision);
    }
}
function defaultLengthPrecision(unit) {
    switch (unit) {
        case "mm": return 0;
        case "cm": return 1;
        case "m": return 3;
        case "ft": return 2;
        case "in": return 1;
        case "ft-in": return 2;
    }
}
/**
 * BIM-style feet-inches. Precision is the inch fraction denominator:
 *   fractionDenominator = 16 → "5'-6 1/2""
 *   showUnit = false       → omit the trailing double-quote
 */
function formatFeetInches(meters, opts) {
    if (!Number.isFinite(meters))
        return "—";
    const negative = meters < 0;
    const totalInches = Math.abs(meters) / LENGTH_TO_M.in;
    const sign = negative ? "-" : "";
    let feet = Math.floor(totalInches / 12);
    let inches = totalInches - feet * 12;
    if (opts.fractions) {
        const denom = Math.max(2, Math.min(64, opts.denominator));
        let numerator = Math.round((inches - Math.floor(inches)) * denom);
        let whole = Math.floor(inches);
        if (numerator === denom) {
            whole += 1;
            numerator = 0;
        }
        if (whole === 12) {
            feet += 1;
            whole = 0;
        }
        let inchStr = String(whole);
        if (numerator > 0) {
            const g = gcd(numerator, denom);
            inchStr += ` ${numerator / g}/${denom / g}`;
        }
        const feetStr = `${feet}'`;
        if (opts.showUnit)
            return `${sign}${feetStr}-${inchStr}"`;
        return `${sign}${feetStr}-${inchStr}`;
    }
    const inchesRounded = Math.round(inches * 100) / 100;
    const inchStr = formatNumberLocale(inchesRounded, opts.precision);
    const feetStr = `${feet}'`;
    return opts.showUnit ? `${sign}${feetStr}-${inchStr}"` : `${sign}${feetStr}-${inchStr}`;
}
function gcd(a, b) {
    return b === 0 ? a : gcd(b, a % b);
}
/**
 * Parse a string like "12.5m", "500 mm", "5'-6\"", "3,20 m" into a
 * value in the base SI unit of the given kind.
 */
// openbim-fix: units.ts -- suffix matchers for non-length kinds
function matchAreaSuffix(s) {
    switch (s) {
        case "mm2":
        case "mm²": return "mm2";
        case "cm2":
        case "cm²": return "cm2";
        case "m2":
        case "m²": return "m2";
        case "ft2":
        case "ft²": return "ft2";
        case "in2":
        case "in²": return "in2";
        default: return null;
    }
}
function matchVolumeSuffix(s) {
    switch (s) {
        case "mm3":
        case "mm³": return "mm3";
        case "cm3":
        case "cm³": return "cm3";
        case "m3":
        case "m³": return "m3";
        case "ft3":
        case "ft³": return "ft3";
        case "in3":
        case "in³": return "in3";
        case "l":
        case "ltr": return "l";
        default: return null;
    }
}
function matchMassSuffix(s) {
    switch (s) {
        case "g": return "g";
        case "kg": return "kg";
        case "t": return "t";
        case "lb":
        case "lbs": return "lb";
        case "oz": return "oz";
        default: return null;
    }
}
function matchAngleSuffix(s) {
    switch (s) {
        case "deg":
        case "°": return "deg";
        case "rad": return "rad";
        case "grad": return "grad";
        default: return null;
    }
}
function parseDimension(input, unit) {
    const cleaned = String(input ?? "").trim();
    if (!cleaned)
        return null;
    // Feet-inches notation
    if (/^-?\d+'/i.test(cleaned)) {
        return parseFeetInches(cleaned);
    }
    // [number][optional whitespace][suffix]
    const m = cleaned.match(/^(-?[\d.,\u00A0\u202F ]+)\s*([a-zA-Z°'"²³]+)?$/);
    if (!m)
        return null;
    const numStr = m[1].replace(/\s|\u00A0|\u202F/g, "");
    const value = parseNumberLocale(numStr);
    if (value == null)
        return null;
    const suffix = (m[2] ?? "").toLowerCase();
    switch (unit) {
        case "mm":
        case "cm":
        case "m":
        case "ft":
        case "in":
        case "ft-in": {
            const explicit = suffix ? matchLengthSuffix(suffix) : null;
            const u = explicit ?? unit;
            if (u === "ft-in")
                return parseFeetInches(`${value}'`) ?? value * LENGTH_TO_M.ft;
            return value * LENGTH_TO_M[u];
        }
        case "mm2":
        case "cm2":
        case "m2":
        case "ft2":
        case "in2": {
            const u = (suffix ? matchAreaSuffix(suffix) : null) ?? unit;
            return value * AREA_TO_M2[u];
        }
        case "mm3":
        case "cm3":
        case "m3":
        case "ft3":
        case "in3":
        case "l": {
            const u = (suffix ? matchVolumeSuffix(suffix) : null) ?? unit;
            return value * VOLUME_TO_M3[u];
        }
        case "g":
        case "kg":
        case "t":
        case "lb":
        case "oz": {
            const u = (suffix ? matchMassSuffix(suffix) : null) ?? unit;
            return value * MASS_TO_KG[u];
        }
        case "deg":
        case "rad":
        case "grad": {
            const u = (suffix ? matchAngleSuffix(suffix) : null) ?? unit;
            return value * ANGLE_TO_RAD[u];
        }
        default:
            return value;
    }
}
function parseLengthString(input, fallback) {
    const suffixMatch = input.match(/([a-zA-Z°'"]+)\s*$/);
    if (suffixMatch) {
        const found = matchLengthSuffix(suffixMatch[1].toLowerCase());
        if (found) {
            const r = parseDimension(input, found);
            if (r != null)
                return r;
        }
    }
    return parseDimension(input, fallback);
}
function matchLengthSuffix(s) {
    switch (s) {
        case "mm": return "mm";
        case "cm": return "cm";
        case "m": return "m";
        case "ft":
        case "'": return "ft";
        case "in":
        case '"': return "in";
        default: return null;
    }
}
function parseFeetInches(input) {
    // e.g. 5'-6 1/2"  |  5' 6"  |  5'
    const s = input.trim().replace(/[\u2019\u02BC]/g, "'");
    const ftIn = s.match(/^(-?\d+(?:[.,]\d+)?)\s*'\s*(?:-\s*)?(.*)$/);
    if (!ftIn)
        return null;
    const feet = parseNumberLocale(ftIn[1].replace(",", "."));
    if (feet == null)
        return null;
    const rest = ftIn[2].replace(/["″]/g, "").trim();
    if (!rest)
        return feet * LENGTH_TO_M.ft;
    // Possible fraction: "6 1/2" or "6-1/2"
    const frac = rest.match(/^(\d+(?:[.,]\d+)?)(?:\s+|[-])(\d+)\s*\/\s*(\d+)$/);
    if (frac) {
        const whole = parseNumberLocale(frac[1].replace(",", ".")) ?? 0;
        const num = parseFloat(frac[2]);
        const den = parseFloat(frac[3]);
        const inches = whole + (den ? num / den : 0);
        return feet * LENGTH_TO_M.ft + inches * LENGTH_TO_M.in;
    }
    const plain = parseNumberLocale(rest.replace(",", "."));
    if (plain == null)
        return feet * LENGTH_TO_M.ft;
    return feet * LENGTH_TO_M.ft + plain * LENGTH_TO_M.in;
}
/** Locale-aware number parse: accepts "1.234,56", "1,234.56", "1 234,56". */
function parseNumberLocale(s) {
    if (!s)
        return null;
    // Heuristic: if there's a single comma with digits after, treat as decimal.
    // If both, the last one wins.
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    let normalized;
    if (lastComma === -1 && lastDot === -1)
        normalized = s;
    else if (lastComma === -1)
        normalized = s;
    else if (lastDot === -1)
        normalized = s.replace(",", ".");
    else if (lastComma > lastDot)
        normalized = s.replace(/\./g, "").replace(",", ".");
    else
        normalized = s.replace(/,/g, "");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
}
/* ── Singleton + convenience ─────────────────────────────────────────── */
export const units = new UnitsService();
/** Convenience aliases used widely by feature code. */
export const fmtLength = (m, o) => units.formatLength(m, o);
export const fmtArea = (m2, o) => units.formatArea(m2, o);
export const fmtVolume = (m3, o) => units.formatVolume(m3, o);
export const fmtMass = (kg, o) => units.formatMass(kg, o);
export const fmtAngle = (rad, o) => units.formatAngle(rad, o);
export const fmtTemp = (k, o) => units.formatTemperature(k, o);
