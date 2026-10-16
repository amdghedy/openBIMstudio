/**
 * Standards rule engine — type contracts.
 *
 * These types are deliberately permissive: rule packs across jurisdictions
 * return slightly different result shapes (some return a RuleCheckResult,
 * some return a Violation[] directly). The engine normalises both.
 */

/* ── Jurisdiction ───────────────────────────────────────────────────── */

/**
 * Jurisdictions are open-ended on purpose. Packs use both the ISO code
 * (`"US"`, `"GB"`) and the English name (`"United States"`, `"United Kingdom"`),
 * plus the meta-value `"intl"` / `"International"` for global rules.
 *
 * The `(string & {})` intersection keeps editor autocomplete for the
 * listed values while allowing any other code without a compile error.
 */
export type Jurisdiction =
  | "intl" | "International"
  | "US" | "us" | "United States"
  | "GB" | "gb" | "United Kingdom" | "UK"
  | "DE" | "de" | "Germany"
  | "CN" | "cn" | "China"
  | "FR" | "fr" | "France"
  | "JP" | "jp" | "Japan"
  | "AU" | "au" | "Australia"
  | "IN" | "in" | "India"
  | "CA" | "ca" | "Canada"
  | "NL" | "nl" | "Netherlands"
  | "ES" | "es" | "Spain"
  | "IT" | "it" | "Italy"
  | "BR" | "br" | "Brazil"
  | "RU" | "ru" | "Russia"
  | "ZA" | "za" | "South Africa"
  | (string & {});

export type Severity = "info" | "warning" | "error";

export type ProgressReporter = (
  done: number,
  total: number,
  note?: string,
) => void;



/* ── Violation ──────────────────────────────────────────────────────── */

export interface Violation {
  ruleId: string;
  ruleName: string;
  standard: string;
  jurisdiction?: Jurisdiction;
  severity: Severity;
  category: string;
  elementId: number;
  elementName: string;
  elementCategory: string;
  message: string;
  actual?: string;
  required?: string;
  path?: string;
}

/* ── Rule check result ──────────────────────────────────────────────── */

/**
 * A rule may return:
 *   - `{ pass: true }`                            — element is compliant
 *   - `{ pass: false, message, actual, required }` — one violation, engine wraps it
 *   - `{ pass, violations: [...] }`               — explicit violation list
 *   - `Violation[]`                               — shortcut form
 *
 * The engine normalises all four shapes.
 */
export interface RuleCheckResult {
  pass: boolean;
  message?: string;
  actual?: string;
  required?: string;
  /** Optional. When omitted the engine synthesises one from the fields above. */
  violations?: Violation[];
}

/* ── Rule context ───────────────────────────────────────────────────── */

/**
 * Everything a rule needs about the model and the current element.
 * Fields are optional because the engine populates only what the rule's
 * `appliesTo` / `requiresCategories` gate allows.
 */
export interface RuleContext {
  /** Model handle string, e.g. "model-0". */
  modelId?: string;
  /** The OBC Fragments model object. Rules cast to `any` for getItemsData. */
  model?: any;
  elementId?: number;
  elementName?: string;
  elementCategory?: string;
  /** Flat property map for the current element (Pset.Prop concatenated). */
  props?: Record<string, any>;
  /** Raw line data from the fragments worker. */
  raw?: any;
  /** IFC categories present in the model (e.g. ["IFCDOOR", "IFCWALL"]). */
  categories?: string[];
  units?: {
    length: string;
    area: string;
    volume: string;
  };
  locale?: string;
  unitSystem?: string;
  progress?: ProgressReporter;
  isCancelled?: () => boolean;
  /** All elements in the model, pre-fetched by the engine. */
  elements?: Array<{
    id: number;
    name: string;
    category: string;
    props?: Record<string, any>;
    raw: any;
  }>;
  /** Escape hatch for anything a pack needs beyond the above. */
  [key: string]: any;
}

/* ── Rule ───────────────────────────────────────────────────────────── */

export interface Rule {
  id: string;
  name: string;
  description?: string;
  /** Standard name, e.g. "IBC 2021", "BS 9999". */
  standard?: string;
  jurisdiction?: Jurisdiction;
  severity: Severity;
  /** Human-readable category, e.g. "Egress", "Fire", "Energy". */
  category?: string;
  /**
   * IFC categories this rule applies to. When omitted, the rule applies to
   * every element the engine iterates.
   */
  appliesTo?: string[];
  /**
   * Gate: only run this rule when at least one of the listed categories
   * exists in the model. Used to skip rules whose target elements are absent
   * without scanning.
   */
  requiresCategories?: (categories: string[]) => boolean;
  check(ctx: RuleContext): RuleCheckResult | Violation[] | Promise<RuleCheckResult | Violation[]>;
}

/* ── Rule pack ──────────────────────────────────────────────────────── */

export interface RulePack {
  id: string;
  name: string;
  description: string;
  jurisdiction?: Jurisdiction;
  version: string;
  rules: Rule[];
}

/* ── Run options and summary ────────────────────────────────────────── */

export interface RunOptions {
  /** Restrict to one model. Omit to run against every loaded model. */
  modelId?: string;
  /** Restrict to these packs. Omit to run every registered pack. */
  packIds?: string[];
  /** Restrict to these rules. Takes precedence over packIds when both are set. */
  ruleIds?: string[];
  /** Cooperative cancel — the engine polls `signal.cancelled` between rules. */
  signal?: { cancelled: boolean };
  /** Progress callback: called once per rule with (done, total, note). */
  onProgress?: (done: number, total: number, note?: string) => void;
}

export interface RunSummary {
  packCount: number;
  ruleCount: number;
  violations: number;
  errors: number;
  warnings: number;
  infos: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  cancelled: boolean;
}

/* Legacy aliases — do not remove. */
export type RuleViolation = Violation;
export type RuleSeverity = Severity;
export type StandardPack = RulePack;