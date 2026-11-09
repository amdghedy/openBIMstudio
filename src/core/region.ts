/**
 * Region / locale-profile service — the "international platform" backbone.
 *
 * A *region profile* bundles everything a project team in one country needs:
 *   • UI language (drives i18n)
 *   • Unit system          (drives units.ts)
 *   • Currency             (drives 5D cost + BOQ exports)
 *   • Default standards packs (drives the standards rule registry)
 *   • Paper size & date format (drives sheets, plots and schedule display)
 *
 * Storage model mirrors units.ts: a chosen `profileId` plus per-field
 * overrides persisted separately, so picking "United Arab Emirates" and then
 * manually switching to A4 still works and survives reload.
 *
 * The module is dependency-light (only ./units types) and safe to import in
 * tests and Node-based tooling.
 */
import { i18n, type Locale } from "./i18n";
import type { UnitSystem } from "./units";

export type PaperSize = "A0" | "A1" | "A2" | "A3" | "A4" | "ANSI-D" | "ARCH-E1";

export interface RegionProfile {
  id: string;
  /** Display name in English (used in settings UI). */
  name: string;
  /** Localized display name, shown next to the English one. */
  nativeName: string;
  locale: Locale;
  unitSystem: UnitSystem;
  currency: string;
  /** Rule-pack ids preferred in this region (see modules/standards). */
  standardsPacks: string[];
  paper: PaperSize;
  /** CLDR-style date skeleton used for schedules / revision clouds. */
  dateFormat: "iso" | "dmy" | "mdy" | "ymd";
}

/* ── Built-in profiles ─────────────────────────────────────────────────── */

export const REGION_PROFILES: readonly RegionProfile[] = [
  {
    id: "intl", name: "International", nativeName: "International",
    locale: "en", unitSystem: "metric-m", currency: "USD",
    standardsPacks: ["qa-intl", "structural-intl"], paper: "A1", dateFormat: "iso",
  },
  {
    id: "ae", name: "United Arab Emirates", nativeName: "الإمارات العربية المتحدة",
    locale: "ar", unitSystem: "metric-mm", currency: "AED",
    standardsPacks: ["fire-egress-intl-gcc", "accessibility-intl-gcc"], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "sa", name: "Saudi Arabia", nativeName: "المملكة العربية السعودية",
    locale: "ar", unitSystem: "metric-mm", currency: "SAR",
    standardsPacks: ["fire-egress-intl-gcc", "accessibility-intl-gcc"], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "eg", name: "Egypt", nativeName: "مصر",
    locale: "ar", unitSystem: "metric-cm", currency: "EGP",
    standardsPacks: ["fire-egress-intl-gcc", "accessibility-intl-gcc"], paper: "A2", dateFormat: "dmy",
  },
  {
    id: "us", name: "United States", nativeName: "United States",
    locale: "en", unitSystem: "imperial-ft", currency: "USD",
    standardsPacks: ["fire-egress-us", "accessibility-us"], paper: "ANSI-D", dateFormat: "mdy",
  },
  {
    id: "gb", name: "United Kingdom", nativeName: "United Kingdom",
    locale: "en", unitSystem: "metric-mm", currency: "GBP",
    standardsPacks: ["fire-egress-uk", "accessibility-uk"], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "de", name: "Germany", nativeName: "Deutschland",
    locale: "de", unitSystem: "metric-mm", currency: "EUR",
    standardsPacks: ["fire-egress-de", "accessibility-de"], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "fr", name: "France", nativeName: "France",
    locale: "fr", unitSystem: "metric-cm", currency: "EUR",
    standardsPacks: ["accessibility-fr"], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "es", name: "Spain", nativeName: "España",
    locale: "es", unitSystem: "metric-cm", currency: "EUR",
    standardsPacks: [], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "it", name: "Italy", nativeName: "Italia",
    locale: "it", unitSystem: "metric-cm", currency: "EUR",
    standardsPacks: [], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "br", name: "Brazil", nativeName: "Brasil",
    locale: "pt-BR", unitSystem: "metric-m", currency: "BRL",
    standardsPacks: [], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "cn", name: "China", nativeName: "中国",
    locale: "zh-CN", unitSystem: "metric-mm", currency: "CNY",
    standardsPacks: ["fire-egress-cn", "accessibility-cn"], paper: "A1", dateFormat: "ymd",
  },
  {
    id: "jp", name: "Japan", nativeName: "日本",
    locale: "ja", unitSystem: "metric-mm", currency: "JPY",
    standardsPacks: ["accessibility-jp"], paper: "A3", dateFormat: "ymd",
  },
  {
    id: "kr", name: "South Korea", nativeName: "대한민국",
    locale: "ko", unitSystem: "metric-mm", currency: "KRW",
    standardsPacks: ["accessibility-kr"], paper: "A1", dateFormat: "ymd",
  },
  {
    id: "in", name: "India", nativeName: "भारत",
    locale: "hi", unitSystem: "metric-mm", currency: "INR",
    standardsPacks: ["accessibility-in"], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "au", name: "Australia", nativeName: "Australia",
    locale: "en", unitSystem: "metric-mm", currency: "AUD",
    standardsPacks: ["fire-egress-au", "accessibility-au"], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "ca", name: "Canada", nativeName: "Canada / Canada",
    locale: "en", unitSystem: "metric-mm", currency: "CAD",
    standardsPacks: ["fire-egress-ca", "accessibility-ca"], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "nl", name: "Netherlands", nativeName: "Nederland",
    locale: "nl", unitSystem: "metric-mm", currency: "EUR",
    standardsPacks: [], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "ru", name: "Russia", nativeName: "Россия",
    locale: "ru", unitSystem: "metric-mm", currency: "RUB",
    standardsPacks: ["accessibility-ru"], paper: "A1", dateFormat: "dmy",
  },
  {
    id: "za", name: "South Africa", nativeName: "South Africa",
    locale: "en", unitSystem: "metric-mm", currency: "ZAR",
    standardsPacks: ["fire-egress-za"], paper: "A1", dateFormat: "dmy",
  },
];

