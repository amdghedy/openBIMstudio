/**
 * A small, dependency-free subset of ICU MessageFormat for the catalogs (issue #140).
 *
 * Supported:   {name}                      plain substitution
 *              {n, number}                 Intl.NumberFormat for the locale
 *              {d, date}                   Intl.DateTimeFormat (date) for the locale; accepts Date or epoch ms
 *              {n, plural, =0{…} one{…} few{…} many{…} other{…}}   CLDR categories from Intl.PluralRules; "#" = the number
 *              {g, select, male{…} other{…}}
 *              nesting of the above inside the branches; '{' '}' quoted with apostrophes ('{' ... '}' and '' for one apostrophe)
 * Not supported: selectordinal, plural offsets, argument skeletons (::), date/time styles. Unsupported syntax is returned as-is
 * rather than throwing, so a bad catalog entry shows its own text instead of breaking the UI.
 * This is NOT the intl-messageformat library: it was not added as a dependency (no package install available in this build
 * environment); the supported subset is exercised by tests/icu-lite.test.cjs.
 */
export type IcuVars = Record<string, string | number | Date>;
export type PluralSelector = (n: number) => string;

const MAX_DEPTH = 8;

/** True if the template uses ICU argument syntax that the legacy {name} interpolation cannot handle. */
export function hasIcuSyntax(t: string): boolean {
  return /\{\s*\w+\s*,\s*(plural|select|number|date)\b/.test(t) || t.includes("'{") || t.includes("''");
}

interface Ctx { vars: IcuVars; locale: string; plural: PluralSelector }

export function formatIcu(template: string, vars: IcuVars, locale: string, plural: PluralSelector): string {
  try { return render(template, { vars, locale, plural }, 0, undefined); } catch { return template; }
}

/** Split `s` at its top-level braces into text and { … } argument bodies. Handles apostrophe quoting. */
function render(s: string, c: Ctx, depth: number, hashValue: string | undefined): string {
  if (depth > MAX_DEPTH) throw new Error("too deep");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      if (s[i + 1] === "'") { out += "'"; i++; continue; }
      if (s[i + 1] === "{" || s[i + 1] === "}") { // quoted literal up to the closing apostrophe
        const end = s.indexOf("'", i + 1);
        if (end > 0) { out += s.slice(i + 1, end); i = end; continue; }
      }
      out += ch; continue;
    }
    if (ch === "#" && hashValue !== undefined) { out += hashValue; continue; }
    if (ch !== "{") { out += ch; continue; }
    const end = matching(s, i);
    if (end < 0) throw new Error("unbalanced");
    out += argument(s.slice(i + 1, end), c, depth, hashValue);
    i = end;
  }
  return out;
}

function matching(s: string, open: number): number {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "'" && (s[i + 1] === "{" || s[i + 1] === "}")) { const e = s.indexOf("'", i + 1); if (e > 0) { i = e; continue; } }
    if (s[i] === "{") d++;
    else if (s[i] === "}") { d--; if (d === 0) return i; }
  }
  return -1;
}

function argument(body: string, c: Ctx, depth: number, hash: string | undefined): string {
  const m = /^\s*(\w+)\s*(?:,\s*(\w+)\s*(?:,([\s\S]*))?)?$/.exec(body);
  if (!m) throw new Error("bad argument");
  const [, name, type, rest] = m;
  const v = c.vars[name];
  if (v === undefined) return `{${body}}`;
  if (!type) return v instanceof Date ? new Intl.DateTimeFormat(c.locale).format(v) : String(v);
  if (type === "number") return new Intl.NumberFormat(c.locale).format(Number(v));
  if (type === "date") return new Intl.DateTimeFormat(c.locale).format(v instanceof Date ? v : new Date(Number(v)));
  if (type !== "plural" && type !== "select") throw new Error("unsupported type " + type);
  const branches = parseBranches(rest ?? "");
  if (type === "select") {
    const b = branches.get(String(v)) ?? branches.get("other");
    if (b === undefined) throw new Error("select without other");
    return render(b, c, depth + 1, hash);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("plural needs a number");
  const exact = branches.get("=" + n);
  const chosen = exact ?? branches.get(c.plural(n)) ?? branches.get("other");
  if (chosen === undefined) throw new Error("plural without other");
  return render(chosen, c, depth + 1, new Intl.NumberFormat(c.locale).format(n));
}

function parseBranches(s: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/[\s{]/.test(s[j])) j++;
    const key = s.slice(i, j);
    while (j < s.length && /\s/.test(s[j])) j++;
    if (s[j] !== "{" || !key) throw new Error("bad branch");
    const end = matching(s, j);
    if (end < 0) throw new Error("unbalanced branch");
    out.set(key, s.slice(j + 1, end));
    i = end + 1;
  }
  return out;
}
