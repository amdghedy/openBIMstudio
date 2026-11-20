#!/usr/bin/env node
/**
 * Regenerate src/core/i18n-catalogs/*.gen.ts from scripts/i18n-work/*.json.
 *
 * Issue #140/#141 follow-up: the checked-in machine catalogues used to cite
 * `scripts/gen-catalogs.mjs (source: scripts/i18n-work/<lang>.json)` in their
 * headers, but neither the generator nor the sources existed in the repo —
 * the catalogues were unregenerable artefacts. This script is the missing
 * generator, and scripts/i18n-work/*.json are the missing sources
 * (reverse-extracted from the previously checked-in catalogues on
 * 2026-11-20; see scripts/i18n-work/MANIFEST.json).
 *
 * Rules (all deterministic, so `node scripts/gen-catalogs.mjs --check`
 * passes in CI when the checked-in files are in sync):
 *   - Key order is first-appearance order across languages (ar first).
 *     The files are NOT sorted; re-sorting would rewrite every file.
 *   - Keys that are CSS declarations (e.g. "padding:14px 18px") are
 *     extraction noise, never UI text: they are dropped and logged.
 *   - A language missing a union key gets the English source string as its
 *     value (value == key). That is an explicit "untranslated" marker, not
 *     a translation; scripts/i18n-audit.mjs counts and reports it. This is
 *     how Hindi's 832 missing keys were closed: filled, flagged, not faked.
 *   - No translation is invented here. To add a real translation, edit the
 *     JSON source and re-run this script.
 *
 * Usage:
 *   node scripts/gen-catalogs.mjs          regenerate all catalogues
 *   node scripts/gen-catalogs.mjs --check  exit 1 if any file is out of sync
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = join(root, "scripts", "i18n-work");
const OUT = join(root, "src", "core", "i18n-catalogs");

export const GEN_LANGS = ["ar", "de", "es", "fr", "hi", "ja", "pt", "ru", "zh"];

/** CSS-declaration keys swept into the corpus by the original extractor. */
export const CSS_KEY_RE = /^(padding|margin|border|inset|gap)\s*:/;

export function loadSources() {
  const sources = new Map();
  for (const lang of GEN_LANGS) {
    const p = join(WORK, `${lang}.json`);
    if (!existsSync(p)) throw new Error(`missing catalogue source: ${p}`);
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed.entries || typeof parsed.entries !== "object") {
      throw new Error(`${p}: expected { meta, entries }`);
    }
    sources.set(lang, parsed.entries);
  }
  return sources;
}

/** Union key list in first-appearance order; CSS noise dropped (logged). */
export function unionKeys(sources) {
  const keys = [];
  const seen = new Set();
  const dropped = [];
  for (const lang of GEN_LANGS) {
    for (const k of Object.keys(sources.get(lang))) {
      if (CSS_KEY_RE.test(k)) {
        if (!seen.has(k)) dropped.push(k);
        seen.add(k);
        continue;
      }
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return { keys, dropped };
}

export function renderCatalog(lang, entries) {
  const header =
    `/**\n` +
    ` * GENERATED FILE — machine-translated UI catalog (${lang}). Do not edit by\n` +
    ` * hand; regenerate with scripts/gen-catalogs.mjs (source:\n` +
    ` * scripts/i18n-work/${lang}.json). Keyed by the exact English source string.\n` +
    ` * Loaded lazily per language by i18n-dicts.ts (ensureGenDicts).\n` +
    ` * Provenance: frozen machine-translation snapshot, reverse-extracted from\n` +
    ` * the previously checked-in catalogues on 2026-11-20; see\n` +
    ` * scripts/i18n-work/MANIFEST.json. Unreviewed — do not treat as human\n` +
    ` * translation. Missing keys are filled with the English source string\n` +
    ` * and reported by scripts/i18n-audit.mjs.\n` +
    ` */\n\n` +
    `export type Dict = Record<string, string>;\n\n` +
    `export const GEN: Dict = JSON.parse(\n` +
    `  ${JSON.stringify(JSON.stringify(entries))},\n` +
    `);\n`;
  return header;
}

/** Returns { files: Map<lang, text>, stats } without writing anything. */
export function generateAll() {
  const sources = loadSources();
  const { keys, dropped } = unionKeys(sources);
  const files = new Map();
  const stats = {};
  for (const lang of GEN_LANGS) {
    const src = sources.get(lang);
    const entries = {};
    let filled = 0;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(src, k)) {
        entries[k] = src[k];
      } else {
        entries[k] = k; // explicit untranslated marker (value == key)
        filled++;
      }
    }
    files.set(lang, renderCatalog(lang, entries));
    stats[lang] = { entries: keys.length, filled, dropped: dropped.length };
  }
  return { files, stats, dropped };
}

function main() {
  const check = process.argv.includes("--check");
  const { files, stats, dropped } = generateAll();
  let dirty = [];
  for (const [lang, text] of files) {
    const p = join(OUT, `${lang}.gen.ts`);
    if (check) {
      const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
      if (cur !== text) dirty.push(lang);
    } else {
      writeFileSync(p, text);
    }
  }
  for (const lang of GEN_LANGS) {
    const s = stats[lang];
    console.log(`${lang}.gen.ts: ${s.entries} entries, ${s.filled} filled with English (untranslated)`);
  }
  if (dropped.length) {
    console.log(`dropped CSS-fragment keys (extraction noise): ${dropped.join(" | ")}`);
  }
  if (check && dirty.length) {
    console.error(`OUT OF SYNC: ${dirty.join(", ")} — run: node scripts/gen-catalogs.mjs`);
    process.exit(1);
  }
  console.log(check ? "gen-catalogs: all catalogues in sync" : "gen-catalogs: regenerated");
}

main();
