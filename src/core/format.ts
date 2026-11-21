/**
 * Extra locale-aware formatters built on the canonical region formatters.
 *
 * Canonical home of fmtNumber / fmtCurrency / fmtDate / fmtTime /
 * fmtDateTime is ./region.ts (consolidation 2026-11-21, issue #140):
 * the region service owns the active locale, ~20 call sites use its
 * functions, and tests/region-format.test.cjs pins their semantics
 * (Intl passthrough, NaN -> 0, invalid date -> ""). This module used to
 * export its own copies of those five names with different defaults
 * (non-finite -> "—", grouping only for |value| >= 10000, short time
 * styles), so a caller got a different answer depending on which module
 * it imported. The duplicates are deleted; what remains here are the
 * formatters region.ts does not have — fmtInteger, fmtPercent,
 * fmtRelative, fmtBytes — implemented on region.ts primitives, plus the
 * currency preference (getCurrency/setCurrency, a localStorage override
 * on top of the region profile's currency).
 *
 * The locale for every Intl call below comes from the active REGION
 * profile (region.getResolved().locale) via the region formatters, not
 * from the i18n service directly: the region profile is what a team sets
 * for a country (language + units + currency), and numeric/date output
 * must respect it. fmtRelative and getCurrency keep a direct i18n-locale
 * fallback for the not-yet-booted window (region.getResolved() never
 * throws after construction, so this is defensive only).
 */
import { i18n, type Locale } from "./i18n";
import { region, fmtNumber as regionFmtNumber, fmtDate as regionFmtDate } from "./region";

/** Locale for Intl output: active region profile, else the i18n locale. */
function activeLocale(): Locale {
  try {
    const r = region.getResolved().locale;
    if (r) return r;
  } catch { /* region service not ready (tests, early boot) */ }
  return i18n.getLocale();
}

/* ── Numbers ─────────────────────────────────────────────────────── */

export function fmtInteger(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return regionFmtNumber(value, { maximumFractionDigits: 0 });
}

export function fmtPercent(ratio: number, precision = 1): string {
  if (!Number.isFinite(ratio)) return "—";
  return regionFmtNumber(ratio, {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: precision,
  });
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
  return regionFmtDate(d);
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

/* ── File size ───────────────────────────────────────────────────── */

export function fmtBytes(bytes: number, precision = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  // Same rendering the deleted format.ts fmtNumber gave this call:
  // minimum 0 / maximum `precision` fraction digits, no grouping
  // (the scaled value is always < 1024).
  return `${regionFmtNumber(v, { minimumFractionDigits: 0, maximumFractionDigits: precision, useGrouping: false })} ${units[i]}`;
}