const PROFILE_BY_ID = new Map(REGION_PROFILES.map((p) => [p.id, p]));

/* ── Currency catalogue (extends the old hard-coded list) ──────────────── */

export const CURRENCIES: ReadonlyArray<{ code: string; symbol: string; name: string }> = [
  { code: "USD", symbol: "$",  name: "US Dollar" },
  { code: "EUR", symbol: "€",  name: "Euro" },
  { code: "GBP", symbol: "£",  name: "Pound Sterling" },
  { code: "AED", symbol: "د.إ", name: "UAE Dirham" },
  { code: "SAR", symbol: "﷼", name: "Saudi Riyal" },
  { code: "EGP", symbol: "E£", name: "Egyptian Pound" },
  { code: "CNY", symbol: "¥",  name: "Chinese Yuan" },
  { code: "JPY", symbol: "¥",  name: "Japanese Yen" },
  { code: "KRW", symbol: "₩",  name: "South Korean Won" },
  { code: "INR", symbol: "₹",  name: "Indian Rupee" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar" },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar" },
  { code: "BRL", symbol: "R$", name: "Brazilian Real" },
  { code: "RUB", symbol: "₽",  name: "Russian Ruble" },
  { code: "ZAR", symbol: "R",  name: "South African Rand" },
  { code: "TRY", symbol: "₺",  name: "Turkish Lira" },
  { code: "PLN", symbol: "zł", name: "Polish Zloty" },
];

/* ── Service ───────────────────────────────────────────────────────────── */

const STORAGE_PROFILE = "obs.region.profile";
const STORAGE_OVERRIDES = "obs.region.overrides";

export interface RegionOverrides {
  locale?: Locale;
  unitSystem?: UnitSystem;
  currency?: string;
  paper?: PaperSize;
  dateFormat?: RegionProfile["dateFormat"];
}

type ChangeListener = (resolved: ResolvedRegion, profileId: string) => void;

export interface ResolvedRegion extends RegionProfile {
  /** True when at least one field was manually overridden. */
  customized: boolean;
}

