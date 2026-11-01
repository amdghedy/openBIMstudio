/**
 * DOM translation layer — makes the hardcoded-English UI multilingual.
 *
 * The i18n service (./i18n.ts) is a key-based catalog system; most shell UI
 * strings (Project Center, ribbon tabs, File menu …) predate it and are
 * plain English literals. This layer closes that gap: dictionaries keyed by
 * the exact English source string are swapped into the live DOM (text nodes
 * + placeholder/title/aria-label attributes), and a debounced
 * MutationObserver keeps re-rendered surfaces translated.
 *
 * Locale state stays in ONE place — the i18n service (`obs.locale`). This
 * module only maps service locale ⇄ dictionary code and applies the DOM.
 */
import { i18n, type Locale } from "./i18n";
import { DICTS, ensureGenDicts, hasGenDict } from "./i18n-dicts";

export interface DomLangDef {
  code: string;
  /** Native language name — shown untranslated in the switcher menu. */
  native: string;
  dir: "ltr" | "rtl";
  /** Service locale this dictionary code maps to (identity unless noted). */
  serviceLocale?: Locale;
}

/** Most spoken languages, ordered by global usage. */
export const LANGS: DomLangDef[] = [
  { code: "en", native: "English", dir: "ltr", serviceLocale: "en" },
  { code: "ar", native: "العربية", dir: "rtl", serviceLocale: "ar" },
  { code: "zh", native: "中文", dir: "ltr", serviceLocale: "zh-CN" },
  { code: "es", native: "Español", dir: "ltr", serviceLocale: "es" },
  { code: "fr", native: "Français", dir: "ltr", serviceLocale: "fr" },
  { code: "de", native: "Deutsch", dir: "ltr", serviceLocale: "de" },
  { code: "pt", native: "Português", dir: "ltr", serviceLocale: "pt-BR" },
  { code: "ru", native: "Русский", dir: "ltr", serviceLocale: "ru" },
  { code: "ja", native: "日本語", dir: "ltr", serviceLocale: "ja" },
  { code: "hi", native: "हिन्दी", dir: "ltr", serviceLocale: "hi" },
];

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "CODE", "PRE", "TEXTAREA", "KBD",
]);
const TRANSLATABLE_ATTRS = ["placeholder", "title", "aria-label"] as const;

let current = "en";
let dict: Record<string, string> | null = null;
let observer: MutationObserver | null = null;

const originalText = new WeakMap<Text, string>();
const originalAttrs = new WeakMap<Element, Map<string, string>>();

export function getDomLang(): string {
  return current;
}

export function langDef(code: string): DomLangDef {
  return LANGS.find((l) => l.code === code) ?? LANGS[0];
}

/** Inline helper for new code — English fallback. */
export function domT(s: string): string {
  if (current === "en" || !dict) return s;
  return dict[s] ?? s;
}

function skipSubtree(el: Element | null): boolean {
  return !!el && (!!el.closest("[data-i18n-skip]") || SKIP_TAGS.has(el.tagName));
}

function translateTextNode(node: Text): void {
  const parent = node.parentElement;
  if (!parent || skipSubtree(parent)) return;
  const raw = node.nodeValue ?? "";
  const trimmed = raw.trim();
  if (!trimmed) return;

  // The recorded English original is the lookup base — the node may
  // currently display a DIFFERENT language (e.g. switching ar → zh).
  const orig = originalText.get(node);
  if (current === "en" || !dict) {
    if (orig !== undefined) node.nodeValue = orig;
    return;
  }
  const baseRaw = orig ?? raw;
  const baseTrimmed = baseRaw.trim();
  if (!baseTrimmed) return;
  const tr = dict[baseTrimmed];
  if (!tr || tr === baseTrimmed) return;
  const lead = baseRaw.slice(0, baseRaw.length - baseRaw.trimStart().length);
  const trail = baseRaw.slice(baseRaw.trimEnd().length);
  if (orig === undefined) originalText.set(node, raw);
  node.nodeValue = lead + tr + trail;
}

