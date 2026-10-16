/**
 * Small helpers that make rule authors' lives easier.
 *
 * Every `prop*` helper returns undefined when the key is missing, so rules
 * can express "missing or wrong" without nesting null checks.
 */

/** Read a value from the flattened context props. */
export function getProp(
  props: Record<string, any> | undefined,
  key: string,
): unknown {
  if (!props) return undefined;
  if (key in props) return props[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(props)) {
    if (k.toLowerCase() === lower) return props[k];
  }
  return undefined;
}

export function propString(
  props: Record<string, any> | undefined,
  key: string,
): string | undefined {
  const v = getProp(props, key);
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

export function propNumber(
  props: Record<string, any> | undefined,
  key: string,
): number | undefined {
  const v = getProp(props, key);
  if (v == null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return undefined;
  // Strip unit suffixes like "900", "900mm", "0.9 m".
  const m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*(mm|cm|m|ft|in|°|deg)?$/i);
  if (!m) return undefined;
  let n = Number(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? "").toLowerCase();
  // Convert everything to metres for length-like properties.
  if (unit === "mm") n /= 1000;
  else if (unit === "cm") n /= 100;
  else if (unit === "ft") n *= 0.3048;
  else if (unit === "in") n *= 0.0254;
  return n;
}

/** True if the property exists and is non-empty. */
export function hasProp(
  props: Record<string, any> | undefined,
  key: string,
): boolean {
  const v = getProp(props, key);
  return v != null && String(v).trim() !== "";
}

/** Return the first property that exists among a list of candidates. */
export function firstProp(
  props: Record<string, any> | undefined,
  keys: string[],
): unknown {
  for (const k of keys) {
    const v = getProp(props, k);
    if (v != null && String(v).trim() !== "") return v;
  }
  return undefined;
}

export function firstPropString(
  props: Record<string, any> | undefined,
  keys: string[],
): string | undefined {
  const v = firstProp(props, keys);
  if (v == null) return undefined;
  return String(v).trim() || undefined;
}

export function firstPropNumber(
  props: Record<string, any> | undefined,
  keys: string[],
): number | undefined {
  for (const k of keys) {
    const n = propNumber(props, k);
    if (n != null) return n;
  }
  return undefined;
}

/** Case-insensitive substring test on any property. */
export function anyPropContains(
  props: Record<string, any> | undefined,
  keys: string[],
  needle: string,
): boolean {
  const n = needle.toLowerCase();
  for (const k of keys) {
    const s = firstPropString(props, [k]);
    if (s && s.toLowerCase().includes(n)) return true;
  }
  return false;
}

/** Category matcher supporting a trailing '*' wildcard. */
export function categoryMatches(
  category: string,
  patterns: string[],
): boolean {
  const c = category.toUpperCase();
  for (const p of patterns) {
    const up = p.toUpperCase();
    if (up.endsWith("*")) {
      if (c.startsWith(up.slice(0, -1))) return true;
    } else if (c === up) {
      return true;
    }
  }
  return false;
}

/** Format a metre value for display in the "actual" / "required" columns. */
export function mm(meters: number): string {
  return `${Math.round(meters * 1000)} mm`;
}

export function m(meters: number): string {
  return `${meters.toFixed(2)} m`;
}

/** Package name and version helper for violations. */
export function packHeader(pack: {
  name: string;
  jurisdiction: string;
  version: string;
}): string {
  return `${pack.name} · ${pack.jurisdiction} · ${pack.version}`;
}