#!/usr/bin/env node
/**
 * i18n coverage audit (issues #140, #141; ROADMAP Phase 0 "first PR").
 *
 * Measures what the deep dive could only estimate by hand:
 *   - per-locale translation status (translated vs stub JSON only),
 *   - generated-catalogue entries / untranslated (value == key) / CSS noise,
 *     plus coverage % per language ((entries - untranslated) / entries),
 *   - ICU strings actually present in the key catalogues (counts.*),
 *   - dead JSON namespaces (no t()/scoped() call site in src/) — reported,
 *     not gated: kept deliberately until their strings migrate to keys,
 *   - drift between the three places that list "supported" locales:
 *     TRANSLATED_LOCALES (src/core/i18n.ts), LANGS (src/core/dom-translate.ts)
 *     and GEN_LANGS (scripts/gen-catalogs.mjs),
 *   - RTL locales that would flip direction while the UI stays English
 *     (must be none: untranslated RTL locales stay LTR by i18n.getDirectionFor).
 *
 * A locale is "translated" only when strings render in it — a JSON stub
 * (11 leaves: seven generic words + language name) does not count.
 *
 * Usage:
 *   node scripts/i18n-audit.mjs            human-readable report, exit 0
 *   node scripts/i18n-audit.mjs --check    exit 1 if any gate fails
 *   node scripts/i18n-audit.mjs --json <path>  also write a JSON report
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAll, GEN_LANGS, CSS_KEY_RE } from "./gen-catalogs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ICU_RE = /,\s*(plural|select)\b/;
const DOM_CODE_TO_LOCALE = { zh: "zh-CN", pt: "pt-BR" };

function leaves(node, out = []) {
  if (typeof node === "string") { out.push(node); return out; }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) leaves(v, out);
  }
  return out;
}

function loadJsonLocale(file) {
  const data = JSON.parse(readFileSync(join(root, "src", "locales", file), "utf8"));
  const all = leaves(data);
  return {
    id: file.replace(/\.json$/, ""),
    leaves: all.length,
    namespaces: Object.keys(data).filter((k) => k !== "meta"),
    dir: data.meta?.dir ?? "ltr",
    icuStrings: all.filter((s) => ICU_RE.test(s)).length,
    hasCounts: !!data.counts,
    standardsTitle: !!data.standards?.title,
  };
}

/** Parse the embedded catalogue entries out of a generated .gen.ts text. */
export function parseGenEntries(text) {
  const m = text.match(/JSON\.parse\(\s*"((?:[^"\\]|\\.)*)"\s*,?\s*\)/s);
  if (!m) throw new Error("cannot parse embedded catalogue");
  return JSON.parse(JSON.parse(`"${m[1]}"`));
}

/** Key-level diff between a checked-in catalogue and a freshly generated one. */
export function diffGenEntries(checkedIn, fresh) {
  const added = Object.keys(fresh).filter((k) => !(k in checkedIn));
  const removed = Object.keys(checkedIn).filter((k) => !(k in fresh));
  const changed = Object.keys(fresh).filter((k) => k in checkedIn && checkedIn[k] !== fresh[k]);
  return { added, removed, changed };
}

function loadGen(lang) {
  const text = readFileSync(join(root, "src", "core", "i18n-catalogs", `${lang}.gen.ts`), "utf8");
  const entries = parseGenEntries(text);
  const keys = Object.keys(entries);
  return {
    lang,
    entries: keys.length,
    untranslated: keys.filter((k) => entries[k] === k).length,
    cssKeys: keys.filter((k) => CSS_KEY_RE.test(k)),
    icuValues: keys.filter((k) => ICU_RE.test(entries[k])).length,
  };
}

/**
 * JSON namespaces that are actually read: a t()/scoped()/has() call naming
 * the namespace, or a "ns.leaf" string literal where `leaf` is a real
 * first-level key of that namespace in en.json. The leaf check matters:
 * feature/command ids such as "clash.clear" or "options.persist" share
 * the dotted shape but are not catalogue keys, so a bare dotted-string
 * scan would wrongly report those namespaces live. Block and line
 * comments are stripped first, so a doc example (i18n.ts cites
 * t("clash.status.selectModels")) does not count as a call site.
 */
