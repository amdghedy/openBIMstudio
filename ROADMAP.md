# OpenBIMStudio — Internationalization & Platform Maturity Roadmap

**Project:** [github.com/amdghedy/openBIMstudio](https://github.com/amdghedy/openBIMstudio) · v0.74.0 · MIT · local-first browser BIM workspace
**Goal:** evolve the existing functions/tools into a truly **international platform** — multi-language, multi-region, multi-standard, multi-deployment.

> Audit basis (verified against the repo): 138 feature modules under `src/modules`, i18n boot in `src/main.ts` (`setupLocale`, `setupDomTranslate`, `registerSwitcherLocales`), catalogs in `src/core/i18n-catalogs/*.gen.ts` (ar, de, es, fr, hi, ja, pt, ru, zh), JSON locales in `src/locales` (en, ar, de, ja, zh-CN only), unit handling in `src/core/format.ts` + `src/core/locale-boot.ts`, server in `server/` (Node, SSE, rate-limit, uploads), Cloudflare/Vercel deploy targets (`wrangler.jsonc`, `vercel.json`), CI: `deploy.yml`, `golden-roundtrip.yml`, `native-bim-validation.yml`, `unit-tests.yml`, bridge tool `tools/navisworks-bridge`.

---

## 🎯 Vision & Pillars

| Pillar | Outcome |
|---|---|
| **P1 — Language** | Every UI surface, help content and document output available in ≥12 languages with RTL support |
| **P2 — Regional/Units** | Locale-aware units, formats, paper sizes, standards packs (ISO/EN, AS, DIN, GB, JIS, BS, NBCS…) |
| **P3 — Collaboration at scale** | Multi-user, cross-border project sharing with role/language-aware BCF & CDE |
| **P4 — Global distribution** | CDN edge hosting, desktop builds, self-hosted server for markets needing data residency |
| **P5 — Community & compliance** | Translated docs, contributor program, WCAG accessibility, GDPR/local privacy alignment |

---

## Phase 0 — Foundations & Inventory (Weeks 1–2)

**Objective:** make i18n measurable before scaling it.

- [ ] **String extraction audit**: scan `src/**` for hardcoded UI strings (menus, tooltips, ribbons, dialogs, `docs/` links); produce `scripts/i18n-audit.mjs` reporting coverage % per module; wire into CI as a non-blocking report.
- [ ] **Single translation key registry**: consolidate `src/locales/*.json` (5 langs) and `src/core/i18n-catalogs/*.gen.ts` (9 langs) into one pipeline so no language is missing a catalog half (today `es/pt/ru/hi` have `.gen.ts` but no `locales/*.json`).
- [ ] **Translation memory format**: adopt standard XLIFF 2.0 / gettext PO files exported from JSON → enables Crowdin/Weblate/POEditor import.
- [ ] **Pseudo-localization mode**: `?locale=xx-PS` build flag that stretches/accents strings to reveal un-localized spots (incl. canvas-dimension text, sheet title blocks).
- [ ] **Definition of Done update** in `CONTRIBUTING.md`: no new user-facing string without a key.

**Exit criteria:** coverage dashboard ≥90% for en; every visible string keyed; XLIFF export works.

---

## Phase 1 — Core i18n Engine Hardening (Weeks 2–6)

**Objective:** robust runtime localization across DOM, React/MUI, canvas, and Web Workers.

- [ ] **ICU MessageFormat everywhere**: plural/gender/select rules (`{count, plural, one {…} other {…}}`) for clash counts, schedule rows, quantities.
- [ ] **Intl API integration**: `Intl.NumberFormat`, `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat`, `Intl.ListFormat` behind `src/core/format.ts`; number-grouping and decimal-separator aware input parsing (e.g., `1.234,56` vs `1,234.56`) in all property fields.
- [ ] **MUI locale provider matrix**: map all shipped languages to `@mui/material` `LocalizationProvider` adapters.
- [ ] **Canvas/DOM-overlay translation**: ensure `dom-translate` covers ribbon tooltips, command line, context menus, model-tree labels, HUD; add localized fallback fonts (CJK, Devanagari, Arabic) for 2D annotations rendered in sheets/PDF.
- [ ] **Worker i18n**: pass active locale into `worker/index.ts` (clash engine messages) and error surfaces from `web-ifc` parsing.
- [ ] **Dynamic language switch** without reload (currently boot-time `setupLocale()`); persist choice in project file + user prefs; respect `navigator.languages` on first run.
- [ ] **RTL polish**: full logical-property CSS pass (`inset-inline`, `margin-inline`), mirrored icons/arrows, bidi-safe string concatenation, tested with `ar` + `he` (add Hebrew).

**Exit criteria:** zero mixed-language sessions; RTL screenshot tests green in Playwright (`playwright.config.ts` exists).

---

## Phase 2 — Language Expansion (Weeks 6–12)

**Objective:** go from 9→14+ high-quality languages.

- [ ] **Target languages (AEC market-weighted):** en, zh-CN/zh-TW, es, fr, de, pt-BR, ar, ja, ko, ru, **it, nl, tr, he, hi(+ta)** — AEC demand in EU, MENA, LATAM, APAC.
- [ ] **Crowdsourced translation platform**: onboard to **Weblate or Crowdin**; label GitHub issues `help wanted / translation`; auto-sync via GitHub Actions.
- [ ] **Domain glossary**: bilingual BIM term base (IFC entity names, "clash", "workset", "schedule", "host/void") reviewed by native AEC professionals; publish as `docs/GLOSSARY.md` + machine-readable `glossary.json` enforced by the translation pipeline (terminology lint).
- [ ] **Translated help & docs**: `docs/*.md` and in-app Feature Status panels generated from source markdown with per-language overrides; README language badges linking localized landing pages.
- [ ] **Quality gates**: back-translation spot checks, `% translated / % fuzzy` metrics per language in CI; block release if any flagship language <95%.

**Exit criteria:** 14 languages ≥95% coverage; glossary lint in CI.

---

## Phase 3 — Units, Formats & Regional Standards (Weeks 8–16, overlaps P2)

**Objective:** "internationally usable" beyond language — regional construction conventions.

- [ ] **Unit system per project + per view**: extend `src/core/format.ts`/options registry — Metric (mm/cm/m), Imperial (ft-in fractional, inches), US survey feet; angle units (deg/rad/grad), area (m²/ft²/hectare/acre), volume, temperature, force/load units for structural modules.
- [ ] **Regional formatting presets**: date (DD/MM/YYYY vs MM/DD/YYYY vs YYYY-MM-DD), currency for 5D cost module (`src/modules/cost`), thousands separators, decimal commas in schedules/CSV/XLSX exports.
- [ ] **Paper size & title-block library**: ISO A-series, ANSI D/Larch, Arch E1/E2, JIS B, plus localized title blocks (language + standard) in `src/modules/sheets`; drawing scale fraction notation per region (1:100 vs 1/8"=1'-0").
- [ ] **Standards packs architecture**: pluggable pack (building on `src/modules/standards`) shipping rule sets + templates: **ISO 16739/IFC, EN, DIN 276 (cost), BS 1192/ISO 19650 (naming & CDE), NBCS, GB/T 51235 (China), Singapore/BCA hints**; IDS templates per region (`src/modules/validation`).
- [ ] **Naming-convention enforcement**: ISO 19650 field-based filenames/levels/types configurable per region; validation surfaced in Model Checker.
- [ ] **Local symbol sets**: rebar symbols (ASTM vs BS vs GB), hatch patterns per region, seismic/wind load defaults per country code in `src/modules/structural-loads-ui`.
- [ ] **Input method friendliness**: IME-safe text entry in external BIM authoring software-style command line (CJK), numeric keypad decimal variants.

**Exit criteria:** a project created in Riyadh (mm, A-series, Arabic, DD/MM) and one in Dallas (ft-in, ANSI, fractional scales) both export correct PDF/BCF/CSV without manual tweaks. Golden-file round-trip tests extended per locale (`golden-roundtrip.yml`).

---

## Phase 4 — International Collaboration Layer (Weeks 14–22)

**Objective:** cross-border team workflows on top of Yjs CRDT collaboration.

- [ ] **Language-aware BCF** (`src/modules/bcf`): issue body + comments stored with `lang` tag; built-in "translate comment" action (BYO provider, opt-in like AI assistant); BCF XML keeps original text (open-standard safe).
- [ ] **Multi-tenant CDE hardening** (`src/modules/cde`, `server/`): project workspaces with invited roles (Architect/Coordinator/Reviewer), per-project data residency region selection (EU/US/APAC buckets), signed upload URLs, audit log.
- [ ] **Presence & review**: localized usernames/roles in avatars, time-zone-aware meeting/schedule-4d timelines (`src/modules/timeline`, `schedule-4d`).
- [ ] **Federated clash reports** shared as read-only links with viewer language negotiation (`Accept-Language` served by `server/index.mjs` / edge function `api/visits.ts`).
- [ ] **Offline-first sync guarantees** across regions: conflict-free merges verified with latency-simulation tests (Yjs already present; add geo-latency test harness).

**Exit criteria:** 3-user session across 3 locales completes a clash→BCF→resolve→re-export cycle end-to-end.

---

## Phase 5 — Global Distribution & Deployment (Weeks 18–26)

**Objective:** fast, compliant access in every region.

- [ ] **Edge delivery**: keep Vercel/Cloudflare Pages (`vercel.json`, `wrangler.jsonc`); add static asset CDN invalidation strategy per locale bundle; lazy-load locale catalogs (code-split per language, ~small initial payload for web-ifc/WASM-heavy app).
- [ ] **Desktop international builds**: Electron/Tauri packaging (builds on `INSTALL-DESKTOP.md`, `start-mac-linux.sh`/`start-windows.bat`) with OS-locale auto-detection and offline bundled translations + WASM assets.
- [ ] **Self-hosted enterprise image**: Dockerfile for `server/` + static client (GDPR/CCPA/data-sovereignty markets, gov/AEC firms banning SaaS); documented reverse-proxy CSP config (align with `docs/CSP.md`).
- [ ] **Localized marketing/demo site**: hreflang tags, `/ar/`, `/zh/` paths, RTL landing pages, live demo link per region.
- [ ] **Per-region telemetry opt-in** (`api/visits.ts`): aggregate usage by locale to prioritize future translations; strictly privacy-compliant (no IP storage, cookieless).

**Exit criteria:** LCP < 2.5 s in São Paulo, Dubai, Singapore; desktop installers in 14 languages; docker-compose self-host path passes smoke tests.

---

## Phase 6 — Compliance, Accessibility & Governance (Weeks 22–30)

- [ ] **WCAG 2.2 AA i18n aspects**: `lang` attribute propagation, screen-reader labels translated, focus order in RTL, contrast of localized fonts, reduced-motion respected; automated axe scans in Playwright per locale.
- [ ] **Privacy posture**: update `SECURITY.md` + add DPIA notes; region-specific consent banners (EU/UK cookie rules); data-export/deletion endpoints in `server/`.
- [ ] **Open-standards conformance certification**: IFC View-FM/IDS, BCF 2.1 round-trip validated against Solibri/Navisworks/BIMcollab via `tools/navisworks-bridge` expanded to a general interop test kit (partners in multiple countries).
- [ ] **Translation governance**: CODEOWNERS for `src/locales/**` per language maintainer; published style guide; annual terminology review.
- [ ] **Versioned release train**: semver + changelog automation (`CHANGELOG.md` discipline already strong); localized release notes.

---

## 🗓️ Timeline Summary

```
Weeks  1─ 2  P0  Audit, key registry, XLIFF, pseudo-loc
Weeks  2─ 6  P1  ICU + Intl + RTL + worker/react i18n engine
Weeks  6─12  P2  14 languages via Weblate/Crowdin + glossary + docs
Weeks  8─16  P3  Units/formats/paper/standards packs (ISO 19650, DIN, GB…)
Weeks 14─22  P4  Cross-border collab: BCF lang tags, CDE residency, TZ
Weeks 18─26  P5  Edge CDN, desktop builds, Docker self-host, localized site
Weeks 22─30  P6  WCAG/privacy/interop certification & governance
```

## 📊 KPIs

| KPI | Baseline (v0.74.0) | Target (v1.0) |
|---|---|---|
| UI languages ≥95% complete | ~9 partial / 5 full | 14 |
| Hardcoded-string coverage | unknown | audited, >98% keyed |
| Unit systems | metric/imperial basic | mm/cm/m/ft-in/survey + angles/area/currency |
| Regional standards packs | generic IDS | ≥6 (ISO/EN/DIN/BS/GB/JIS/NBCS) |
| CI locale matrix tests | none | golden-roundtrip × 5 locales |
| Accessibility (axe, per locale) | not measured | 0 critical errors |
| TTFB/LCP outside US/EU | not measured | <2.5 s LCP |

## ⚠️ Top Risks & Mitigations

1. **Terminology drift across 14 languages** → enforced glossary lint + native AEC reviewer council.
2. **RTL regressions in canvas overlays** → dedicated Playwright RTL suite before merging any UI PR.
3. **Bundle size with WASM + 14 locales** → per-locale lazy chunks, CI budget check.
4. **Data-residency complexity** → ship single-region Docker first, then multi-bucket CDE.
5. **Community translation quality** → two-stage review (machine pre-check → human approve) in Weblate workflow.

---

*Prepared 2026-11-03 from a live audit of the repository. Recommended first PR: `scripts/i18n-audit.mjs` + unified locale pipeline (Phase 0), since it makes all later phases measurable.*
