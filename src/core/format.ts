/**
 * Locale-aware formatting for numbers, dates, currency, and file sizes.
 * Delegates unit formatting to units.ts — this module is for everything else.
 *
 * The locale for every Intl call below comes from the active REGION profile
 * (region.getResolved().locale), not from the i18n service directly: the
 * region profile is what a team sets for a country (language + units +
 * currency), and numeric/date output must respect it. Falls back to the
 * i18n service locale when the region service is not ready. The duplicate
 * thin formatters in region.ts (fmtNumber/fmtDate/…) share the same source
 * — region.getResolved().locale — so both surfaces agree.
 */
import { i18n, type Locale } from "./i18n";
import { region } from "./region";

/** Locale for Intl output: active region profile, else the i18n locale. */
function activeLocale(): Locale {
  try {
    const r = region.getResolved().locale;
    if (r) return r;
  } catch { /* region service not ready (tests, early boot) */ }
  return i18n.getLocale();
}

/* ── Numbers ─────────────────────────────────────────────────────── */

export interface NumberFormatOptions {
  /** Fixed decimal places. Omit for auto. */
  precision?: number;
  /** Force thousands separators on/off. Default: on for |value| ≥ 1000. */
  grouping?: boolean;
  /** Sign display: "auto" | "always" | "never" | "exceptZero". */
  sign?: "auto" | "always" | "never" | "exceptZero";
}

export function fmtNumber(value: number, opts: NumberFormatOptions = {}): string {
  if (!Number.isFinite(value)) return "—";
  const locale = activeLocale();
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: opts.precision ?? 3,
      useGrouping: opts.grouping ?? Math.abs(value) >= 10000,
      signDisplay: opts.sign ?? "auto",
    }).format(value);
  } catch {
    return value.toFixed(opts.precision ?? 3);
  }
}

export function fmtInteger(value: number): string {
  if (!Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(activeLocale(), {
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return Math.round(value).toString();
  }
}

export function fmtPercent(ratio: number, precision = 1): string {
  if (!Number.isFinite(ratio)) return "—";
  try {
    return new Intl.NumberFormat(activeLocale(), {
      style: "percent",
      minimumFractionDigits: 0,
      maximumFractionDigits: precision,
    }).format(ratio);
  } catch {
    return `${(ratio * 100).toFixed(precision)}%`;
  }
}

/* ── Currency ────────────────────────────────────────────────────── */

const DEFAULT_CURRENCY_KEY = "obs.currency";

export function getCurrency(): string {
  try {
    const raw = localStorage.getItem(DEFAULT_CURRENCY_KEY);
    if (raw) return raw;
  } catch { /* */ }
  // Default by locale
  const locale = activeLocale();
  switch (locale) {
    case "en": return "USD";
    case "ar": return "AED";
    case "de": case "fr": case "es": case "it": case "pt-BR": return "EUR";
    case "zh-CN": return "CNY";
    case "ja": return "JPY";
    case "ko": return "KRW";
    case "ru": return "RUB";
    case "tr": return "TRY";
    case "pl": return "PLN";
    case "nl": return "EUR";
    case "hi": return "INR";
    case "he": return "ILS";
    case "fa": return "IRR";
    case "ur": return "PKR";
    default: return "USD";
  }
}

export function setCurrency(code: string): void {
  try { localStorage.setItem(DEFAULT_CURRENCY_KEY, code); } catch { /* */ }
}

export interface CurrencyFormatOptions {
  precision?: number;
  /** Show the currency code suffix instead of the symbol. Default false. */
  showCode?: boolean;
  /** Override currency symbol. */
  currency?: string;
}

export function fmtCurrency(value: number, opts: CurrencyFormatOptions = {}): string {
  if (!Number.isFinite(value)) return "—";
  const code = opts.currency ?? getCurrency();
  const locale = activeLocale();
  try {
    const optsObj: Intl.NumberFormatOptions = {
      style: "currency",
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: opts.precision ?? 2,
    };
    if (opts.showCode) optsObj.currencyDisplay = "code";
    return new Intl.NumberFormat(locale, optsObj).format(value);
  } catch {
    return `${code} ${value.toFixed(opts.precision ?? 2)}`;
  }
}

/* ── Dates ───────────────────────────────────────────────────────── */

export type DateStyle = "short" | "medium" | "long" | "full" | "iso";

export function fmtDate(value: Date | number | string, style: DateStyle = "short"): string {
  const d = toDate(value);
  if (!d) return "—";
  if (style === "iso") return d.toISOString().slice(0, 10);
  const locale = activeLocale();
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: style }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function fmtTime(value: Date | number | string): string {
  const d = toDate(value);
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat(activeLocale(), {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(d);
  } catch {
    return d.toTimeString().slice(0, 8);
  }
}

export function fmtDateTime(value: Date | number | string): string {
  const d = toDate(value);
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat(activeLocale(), {
      dateStyle: "short",
      timeStyle: "short",
    }).format(d);
  } catch {
    return d.toISOString().replace("T", " ").slice(0, 16);
  }
}

function toDate(value: Date | number | string): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/* ── Relative time (e.g. "3 minutes ago") ────────────────────────── */

const _rtfCache = new Map<string, Intl.RelativeTimeFormat>();
const DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60,          unit: "second" },
  { amount: 60,          unit: "minute" },
  { amount: 24,          unit: "hour" },
  { amount: 7,           unit: "day" },
  { amount: 4.34524,     unit: "week" },
  { amount: 12,          unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

export function fmtRelative(value: Date | number | string): string {
  const d = toDate(value);
  if (!d) return "—";
  const locale = activeLocale();
  let rtf = _rtfCache.get(locale);
  if (!rtf) {
    try {
      rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    } catch {
      rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    }
    _rtfCache.set(locale, rtf);
  }
  let duration = (d.getTime() - Date.now()) / 1000;
  for (const div of DIVISIONS) {
    if (Math.abs(duration) < div.amount) {
      return rtf.format(Math.round(duration), div.unit);
    }
    duration /= div.amount;
  }
  return fmtDate(d);
}

/* ── File size ───────────────────────────────────────────────────── */

export function fmtBytes(bytes: number, precision = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${fmtNumber(v, { precision })} ${units[i]}`;
}