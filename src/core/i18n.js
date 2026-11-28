/**
 * Locale-aware translation service — the SINGLE system of record for i18n
 * (issues #140, #141; consolidation 2026-11-20).
 *
 * Before this change there were two half-finished systems: this key-based
 * service (plural rules, ICU subset, RTL detection) with exactly one live
 * call site, and a DOM-rewriting layer (./dom-translate.ts) keyed by exact
 * English strings, which is what the UI actually used. The DOM layer is
 * now a compatibility SHIM over this service, not a second system: it
 * resolves through this service where a key exists (notably the ICU
 * `counts.*` messages) and keeps its exact-string dictionaries only as the
 * legacy fallback for hardcoded shell strings until those strings are
 * migrated to keys. New code must use t()/scoped() — never add to the
 * DOM dictionaries. See docs/engineering/I18N_CONSOLIDATION.md.
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
 *
 * Translation status: only the locales in TRANSLATED_LOCALES have a DOM
 * dictionary + generated catalogue, i.e. a UI that actually renders in
 * that language. The other registered locales have an 11-leaf JSON stub
 * (seven generic words + language name) and NO translation. They are NOT
 * offered in the Options language list (locale-boot.ts filters to
 * translated locales only): listing one advertised a language the UI
 * does not speak — worst case he/fa/ur, an RTL flip around an English
 * UI. They return to the list when a dictionary + catalogue land for
 * them. listLocales() still reports them with translated: false so other
 * surfaces can state the status honestly, and they do NOT flip the
 * layout to RTL: an RTL flip with an English UI is worse than
 * LTR English, and bidi hazards in an untranslated RTL shell were never
 * tested. A locale becomes translated only when a dictionary + catalogue
 * land for it (see scripts/i18n-audit.mjs).
 */
import { diagnostics } from "./diagnostics";
import { formatIcu, hasIcuSyntax } from "./icu-lite";
const RTL_LOCALES = new Set([
    "ar", "he", "fa", "ur",
]);
/**
 * Locales whose UI genuinely renders translated: a DOM dictionary in
 * i18n-dicts.ts AND a generated catalogue in i18n-catalogs/*.gen.ts.
 * Every other registered locale is an 11-leaf JSON stub — the UI stays
 * English. Keep this list in sync with LANGS in dom-translate.ts and
 * GEN_LANGS in scripts/gen-catalogs.mjs; scripts/i18n-audit.mjs fails
 * CI if they drift apart.
 */
