# i18n consolidation — decision record (#140, #141)

Date: 2026-11-20 · Base: `e8e5afb` · Branch: `fix/i18n-icu-rtl`

## Decision: one system of record

**The key-based service (`src/core/i18n.ts` + `src/core/icu-lite.ts`) is the
single system of record for i18n.** It already had plural rules, ICU subset
support, RTL detection and fallback — but exactly one live call site.

**`src/core/dom-translate.ts` is a compatibility shim, not a second system.**
The shell UI is hardcoded English literals, so the DOM layer still swaps
exact-string dictionaries into the live DOM — but it now resolves through
the key service where a key exists (notably the ICU `counts.*` messages),
and its dictionaries are a frozen legacy fallback for hardcoded shell
strings until those strings migrate to keys. New code must use `t()` /
`scoped()` from `./i18n`; never add to the DOM dictionaries. Deleted in
this change: `domT()` (zero call sites) and `NUM_TEMPLATES` (replaced by
ICU counts).

**`src/core/region.ts` is canonical for number/date/currency formatting
(fmtNumber/fmtCurrency/fmtDate/fmtTime/fmtDateTime).** `src/core/format.ts`
used to export its own copies of those five names with different defaults
(non-finite → "—", grouping only for |value| ≥ 10000, short time styles),
so a caller got a different answer depending on which module it imported.
Consolidated 2026-11-21 (item 15): the duplicates are deleted and
`format.ts` keeps only the formatters `region.ts` does not have
(fmtInteger/fmtPercent/fmtRelative/fmtBytes, plus the
getCurrency/setCurrency preference), implemented on the region
primitives. The one visible change: the agent log timestamp in
`agent-bridge.ts` now uses the region `fmtTime` (medium time style)
instead of the old 2-digit format. `format.ts` and `region.ts` share one
locale source throughout: the active region profile.

**Direction ownership resolved (#141's open question).** Direction stays
owned by the i18n service. The region service exposes it as a derived
field (`ResolvedRegion.dir`, resolved for the profile's locale) so panels
that read the region profile don't need a second lookup.

## Catalogue pipeline: restored, honestly

The 9 generated catalogues cited `scripts/gen-catalogs.mjs` and
`scripts/i18n-work/<lang>.json`, neither of which existed — the catalogues
were unregenerable. Both now exist:

- `scripts/gen-catalogs.mjs` — deterministic regeneration, `--check` for CI.
- `scripts/i18n-work/<lang>.json` + `MANIFEST.json` — sources
  reverse-extracted from the checked-in catalogues at `e8e5afb`. The
  translations are **unchanged from the frozen machine-translation
  snapshot**: no translation was invented, corrected or re-translated.
  No provider/model/glossary record survives; treat every entry as
  unreviewed MT until reviewed (ROADMAP Phase 2 requires glossary +
  native-AEC review).
- Regeneration verified: zero translations changed. Only deltas are 5
  CSS-fragment keys dropped per catalogue (extractor noise, quarantined
  in the manifest) and missing keys filled with the English source string
  as an explicit untranslated marker — Hindi 833 (its 832 stale keys + 1),
  es/ja/pt/ru/zh 34 each, ar/de/fr 1 each. All catalogues now hold the
  same 3,431 keys.
- `scripts/i18n-audit.mjs` (`npm run i18n:audit`, `--check` in CI via
  `tests/i18n-audit.test.cjs`) reports per-locale status, coverage %
  per language, the dead-key report (JSON namespaces with no call site),
  and the CSS-fragment-key count — and fails CI if the three "supported
  locale" lists drift, a catalogue goes out of sync (the failure names
  the stale keys: added/removed/changed), a translated locale loses its
  ICU strings, CSS keys reappear, or the RTL gate is removed.

## Per-locale status (measured by `scripts/i18n-audit.mjs --check`)

Translated — UI renders in the language (DOM dictionary + catalogue):

| Locale | JSON leaves | ICU strings | Gen entries | Gen untranslated |
|---|---|---|---|---|
| ar | 86 | 4 | 3,431 | 73 |
| de | 82 | 4 | 3,431 | 138 |
| en | 82 | 4 | — (source) | — |
| es | 15 | 4 | 3,431 | 133 |
| fr | 15 | 4 | 3,431 | 167 |
| hi | 15 | 4 | 3,431 | 849 ⚠️ |
| ja | 82 | 4 | 3,431 | 90 |
| pt-BR | 15 | 4 | 3,431 | 151 |
| ru | 15 | 4 | 3,431 | 85 |
| zh-CN | 82 | 4 | 3,431 | 92 |

Untranslated — 11-leaf JSON stub only (seven generic words + language
name); the UI stays English. They are labelled "(untranslated — English
UI)" in the Options dropdown and excluded from the status-bar locale
cycle:

`fa, he, it, ko, nl, pl, tr, ur, zh-TW`

Note: `pl` carries the `counts.*` ICU strings (needed for #140's
en/ar/ru/pl/fr criterion, proven by `tests/icu-catalog.test.cjs`) but has
no dictionary/catalogue, so its UI is still English. ICU data ≠ translated
UI; the audit reports both separately.

## RTL (#141)