function translateElementAttrs(el: Element): void {
  if (skipSubtree(el)) return;
  for (const attr of TRANSLATABLE_ATTRS) {
    const val = el.getAttribute(attr);
    if (!val) continue;
    const rec = originalAttrs.get(el);
    if (current === "en" || !dict) {
      const orig = rec?.get(attr);
      if (orig !== undefined) el.setAttribute(attr, orig);
      continue;
    }
    // Lookup from the recorded English original — the attribute may hold
    // another language's translation right now.
    const base = rec?.get(attr) ?? val;
    const baseTrimmed = base.trim();
    if (!baseTrimmed) continue;
    const tr = dict[baseTrimmed];
    if (!tr || tr === baseTrimmed) continue;
    let store = rec;
    if (!store) { store = new Map(); originalAttrs.set(el, store); }
    if (!store.has(attr)) store.set(attr, val);
    el.setAttribute(attr, tr);
  }
}

/** Translate (or restore) every known string under `root`. */
export function translateRoot(root: ParentNode): void {
  if (root instanceof Element && skipSubtree(root)) return;
  // Guard: never let our own writes re-enter the observer.
  const obs = observer;
  observer = null;
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      translateTextNode(n as Text);
    }
    const els = root instanceof Element
      ? [root as Element, ...Array.from(root.querySelectorAll("*"))]
      : Array.from(root.querySelectorAll("*"));
    for (const el of els) translateElementAttrs(el);
  } catch { /* live DOM moved under us — next pass catches up */ }
  observer = obs;
}

/** Switch the DOM dictionary for `code` and re-translate the document. */
export function setDomLang(code: string): void {
  const def = langDef(code);
  current = def.code;
  dict = def.code === "en" ? null : DICTS[def.code] ?? null;
  translateRoot(document.body);
  // Machine catalog not merged yet? Fetch it, then re-apply this language.
  if (def.code !== "en" && !hasGenDict(def.code)) {
    void ensureGenDicts(def.code).then(() => {
      if (current === def.code) setDomLang(def.code);
    });
  }
}

/** Service locale → dictionary code ("zh-CN" → "zh", "pt-BR" → "pt"). */
export function domLangFromLocale(locale: string): string {
  const byLocale = LANGS.find((l) => (l.serviceLocale ?? l.code) === locale);
  if (byLocale) return byLocale.code;
  const base = locale.split("-")[0];
  return LANGS.some((l) => l.code === base) ? base : "en";
}

/** The dictionary code matching the current service locale. */
export function currentDomLang(): string {
  return domLangFromLocale(i18n.getLocale());
}

/** Register the switcher languages that have no catalog yet (meta-only). */
export function registerSwitcherLocales(): void {
  const registrations: Array<[Locale, string, "ltr" | "rtl"]> = [
    ["es", "Spanish", "ltr"],
    ["fr", "French", "ltr"],
    ["pt-BR", "Portuguese (BR)", "ltr"],
    ["ru", "Russian", "ltr"],
    ["hi", "Hindi", "ltr"],
  ];
  const known = new Set(i18n.listLocales().map((l) => l.id));
  for (const [id, name, dir] of registrations) {
    if (known.has(id)) continue;
    i18n.register(id, { meta: { name, nativeName: langDef(domLangFromLocale(id)).native, dir } });
  }
}

/** Debounced, targeted re-translation of whatever the app re-renders. */
function startObserver(): void {
  if (observer) return;
  const pending = new Set<ParentNode>();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const roots = Array.from(pending);
    pending.clear();
    for (const root of roots) {
      if (root instanceof Element && !root.isConnected) continue;
      translateRoot(root);
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  };
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "childList") {
        for (const n of r.addedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE) pending.add(n as Element);
          else if (n.nodeType === Node.TEXT_NODE && n.parentElement) pending.add(n.parentElement);
        }
        if (!r.addedNodes.length && r.target) pending.add(r.target as ParentNode);
      } else if (r.target) {
        const host = r.target.nodeType === Node.TEXT_NODE
          ? (r.target as Text).parentElement
          : r.target as Element;
        if (host) pending.add(host);
      }
    }
    schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

/**
 * Boot: register missing service locales, follow the service locale
 * (which persists in `obs.locale`), start the observer. Changing the
 * language anywhere — this button or the Options panel — re-translates
 * the whole site via the `obs-locale-changed` event.
 */
export function setupDomTranslate(): void {
  registerSwitcherLocales();
  startObserver();
  setDomLang(currentDomLang());
  window.addEventListener("obs-locale-changed", () => {
    setDomLang(currentDomLang());
    refreshLanguageButtons();
  });
}

function refreshLanguageButtons(): void {
  try { window.dispatchEvent(new CustomEvent("obs-dom-lang-changed")); } catch { /* */ }
}