export const TRANSLATED_LOCALES = new Set([
    "en", "ar", "de", "es", "fr", "hi", "ja", "pt-BR", "ru", "zh-CN",
]);
/** True when the UI renders translated strings in this locale. */
export function isTranslatedLocale(locale) {
    return TRANSLATED_LOCALES.has(locale);
}
/* -------------------------------------------------------------------- */
const STORAGE_KEY = "obs.locale";
const FALLBACK_LOCALE = "en";
const MISSING_MARKER = "\u2400";
class I18nService {
    catalogs = new Map();
    current = FALLBACK_LOCALE;
    listeners = new Set();
    pluralRulesCache = new Map();
    missingKeys = new Set();
    booted = false;
    /* -- Registration --------------------------------------------------- */
    register(locale, catalog) {
        const existing = this.catalogs.get(locale);
        if (!existing) {
            this.catalogs.set(locale, catalog);
            return;
        }
        const merged = deepMerge(existing, catalog);
        this.catalogs.set(locale, merged);
    }
    registerAll(bundle) {
        for (const [locale, cat] of Object.entries(bundle)) {
            if (!cat)
                continue;
            this.register(locale, cat);
        }
    }
    /* -- Lifecycle ------------------------------------------------------ */
    boot() {
        if (this.booted)
            return;
        this.booted = true;
        let saved = null;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw)
                saved = raw;
        }
        catch { /* */ }
        const detected = saved ?? this.detectBrowserLocale();
        this.setLocale(detected, { silent: !saved });
    }
    detectBrowserLocale() {
        const langs = navigator.languages?.length
            ? navigator.languages
            : [navigator.language];
        for (const l of langs) {
            const exact = l;
            if (this.catalogs.has(exact))
                return exact;
            // Keep the raw string so we can compare against values that are
            // intentionally not in the Locale union (e.g. "zh").
            const baseStr = l.split("-")[0];
            const base = baseStr;
            if (this.catalogs.has(base))
                return base;
            // Special case for Chinese: "zh" → "zh-CN"
            if (baseStr === "zh")
                return "zh-CN";
            // Special case for Portuguese: "pt" (incl. pt-PT) → "pt-BR".
            // The catalogues carry pt-BR only; without this a pt-PT browser
            // fell through to English instead of Portuguese.
            if (baseStr === "pt")
                return "pt-BR";
        }
        return FALLBACK_LOCALE;
    }
    getLocale() {
        return this.current;
    }
    /** Translation status of a locale ("translated" = UI renders in it). */
    translationStatus(locale) {
        return isTranslatedLocale(locale) ? "translated" : "untranslated";
    }
    /**
     * Direction for a locale. An RTL locale flips to RTL only when it is
     * actually translated: he/fa/ur have meta.dir "rtl" but no translation,
     * and an RTL layout with an English UI (untested bidi, wrong fonts) is
     * worse than LTR English. They stay LTR until dictionaries land.
     */
    getDirectionFor(locale) {
        if (!isTranslatedLocale(locale))
            return "ltr";
        const cat = this.catalogs.get(locale);
        return cat?.meta?.dir ?? (RTL_LOCALES.has(locale) ? "rtl" : "ltr");
    }
    getDirection() {
        return this.getDirectionFor(this.current);
    }
    isRTL() {
        return this.getDirection() === "rtl";
    }
    listLocales() {
        const out = [];
        for (const [id, cat] of this.catalogs) {
            out.push({ id, meta: cat.meta, translated: isTranslatedLocale(id) });
        }
        out.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
        return out;
    }
    setLocale(locale, opts = {}) {
        if (!this.catalogs.has(locale)) {
            diagnostics.warn("i18n.setLocale", `locale "${locale}" not registered — falling back to en`);
            locale = FALLBACK_LOCALE;
        }
        if (this.current === locale && this.booted) {
            // Item 16: still apply the document attributes. A fresh boot in the
            // default locale (current already "en") took this return and left
            // dir/lang/data-dir unset — the browser defaulted to ltr, but the
            // "direction follows the locale" invariant was only true by luck.
            this.applyDocumentAttributes();
            return;
        }
        this.current = locale;
        try {
            localStorage.setItem(STORAGE_KEY, locale);
        }
        catch { /* */ }
        this.applyDocumentAttributes();
        if (!opts.silent) {
            for (const cb of this.listeners) {
                try {
                    cb(locale);
                }
                catch (err) {
                    diagnostics.warn("i18n.listener", "listener threw", err);
                }
            }
        }
    }
    applyDocumentAttributes() {
        if (typeof document === "undefined")
            return;
        const dir = this.getDirection();
        document.documentElement.lang = this.current;
        document.documentElement.dir = dir;
        document.body?.setAttribute("data-locale", this.current);
        document.body?.setAttribute("data-dir", dir);
    }
    onChange(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    /* -- Translation ---------------------------------------------------- */
    t(key, vars) {
        const value = this.lookup(this.current, key) ??
            this.lookup(FALLBACK_LOCALE, key);
        if (value === undefined) {
            if (!this.missingKeys.has(key)) {
                this.missingKeys.add(key);
                diagnostics.warn("i18n.missing", `missing key "${key}" for locale "${this.current}"`);
            }
            return key;
        }
        if (typeof value === "string") {
            // ICU subset ({n, plural, one {…} other {…}}, select, number, date) when present; plain strings keep the old path.
            if (hasIcuSyntax(value)) {
                return formatIcu(value, (vars ?? {}), this.current, (n) => this.pluralRule(this.current, n));
            }
            return interpolate(value, vars);
        }
        const count = vars?.count;
        const n = typeof count === "number" ? count : Number(count ?? 0);
        const rule = this.pluralRule(this.current, n);
        const chosen = value[rule] ??
            value.other ??
            value.one ??
            Object.values(value)[0] ??
            key;
        return interpolate(chosen, vars);
    }
    has(key) {
        return (this.lookup(this.current, key) !== undefined ||
            this.lookup(FALLBACK_LOCALE, key) !== undefined);
    }
    clearMissing() {
        this.missingKeys.clear();
    }
    listMissing() {
        return [...this.missingKeys].sort();
    }
    pluralRule(locale, count) {
        let rules = this.pluralRulesCache.get(locale);
        if (!rules) {
            try {
                rules = new Intl.PluralRules(locale);
            }
            catch {
                rules = new Intl.PluralRules(FALLBACK_LOCALE);
            }
            this.pluralRulesCache.set(locale, rules);
        }
        return rules.select(count);
    }
    lookup(locale, key) {
        const cat = this.catalogs.get(locale);
        if (!cat)
            return undefined;
        const parts = key.split(".");
        let node = cat;
        for (const p of parts) {
            if (node === undefined || typeof node === "string")
                return undefined;
            if (isPluralForms(node))
                return undefined;
            node = node[p];
        }
        if (node === undefined)
            return undefined;
        if (typeof node === "string" || isPluralForms(node))
            return node;
        return undefined;
    }
}
function isPluralForms(v) {
    if (!v || typeof v !== "object")
        return false;
    const keys = Object.keys(v);
    if (!keys.length)
        return false;
    return keys.every((k) => ["zero", "one", "two", "few", "many", "other"].includes(k));
}
function interpolate(template, vars) {
    if (!vars)
        return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => {
        const v = vars[name];
        if (v === undefined)
            return match;
        return String(v);
    });
}
function deepMerge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
        const prev = out[k];
        if (v && typeof v === "object" && !Array.isArray(v) &&
            prev && typeof prev === "object" && !Array.isArray(prev)) {
            out[k] = deepMerge(prev, v);
        }
        else {
            out[k] = v;
        }
    }
    return out;
}
/* -- Singleton + convenience exports ---------------------------------- */
export const i18n = new I18nService();
export const t = (key, vars) => i18n.t(key, vars);
export function scoped(prefix) {
    return (key, vars) => i18n.t(`${prefix}.${key}`, vars);
}
export const MISSING_KEY_MARKER = MISSING_MARKER;