- **Untranslated RTL locales stay LTR.** `he`/`fa`/`ur` have `meta.dir`
  `rtl` in their catalogues but no translation; `i18n.getDirectionFor()`
  returns `ltr` for any untranslated locale. An RTL flip with an English
  UI (untested bidi, wrong fonts) is worse than LTR English. They flip
  automatically once dictionaries land — no code change needed then.
- **Physical-direction properties: zero in `src/**/*.ts`.** The 73
  `margin/padding/text-align/float` lines plus 34 `border-left/right`
  lines (accents, dividers, selection indicators) were converted to
  logical properties (`margin-inline-*`, `padding-inline-*`,
  `border-inline-*`, `text-align: start/end`); one physical
  `border-radius` on the file-menu accent became logical corner radii.
  `tests/rtl-css.test.cjs` now scans all of `src/**/*.ts` and fails on
  any new physical property. The two core stylesheets were already clean.
- **Icon mirroring, intentional.** The CAD ribbon already flipped the
  Redo icon (it reuses the Undo SVG via `.cadrb--flip`) — that is
  LTR-semantic, not RTL. Added `html[dir="rtl"]` rules that swap the
  undo/redo pair (undo points right, redo points left) in the ribbon and
  in Quick Access, and mirror the project-browser expand chevron `▶`→`◀`
  (▼ is symmetric under scaleX). `→` arrows inside text labels were
  deliberately not flipped — they are text content, not icons.
- **Fonts:** `fa`/`ur` now have font stacks (Naskh Arabic; Nastaliq Urdu
  falling back to Naskh). `he` already had one.
- **Region profiles:** `ae`/`sa`/`eg` resolve `dir: "rtl"`; all others
  `ltr`. An explicit `he` locale override still resolves `ltr`.
- **Currency defaults:** `he`→ILS, `fa`→IRR, `ur`→PKR added.
- **Browser detection:** `pt`/`pt-PT` now resolves to `pt-BR` (was:
  fell through to English).

## ICU / plurals (#140)

- Real ICU strings now exist in the catalogues: `counts.elements`,
  `counts.selected`, `counts.authoredSelected`, `counts.clashes` in
  `src/locales/*.json` for en, ar, de, es, fr, hi, ja, pt-BR, ru, zh-CN
  and pl. `tests/icu-catalog.test.cjs` (195 assertions) proves exact
  renderings: Arabic six forms (0/1/2/3/11/100 → zero/one/two/few/many/
  other), Russian/Polish paucal (1/2/5/21 → one/few/many/one), French
  0-is-singular, Portuguese 0-is-singular, Japanese/Chinese no plural
  distinction, and the `=0` exact branch for clashes.
- The DOM layer's count rendering (`"3 element(s)"`) now goes through
  `i18n.t("counts.*")`, so the visible UI gets real plural rules instead
  of English-shaped `"{n} elemento(s)"`.
- The `counts.*` strings are the only ICU strings in the repo; the rest
  of the UI's hardcoded strings are still exact-string DOM translations.
  Migrating the highest-traffic strings (clash status, selection,
  schedules, quantities) to keys is the next step, not this change.
- `standards.title` was missing from the four full locales (ar/de/ja/
  zh-CN), so the single live `t()` call fell back to English for them.
  Added (المعايير / Normen / 規格 / 标准) and proved by test.

## What this change does NOT do (honest remainder)

- **No live-browser RTL proof.** Static checks only (no browser was
  used). The existing Playwright RTL test (`tests/e2e/orbit-rtl.spec.ts`,
  `ar` only) is owned by the parallel §11 cross-browser workstream; it
  was deliberately not touched. `he`/`fa`/`ur` have no browser test
  because they have no translation to render. Once the §11 worker lands
  blocking browser checks, add `ar` viewport/ribbon/properties/schedules/
  tables screenshots at 1280px.
- **Canvas text is still English-only.** The 2D annotation/HUD `fillText`
  call sites are not translated by the DOM layer and never were.
- **Keyboard navigation, accessible labels, responsive panels** beyond
  what exists: `aria-label`/`title`/`placeholder` attributes are
  translated by the DOM layer, and the language switcher is keyboard
  reachable, but no dedicated RTL keyboard-navigation or panel-responsiveness
  audit was done in this workstream — it needs a browser pass.
- **Full key migration:** the JSON `app`/`clash`/`authoring`/`camera`/
  `cost`/`options` namespaces are still dead except `standards.title`
  and `counts.*`; the UI still runs on the DOM shim. Migrating shell
  strings to keys is a multi-PR effort. `scripts/i18n-audit.mjs`
  re-measures the dead set on every run (dead-key report), so a
  namespace that gains a call site drops off the list automatically.
- **No human review of the MT catalogues.** 3,431 entries per language
  are unreviewed machine translation; Hindi still has 849 untranslated
  entries (reported, not hidden). Real Hindi translations for those keys
  and a glossary + native-AEC review pass are still owed.
- **`left:`/`right:` absolute offsets in TS inline styles** were not
  converted (only margin/padding/border/text-align/float were); positioned
  overlays in the CAD viewer still use physical offsets and need a
  per-element review under RTL.
- **Number input parsing** (`1.234,56` vs `1,234.56` in property fields)
  is still locale-unaware; only output formatting is locale-aware.