class RegionService {
  private profileId = "intl";
  private overrides: RegionOverrides = {};
  private listeners = new Set<ChangeListener>();
  private booted = false;

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    try {
      const saved = localStorage.getItem(STORAGE_PROFILE);
      if (saved && PROFILE_BY_ID.has(saved)) this.profileId = saved;
      const raw = localStorage.getItem(STORAGE_OVERRIDES);
      if (raw) this.overrides = JSON.parse(raw) as RegionOverrides;
    } catch { /* private mode etc. */ }
  }

  getProfileId(): string { return this.profileId; }

  getProfile(): RegionProfile {
    return PROFILE_BY_ID.get(this.profileId) ?? PROFILE_BY_ID.get("intl")!;
  }

  getResolved(): ResolvedRegion {
    const base = this.getProfile();
    const o = this.overrides;
    const resolved: ResolvedRegion = {
      ...base,
      locale: o.locale ?? base.locale,
      unitSystem: o.unitSystem ?? base.unitSystem,
      currency: o.currency ?? base.currency,
      paper: o.paper ?? base.paper,
      dateFormat: o.dateFormat ?? base.dateFormat,
      customized: Object.keys(o).length > 0,
    };
    return resolved;
  }

  /** Select a whole region profile; clears manual overrides. */
  setProfile(id: string): boolean {
    const p = PROFILE_BY_ID.get(id);
    if (!p) return false;
    this.profileId = id;
    this.overrides = {};
    this.persist();
    this.emit();
    return true;
  }

  setOverride(patch: RegionOverrides): void {
    this.overrides = { ...this.overrides, ...patch };
    this.persist();
    this.emit();
  }

  clearOverrides(): void {
    this.overrides = {};
    this.persist();
    this.emit();
  }

  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  listProfiles(): RegionProfile[] {
    return [...REGION_PROFILES].sort((a, b) => a.name.localeCompare(b.name));
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_PROFILE, this.profileId);
      localStorage.setItem(STORAGE_OVERRIDES, JSON.stringify(this.overrides));
    } catch { /* */ }
  }

  private emit(): void {
    const r = this.getResolved();
    for (const cb of this.listeners) {
      try { cb(r, this.profileId); } catch { /* listener isolation */ }
    }
  }
}

export const region = new RegionService();

/**
 * Detect a best-match profile from browser languages. Falls back to "intl".
 */
export function detectRegionProfile(browserLanguages: readonly string[]): string {
  for (const lang of browserLanguages) {
    const base = lang.split("-")[0].toLowerCase();
    const exact = PROFILE_BY_ID.get(base);
    if (exact) return exact.id;
  }
  return "intl";
}

/**
 * Format a monetary amount using Intl with the active region currency.
 * Kept here so cost panels / BOQ exports share one implementation.
 */
export function fmtCurrency(value: number, opts: { decimals?: number } = {}): string {
  const r = region.getResolved();
  try {
    return new Intl.NumberFormat(r.locale, {
      style: "currency",
      currency: r.currency,
      minimumFractionDigits: opts.decimals ?? (r.currency === "JPY" || r.currency === "KRW" ? 0 : 2),
      maximumFractionDigits: opts.decimals ?? 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${r.currency}`;
  }
}

/* Region-aware number / date formatting (issue #140): one place, so output follows the active region profile
   instead of whatever the browser happens to be set to. Falls back to the default locale if the profile's is invalid. */
function regionLocale(): string | undefined {
  try { return region.getResolved().locale; } catch { return undefined; }
}
export function fmtNumber(value: number, opts: Intl.NumberFormatOptions = {}): string {
  const n = Number.isFinite(value) ? value : 0;
  try { return new Intl.NumberFormat(regionLocale(), opts).format(n); } catch { return new Intl.NumberFormat(undefined, opts).format(n); }
}
const dt = (v: Date | number | string, o: Intl.DateTimeFormatOptions): string => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  try { return new Intl.DateTimeFormat(regionLocale(), o).format(d); } catch { return new Intl.DateTimeFormat(undefined, o).format(d); }
};
export const fmtDate = (v: Date | number | string = Date.now()): string => dt(v, { dateStyle: "short" });
export const fmtTime = (v: Date | number | string = Date.now()): string => dt(v, { timeStyle: "medium" });
export const fmtDateTime = (v: Date | number | string = Date.now()): string => dt(v, { dateStyle: "short", timeStyle: "medium" });

/** Register the region-aware formatting hooks on the i18n singleton side. */
export function applyRegionToServices(setLocale: (l: Locale) => void): void {
  const r = region.getResolved();
  setLocale(r.locale);
  void i18n; // (units/currency consumers subscribe via region.onChange)
}
