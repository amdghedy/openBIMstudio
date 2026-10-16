/**
 * Locale-aware translation service.
 *
 * Design goals:
 *   - Zero dependencies — works with plain JSON catalogs
 *   - Namespaced keys via dot notation: t("clash.status.selectModels")
 *   - Plural rules via Intl.PluralRules — no ICU parser needed
 *   - Variable interpolation with {name} syntax
 *   - RTL detection and Direction state
 *   - Feature/plugin catalogs can register at runtime
 *   - Locale change fires an event so UI can re-render
 *
 * Catalog shape:
 *   {
 *     "meta": { "name": "English", "nativeName": "English", "dir": "ltr" },
 *     "clash": {
 *       "status": {
 *         "selectModels": "Select models in A and B, then Run Test.",
 *         "found": { "one": "1 clash found.", "other": "{count} clashes found." }
 *       }
 *     }
 *   }
 */
import { diagnostics } from "./diagnostics";

export type Locale =
  | "en" | "ar" | "de" | "fr" | "es" | "pt-BR" | "it"
  | "zh-CN" | "zh-TW" | "ja" | "ko"
  | "ru" | "tr" | "pl" | "nl"
  | "hi" | "he" | "fa" | "ur";

export type TextDirection = "ltr" | "rtl";

const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>([
  "ar", "he", "fa", "ur",
]);

export interface CatalogMeta {
  name: string;
  nativeName: string;
  dir: TextDirection;
}

export type CatalogLeaf = string | PluralForms;
export type PluralForms = Partial<Record<
  Intl.LDMLPluralRule | "other",
  string
>>;
export type CatalogNode = CatalogLeaf | { [key: string]: CatalogNode };

/* -------------------------------------------------------------------- */

const STORAGE_KEY = "obs.locale";
const FALLBACK_LOCALE: Locale = "en";
const MISSING_MARKER = "\u2400";

type ChangeListener = (locale: Locale) => void;

class I18nService {
  private catalogs = new Map<Locale, Catalog>();
  private current: Locale = FALLBACK_LOCALE;
  private listeners = new Set<ChangeListener>();
  private pluralRulesCache = new Map<Locale, Intl.PluralRules>();
  private missingKeys = new Set<string>();
  private booted = false;

  /* -- Registration --------------------------------------------------- */

  register(locale: Locale, catalog: Partial<Catalog>): void {
    const existing = this.catalogs.get(locale);
    if (!existing) {
      this.catalogs.set(locale, catalog as Catalog);
      return;
    }
    const merged = deepMerge(existing, catalog);
    this.catalogs.set(locale, merged as Catalog);
  }

  registerAll(bundle: Partial<Record<Locale, Partial<Catalog>>>): void {
    for (const [locale, cat] of Object.entries(bundle)) {
      if (!cat) continue;
      this.register(locale as Locale, cat);
    }
  }

  /* -- Lifecycle ------------------------------------------------------ */

