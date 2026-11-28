/**
 * Feet-and-inches for the 2D editor (pure, no imports — loaded standalone by tests).
 *
 *  - (formatFeetInches lives in viewer-math.ts so unit display stays import-free)
 *  - rewriteImperialInput: lets a typed command line use 12'6", 5'-6 1/2", 3.5', 10", 1/2" anywhere a number is expected;
 *    each token is replaced by its value in the drawing's own units before the command sees it.
 *
 * Honest limits: a drawing with no units cannot be converted (the user is told to set them); inches-only tokens are
 * ignored on text-bearing commands, where a quote mark is text.
 */

const METRES_PER_UNIT: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 };

/** Commands whose arguments are text: a quote mark there is text, never inches. */
const TEXTY = new Set([
  "TEXT", "DTEXT", "DT", "MTEXT", "MT", "QTEXT", "TEXTEDIT", "ED", "DDEDIT", "MLEADER", "MLD", "LAYER", "LA", "RENAME", "REN", "BLOCK", "B", "INSERT", "I",
  "ATTDEF", "ATT", "XREF", "XR", "XATTACH", "STYLE", "ST", "DIMSTYLE", "D", "DIMOVERRIDE", "TABLE", "TB", "FIND", "WBLOCK", "W", "SAVE", "SAVEAS", "QSAVE", "OPEN",
  "FIELD", "PURGE", "PU", "GROUP", "UNGROUP", "SCRIPT", "LAYOUT", "LAYERSTATE", "MTEDIT", "TOOLPALETTES",
]);

const NUM = "\\d+(?:\\.\\d+)?";
// feet with optional inches (and optional fraction): 12'  12'6"  12'-6"  12'-6 1/2"  12'-1/2"
const FEET = new RegExp(`(^|[\\s,@<(])(-?)(${NUM})'(?:-?(?:(${NUM})(?:[ -](\\d+)\\/(\\d+))?|(\\d+)\\/(\\d+))")?(?=$|[\\s,>)])`, "g");
// inches only: 10"  6 1/2"  1/2"
const INCHES = new RegExp(`(^|[\\s,@<(])(-?)(?:(${NUM})(?:[ -](\\d+)\\/(\\d+))?|(\\d+)\\/(\\d+))"(?=$|[\\s,>)])`, "g");

export interface ImperialRewrite { text: string; changed: boolean; error?: string }

function trimNum(n: number): string {
  return String(Math.round(n * 1e10) / 1e10);
}

/**
 * Replace feet/inches tokens in a command line with plain numbers in the drawing's units. Returns the original text
 * untouched when nothing matches. `units` is the drawing's unit (mm | cm | m | in | ft | unitless | undefined).
 */
export function rewriteImperialInput(line: string, units: string | undefined): ImperialRewrite {
  if (!line || (line.indexOf("'") < 0 && line.indexOf('"') < 0)) return { text: line, changed: false };
  const first = line.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (TEXTY.has(first)) return { text: line, changed: false };
  let error: string | undefined;
  const toUnits = (inches: number): string => {
    const m = units ? METRES_PER_UNIT[units] : undefined;
    if (!m) { error = "This drawing has no units, so feet and inches cannot be converted. Set the drawing units first (UNITS)."; return ""; }
    return trimNum((inches * 0.0254) / m);
  };
  const frac = (n?: string, d?: string): number => {
    if (n === undefined || d === undefined) return 0;
    const dn = Number(d);
    if (!Number.isFinite(dn) || dn === 0) { error = `Invalid fraction ${n}/${d}.`; return 0; }
    return Number(n) / dn;
  };
  let out = line.replace(FEET, (_m, pre: string, sign: string, ft: string, inch: string | undefined, n: string | undefined, d: string | undefined, fn: string | undefined, fd: string | undefined) => {
    const feet = Number(ft);
    if (!Number.isFinite(feet) || feet > 1e7) { error = "Feet value out of range."; return _m; }
    const inches = feet * 12 + (inch !== undefined ? Number(inch) + frac(n, d) : 0) + frac(fn, fd);
    return pre + (sign || "") + toUnits(inches);
  });
  out = out.replace(INCHES, (_m, pre: string, sign: string, inch: string | undefined, n: string | undefined, d: string | undefined, fn: string | undefined, fd: string | undefined) => {
    const inches = (inch !== undefined ? Number(inch) + frac(n, d) : 0) + frac(fn, fd);
    if (!Number.isFinite(inches) || inches > 1e8) { error = "Inch value out of range."; return _m; }
    return pre + (sign || "") + toUnits(inches);
  });
  if (error) return { text: line, changed: false, error };
  return { text: out, changed: out !== line };
}
