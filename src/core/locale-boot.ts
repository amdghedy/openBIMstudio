/**
 * Locale boot sequence.
 */
import { ctx } from "./context";
import { i18n, t, type Locale, type Catalog } from "./i18n";
import { units, type UnitSystem } from "./units";
import { register, type ServiceMap } from "./services";
import { registerOption } from "./options-registry";

import en from "../locales/en.json";
import ar from "../locales/ar.json";
import de from "../locales/de.json";
import ja from "../locales/ja.json";
import zhCN from "../locales/zh-CN.json";

const FONT_STACKS: Record<string, string> = {
  default: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
  ar:      `"Noto Naskh Arabic", "Segoe UI", "Geeza Pro", system-ui, sans-serif`,
  he:      `"Noto Sans Hebrew", "Segoe UI", system-ui, sans-serif`,
  ja:      `"Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", "Meiryo", system-ui, sans-serif`,
  "zh-CN": `"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif`,
  "zh-TW": `"PingFang TC", "Microsoft JhengHei", "Noto Sans TC", system-ui, sans-serif`,
  ko:      `"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif`,
  hi:      `"Noto Sans Devanagari", "Nirmala UI", system-ui, sans-serif`,
};

function fontStackFor(locale: string): string {
  if (FONT_STACKS[locale]) return FONT_STACKS[locale];
  const base = locale.split("-")[0];
  return FONT_STACKS[base] ?? FONT_STACKS.default;
}

function applyLocaleCss(): void {
  if (typeof document === "undefined") return;
  const locale = i18n.getLocale();
  const stack = fontStackFor(locale);
  document.documentElement.style.setProperty("--font-ui", stack);
  document.documentElement.style.setProperty(
    "--font-mono",
    `ui-monospace, SFMono-Regular, "Cascadia Mono", "Noto Sans Mono", monospace`,
  );
}

function registerLocaleOptions(): void {
  registerOption({
    id: "locale.language",
    group: "Language & Region",
    label: "Language",
    description:
      "Interface language. Technical names (IFC entities, property set keys) " +
      "stay in their original form.",
    type: "select",
    default: i18n.getLocale(),
    choices: i18n.listLocales().map((l) => ({
      value: l.id,
      label: `${l.meta.nativeName}  ·  ${l.meta.name}`,
    })),
    apply: (v) => i18n.setLocale(v as Locale),
  });

  registerOption({
    id: "locale.unitSystem",
    group: "Language & Region",
    label: "Unit system",
    description:
      "Display units for all lengths, areas, volumes and masses. " +
      "Model data is always stored in SI internally.",
    type: "select",
    default: units.getSystem(),
    choices: [
      { value: "metric-mm",   label: "Metric  ·  millimetres (mm)" },
      { value: "metric-cm",   label: "Metric  ·  centimetres (cm)" },
      { value: "metric-m",    label: "Metric  ·  metres (m)" },
      { value: "imperial-in", label: "Imperial  ·  inches / feet" },
      { value: "imperial-ft", label: "Imperial  ·  feet" },
    ],
    apply: (v) => units.setSystem(v as UnitSystem),
  });

  registerOption({
    id: "locale.currency",
    group: "Language & Region",
    label: "Currency",
    description: "Used by the 5D cost panel and BOQ exports.",
    type: "select",
    default: "USD",
    choices: [
      { value: "USD", label: "USD  ·  US Dollar" },
      { value: "EUR", label: "EUR  ·  Euro" },
      { value: "GBP", label: "GBP  ·  Pound Sterling" },
      { value: "AED", label: "AED  ·  UAE Dirham" },
      { value: "SAR", label: "SAR  ·  Saudi Riyal" },
      { value: "EGP", label: "EGP  ·  Egyptian Pound" },
      { value: "CNY", label: "CNY  ·  Chinese Yuan" },
      { value: "JPY", label: "JPY  ·  Japanese Yen" },
      { value: "INR", label: "INR  ·  Indian Rupee" },
      { value: "AUD", label: "AUD  ·  Australian Dollar" },
      { value: "CAD", label: "CAD  ·  Canadian Dollar" },
    ],
    apply: (v) => {
      try { localStorage.setItem("obs.currency", String(v)); } catch { /* */ }
    },
  });
}

export interface LocaleBootResult {
  locale: string;
  dir: "ltr" | "rtl";
  unitSystem: UnitSystem;
}

let booted = false;

export function setupLocale(): LocaleBootResult {
  if (booted) {
    return {
      locale: i18n.getLocale(),
      dir: i18n.getDirection(),
      unitSystem: units.getSystem(),
    };
  }
  booted = true;

  i18n.register("en", en as Partial<Catalog>);
  i18n.register("ar", ar as Partial<Catalog>);
  i18n.register("de", de as Partial<Catalog>);
  i18n.register("ja", ja as Partial<Catalog>);
  i18n.register("zh-CN", zhCN as Partial<Catalog>);

  i18n.boot();
  units.boot();

  applyLocaleCss();

  i18n.onChange(() => {
    applyLocaleCss();
    try {
      window.dispatchEvent(new CustomEvent("obs-locale-changed", {
        detail: { locale: i18n.getLocale(), dir: i18n.getDirection() },
      }));
    } catch { /* */ }
  });

  const i18nService: ServiceMap["i18n"] = {
    t,
    setLocale: (l) => i18n.setLocale(l as Locale),
    getLocale: () => i18n.getLocale(),
    getDirection: () => i18n.getDirection(),
    isRTL: () => i18n.isRTL(),
    listLocales: () => i18n.listLocales(),
    onChange: (cb) => i18n.onChange(cb as (l: Locale) => void),
    register: (locale, catalog) =>
      i18n.register(locale as Locale, catalog as Partial<Catalog>),
    listMissing: () => i18n.listMissing(),
  };
  register("i18n", i18nService);
  ctx.features.i18n = i18nService;

  const unitsService: ServiceMap["units"] = {
    formatLength: (m, o) => units.formatLength(m, o),
    formatArea: (m2, o) => units.formatArea(m2, o),
    formatVolume: (m3, o) => units.formatVolume(m3, o),
    formatMass: (kg, o) => units.formatMass(kg, o),
    formatAngle: (rad, o) => units.formatAngle(rad, o),
    formatTemperature: (k, o) => units.formatTemperature(k, o),
    parseLengthInput: (s) => units.parseLengthInput(s),
    getSystem: () => units.getSystem(),
    setSystem: (s) => units.setSystem(s as UnitSystem),
    getConfig: () => units.getConfig(),
    onChange: (cb) => units.onChange(cb),
  };
  register("units", unitsService);
  ctx.features.units = unitsService;

  registerLocaleOptions();

  console.log(
    `[locale] booted · locale=${i18n.getLocale()} · dir=${i18n.getDirection()} ` +
    `· units=${units.getSystem()}`,
  );

  return {
    locale: i18n.getLocale(),
    dir: i18n.getDirection(),
    unitSystem: units.getSystem(),
  };
}