  boot(): void {
    if (this.booted) return;
    this.booted = true;

    let saved: Locale | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) saved = raw as Locale;
    } catch { /* */ }

    const detected = saved ?? this.detectBrowserLocale();
    this.setLocale(detected, { silent: !saved });
  }

  private detectBrowserLocale(): Locale {
    const langs = navigator.languages?.length
      ? navigator.languages
      : [navigator.language];
    for (const l of langs) {
      const exact = l as Locale;
      if (this.catalogs.has(exact)) return exact;

      // Keep the raw string so we can compare against values that are
      // intentionally not in the Locale union (e.g. "zh").
      const baseStr = l.split("-")[0];
      const base = baseStr as Locale;
      if (this.catalogs.has(base)) return base;

      // Special case for Chinese: "zh" → "zh-CN"
      if (baseStr === "zh") return "zh-CN";
    }
    return FALLBACK_LOCALE;
  }

  getLocale(): Locale {
    return this.current;
  }

  getDirection(): TextDirection {
    const cat = this.catalogs.get(this.current);
    return cat?.meta?.dir ?? (RTL_LOCALES.has(this.current) ? "rtl" : "ltr");
  }

  isRTL(): boolean {
    return this.getDirection() === "rtl";
  }

  listLocales(): Array<{ id: Locale; meta: CatalogMeta }> {
    const out: Array<{ id: Locale; meta: CatalogMeta }> = [];
    for (const [id, cat] of this.catalogs) {
      out.push({ id, meta: cat.meta });
    }
    out.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
    return out;
  }

  setLocale(locale: Locale, opts: { silent?: boolean } = {}): void {
    if (!this.catalogs.has(locale)) {
      diagnostics.warn(
        "i18n.setLocale",
        `locale "${locale}" not registered — falling back to en`,
      );
      locale = FALLBACK_LOCALE;
    }
    if (this.current === locale && this.booted) return;
    this.current = locale;

    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch { /* */ }

    this.applyDocumentAttributes();

    if (!opts.silent) {
      for (const cb of this.listeners) {
        try {
          cb(locale);
        } catch (err) {
          diagnostics.warn("i18n.listener", "listener threw", err);
        }
      }
    }
  }

  private applyDocumentAttributes(): void {
    if (typeof document === "undefined") return;
    const dir = this.getDirection();
    document.documentElement.lang = this.current;
    document.documentElement.dir = dir;
    document.body?.setAttribute("data-locale", this.current);
    document.body?.setAttribute("data-dir", dir);
  }

  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /* -- Translation ---------------------------------------------------- */

  t(key: string, vars?: Record<string, string | number>): string {
    const value =
      this.lookup(this.current, key) ??
      this.lookup(FALLBACK_LOCALE, key);

    if (value === undefined) {
      if (!this.missingKeys.has(key)) {
        this.missingKeys.add(key);
        diagnostics.warn(
          "i18n.missing",
          `missing key "${key}" for locale "${this.current}"`,
        );
      }
      return key;
    }

    if (typeof value === "string") {
      return interpolate(value, vars);
    }

    const count = vars?.count;
    const n = typeof count === "number" ? count : Number(count ?? 0);
    const rule = this.pluralRule(this.current, n);
    const chosen =
      value[rule] ??
      value.other ??
      value.one ??
      Object.values(value)[0] ??
      key;
    return interpolate(chosen, vars);
  }

  has(key: string): boolean {
    return (
      this.lookup(this.current, key) !== undefined ||
      this.lookup(FALLBACK_LOCALE, key) !== undefined
    );
  }

  clearMissing(): void {
    this.missingKeys.clear();
  }

  listMissing(): string[] {
    return [...this.missingKeys].sort();
  }

  private pluralRule(locale: Locale, count: number): Intl.LDMLPluralRule {
    let rules = this.pluralRulesCache.get(locale);
    if (!rules) {
      try {
        rules = new Intl.PluralRules(locale);
      } catch {
        rules = new Intl.PluralRules(FALLBACK_LOCALE);
      }
      this.pluralRulesCache.set(locale, rules);
    }
    return rules.select(count);
  }

  private lookup(locale: Locale, key: string): CatalogLeaf | undefined {
    const cat = this.catalogs.get(locale);
    if (!cat) return undefined;
    const parts = key.split(".");
    let node: CatalogNode | undefined = cat as unknown as CatalogNode;
    for (const p of parts) {
      if (node === undefined || typeof node === "string") return undefined;
      if (isPluralForms(node)) return undefined;
      node = node[p];
    }
    if (node === undefined) return undefined;
    if (typeof node === "string" || isPluralForms(node)) return node;
    return undefined;
  }
}

function isPluralForms(v: unknown): v is PluralForms {
  if (!v || typeof v !== "object") return false;
  const keys = Object.keys(v);
  if (!keys.length) return false;
  return keys.every((k) =>
    ["zero", "one", "two", "few", "many", "other"].includes(k),
  );
}

function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const v = vars[name];
    if (v === undefined) return match;
    return String(v);
  });
}

function deepMerge<T extends Record<string, unknown>>(
  a: T,
  b: Partial<T>,
): T {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      prev && typeof prev === "object" && !Array.isArray(prev)
    ) {
      out[k] = deepMerge(
        prev as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/* -- Singleton + convenience exports ---------------------------------- */

export const i18n = new I18nService();

export const t = (
  key: string,
  vars?: Record<string, string | number>,
): string => i18n.t(key, vars);

export function scoped(prefix: string) {
  return (key: string, vars?: Record<string, string | number>): string =>
    i18n.t(`${prefix}.${key}`, vars);
}

export const MISSING_KEY_MARKER = MISSING_MARKER;

export interface Catalog {
  meta: CatalogMeta;
  [namespace: string]: CatalogNode | CatalogMeta;
}