function liveKeyNamespaces(enData) {
  const namespaces = Object.keys(enData).filter((k) => k !== "meta");
  const live = new Set();
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  for (const f of walk(join(root, "src")).filter((x) => x.endsWith(".ts"))) {
    let text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    text = text.split("\n").filter((l) => {
      const s = l.trim();
      return !s.startsWith("//") && !s.startsWith("*");
    }).join("\n");
    for (const m of text.matchAll(/(?:\bt|scoped|has)\(\s*["']([A-Za-z][A-Za-z0-9_]*)[."']/g)) live.add(m[1]);
    for (const m of text.matchAll(/["']([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]+)["']/g)) {
      const ns = m[1], leaf = m[2];
      if (namespaces.includes(ns) && enData[ns] && typeof enData[ns] === "object" && leaf in enData[ns]) live.add(ns);
    }
  }
  return live;
}

function setLiteral(source, name) {
  const m = source.match(new RegExp(`${name}[^=]*=\\s*new Set<Locale>\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) throw new Error(`cannot find ${name} in i18n.ts`);
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

function langsList(source) {
  // serviceLocale values in LANGS, falling back to the code itself.
  const out = [];
  const re = /\{\s*code:\s*"([^"]+)"[^}]*?serviceLocale:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(source))) out.push(m[2]);
  return out;
}

export function audit() {
  const failures = [];
  const notes = [];

  const i18nSrc = readFileSync(join(root, "src", "core", "i18n.ts"), "utf8");
  const domSrc = readFileSync(join(root, "src", "core", "dom-translate.ts"), "utf8");

  const translated = setLiteral(i18nSrc, "TRANSLATED_LOCALES");
  const domLocales = new Set(langsList(domSrc).map((l) => l));
  const genLocales = new Set(GEN_LANGS.map((l) => DOM_CODE_TO_LOCALE[l] ?? l));

  const jsonLocales = readdirSync(join(root, "src", "locales"))
    .filter((f) => f.endsWith(".json"))
    .map(loadJsonLocale);
  const byId = new Map(jsonLocales.map((l) => [l.id, l]));

  // Gate 1: the three "supported locale" lists must agree.
  const missingInDom = [...translated].filter((l) => !domLocales.has(l));
  // English is the source language and needs no generated catalogue.
  const missingInGen = [...translated].filter((l) => l !== "en" && !genLocales.has(l));
  const extraInDom = [...domLocales].filter((l) => !translated.has(l));
  if (missingInDom.length) failures.push(`TRANSLATED_LOCALES not in dom-translate LANGS: ${missingInDom.join(", ")}`);
  if (missingInGen.length) failures.push(`TRANSLATED_LOCALES without a generated catalogue: ${missingInGen.join(", ")}`);
  if (extraInDom.length) failures.push(`LANGS offers locales with no translation: ${extraInDom.join(", ")}`);

  // Gate 2: generated catalogues in sync with their JSON sources.
  // A mismatch names the stale keys instead of just saying "out of sync".
  const { files } = generateAll();
  for (const [lang, text] of files) {
    const p = join(root, "src", "core", "i18n-catalogs", `${lang}.gen.ts`);
    if (!existsSync(p) || readFileSync(p, "utf8") !== text) {
      let detail = "";
      if (existsSync(p)) {
        try {
          const d = diffGenEntries(parseGenEntries(readFileSync(p, "utf8")), parseGenEntries(text));
          const fmt = (label, arr) => arr.length
            ? `${label} ${arr.length} (${arr.slice(0, 5).join(", ")}${arr.length > 5 ? ", …" : ""})`
            : "";
          const parts = [fmt("added", d.added), fmt("removed", d.removed), fmt("changed", d.changed)].filter(Boolean);
          if (parts.length) detail = ` — stale-key diff: ${parts.join("; ")}`;
        } catch { /* unparseable checked-in file: the out-of-sync message is enough */ }
      }
      failures.push(`${lang}.gen.ts out of sync with scripts/i18n-work/${lang}.json — run: node scripts/gen-catalogs.mjs${detail}`);
    }
  }

  // Gate 3: every translated locale carries real ICU strings (counts.*).
  for (const loc of [...translated].sort()) {
    const j = byId.get(loc);
    if (!j) { failures.push(`no src/locales/${loc}.json`); continue; }
    if (!j.hasCounts || j.icuStrings === 0) {
      failures.push(`${loc}: no ICU strings in src/locales/${loc}.json (counts.* missing)`);
    }
  }

  // Gate 4: no CSS-fragment keys in any generated catalogue.
  const gens = GEN_LANGS.map(loadGen);
  for (const g of gens) {
    if (g.cssKeys.length) failures.push(`${g.lang}.gen.ts still has CSS-fragment keys: ${g.cssKeys.join(", ")}`);
  }

  // Gate 5: untranslated RTL locales must stay LTR in effect. The catalogue
  // meta.dir says rtl for he/fa/ur; the service gates direction on
  // translation (getDirectionFor). Static check that the gate exists.
  if (!/getDirectionFor\(locale[^)]*\)[\s\S]*?if \(!isTranslatedLocale\(locale\)\) return "ltr"/.test(i18nSrc)) {
    failures.push("i18n.getDirectionFor does not gate RTL on translation status (he/fa/ur would flip with an English UI)");
  }

  // Per-locale status table.
  const rows = jsonLocales.map((j) => {
    const isTr = translated.has(j.id);
    const gen = gens.find((g) => (DOM_CODE_TO_LOCALE[g.lang] ?? g.lang) === j.id);
    return {
      locale: j.id,
      status: isTr ? "translated" : "UNTRANSLATED",
      dirCatalogue: j.dir,
      dirEffective: isTr ? j.dir : "ltr (held: untranslated)",
      jsonLeaves: j.leaves,
      jsonNamespaces: j.namespaces.join(",") || "—",
      icuStrings: j.icuStrings,
      genEntries: gen ? gen.entries : 0,
      genUntranslated: gen ? gen.untranslated : 0,
      // Coverage of the generated catalogue: share of entries that are
      // actually translated (value != key). null for the English source
      // (no catalogue) and for untranslated locales (no catalogue).
      genCoverage: gen && gen.entries ? (gen.entries - gen.untranslated) / gen.entries * 100 : null,
      cssKeys: gen ? gen.cssKeys.length : 0,
      standardsTitle: j.standardsTitle,
    };
  });
  const cssKeysTotal = gens.reduce((a, g) => a + g.cssKeys.length, 0);

  // Dead-key report: JSON namespaces no call site reads. Reported, not
  // gated: the namespaces are kept deliberately until their strings
  // migrate to keys (see docs/engineering/I18N_CONSOLIDATION.md).
  const enData = JSON.parse(readFileSync(join(root, "src", "locales", "en.json"), "utf8"));
  const liveNs = liveKeyNamespaces(enData);
  const deadKeys = Object.keys(enData)
    .filter((k) => k !== "meta" && !liveNs.has(k))
    .map((k) => ({ namespace: k, leaves: leaves(enData[k]).length }));

  const untranslated = rows.filter((r) => r.status === "UNTRANSLATED").map((r) => r.locale);
  if (untranslated.length) {
    notes.push(`untranslated locales (stub JSON only, English UI, LTR held): ${untranslated.join(", ")}`);
  }
  const partial = rows.filter((r) => r.status === "translated" && r.genUntranslated > 200).map((r) => `${r.locale} (${r.genUntranslated} untranslated entries)`);
  if (partial.length) notes.push(`translated but with >200 untranslated catalogue entries: ${partial.join("; ")}`);

  return { rows, failures, notes, translated: [...translated].sort(), untranslated, deadKeys, cssKeysTotal };
}

function main() {
  const check = process.argv.includes("--check");
  const jsonIdx = process.argv.indexOf("--json");
  const { rows, failures, notes, translated, untranslated, deadKeys, cssKeysTotal } = audit();

  console.log("locale        status        dir(cat→eff)   json leaves  ICU  gen entries  gen untranslated  standards.title  coverage");
  for (const r of rows) {
    const coverage = r.locale === "en" ? "— (source)" : r.genCoverage == null ? "—" : `${r.genCoverage.toFixed(1)}%`;
    console.log(
      `${r.locale.padEnd(13)} ${r.status.padEnd(13)} ${(r.dirCatalogue + "→" + r.dirEffective.split(" ")[0]).padEnd(14)} ` +
      `${String(r.jsonLeaves).padStart(6)}      ${String(r.icuStrings).padStart(3)}  ${String(r.genEntries).padStart(6)}      ${String(r.genUntranslated).padStart(6)}           ${r.standardsTitle ? "yes" : "NO"}  ${coverage.padStart(10)}`,
    );
  }
  console.log(`\ntranslated (${translated.length}): ${translated.join(", ")}`);
  console.log(`untranslated (${untranslated.length}): ${untranslated.join(", ") || "none"}`);
  console.log(`css-fragment keys: ${cssKeysTotal} in all catalogues`);
  if (deadKeys.length) {
    console.log(`dead-key report (JSON namespaces with no call site in src/ — kept, key migration pending): ${deadKeys.map((d) => `${d.namespace} (${d.leaves} keys)`).join(", ")}`);
  }
  for (const n of notes) console.log(`note: ${n}`);
  if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) {
    writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ rows, failures, notes, deadKeys, cssKeysTotal }, null, 2) + "\n");
  }
  if (failures.length) {
    console.error(`\nAUDIT FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(check ? 1 : 0);
  }
  console.log("\ni18n-audit: OK");
  if (check) console.log("(--check: all gates passed)");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
