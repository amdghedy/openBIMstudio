/**
 * Native BIM Validation Framework (P2) — rules + severities (Revit warnings parity)
 */
export type ValidationSeverity = "info" | "warning" | "error";

export interface ValidationIssue {
  id: string;
  code: string;
  severity: ValidationSeverity;
  message: string;
  elementIds: string[];
  parameterPath?: string;
  autoFixable: boolean;
}

export interface ValidationRule {
  id: string;
  code: string;
  name: string;
  severity: ValidationSeverity;
  run: (elements: Array<{ id: string; data: Record<string, unknown>; category: string }>) => ValidationIssue[];
}

export interface IValidationService {
  registerRule(rule: ValidationRule): void;
  runAll(): ValidationIssue[];
  run(codes: string[]): ValidationIssue[];
  setElementsProvider(
    fn: () => Array<{ id: string; data: Record<string, unknown>; category: string }>
  ): void;
  getLastIssues(): ValidationIssue[];
}

let _instance: ValidationService | null = null;

export class ValidationService implements IValidationService {
  private rules = new Map<string, ValidationRule>();
  private last: ValidationIssue[] = [];
  private provider: (() => Array<{ id: string; data: Record<string, unknown>; category: string }>) | null =
    null;

  constructor() {
    this.registerDefaultRules();
  }

  setElementsProvider(
    fn: () => Array<{ id: string; data: Record<string, unknown>; category: string }>
  ): void {
    this.provider = fn;
  }

  registerRule(rule: ValidationRule): void {
    this.rules.set(rule.code, rule);
  }

  runAll(): ValidationIssue[] {
    return this.run([...this.rules.keys()]);
  }

  run(codes: string[]): ValidationIssue[] {
    const elements = this.provider?.() ?? [];
    const issues: ValidationIssue[] = [];
    for (const code of codes) {
      const rule = this.rules.get(code);
      if (!rule) continue;
      try {
        issues.push(...rule.run(elements));
      } catch (e) {
        issues.push({
          id: `val_err_${code}`,
          code: "RULE_CRASH",
          severity: "error",
          message: `Rule ${code} failed: ${e instanceof Error ? e.message : String(e)}`,
          elementIds: [],
          autoFixable: false,
        });
      }
    }
    this.last = issues;
    return issues;
  }

  getLastIssues(): ValidationIssue[] {
    return this.last;
  }

  private registerDefaultRules(): void {
    this.registerRule({
      id: "unique-id",
      code: "UNIQUE_ID",
      name: "Unique element ids",
      severity: "error",
      run: (els) => {
        const seen = new Map<string, string>();
        const out: ValidationIssue[] = [];
        for (const e of els) {
          const prev = seen.get(e.id);
          if (prev) {
            out.push({
              id: `dup_${e.id}`,
              code: "UNIQUE_ID",
              severity: "error",
              message: `Duplicate element id ${e.id}`,
              elementIds: [prev, e.id],
              autoFixable: false,
            });
          } else seen.set(e.id, e.id);
        }
        return out;
      },
    });

    this.registerRule({
      id: "positive-dims",
      code: "POSITIVE_DIM",
      name: "Positive dimensions",
      severity: "warning",
      run: (els) => {
        const out: ValidationIssue[] = [];
        for (const e of els) {
          for (const key of ["width", "height", "length", "thickness"]) {
            const v = e.data[key];
            if (typeof v === "number" && v <= 0) {
              out.push({
                id: `dim_${e.id}_${key}`,
                code: "POSITIVE_DIM",
                severity: "warning",
                message: `${key} must be positive (got ${v})`,
                elementIds: [e.id],
                parameterPath: key,
                autoFixable: false,
              });
            }
          }
        }
        return out;
      },
    });

    this.registerRule({
      id: "host-ref",
      code: "HOST_REF",
      name: "Hosted element has host",
      severity: "warning",
      run: (els) => {
        const out: ValidationIssue[] = [];
        for (const e of els) {
          if (!/door|window/i.test(e.category)) continue;
          const host = e.data["hostId"] ?? e.data["host"];
          if (!host) {
            out.push({
              id: `host_${e.id}`,
              code: "HOST_REF",
              severity: "warning",
              message: `Hosted ${e.category} missing host reference`,
              elementIds: [e.id],
              autoFixable: false,
            });
          }
        }
        return out;
      },
    });
  }
}

export function getValidationService(): ValidationService {
  if (!_instance) _instance = new ValidationService();
  return _instance;
}

export type { IValidationService, ValidationIssue, ValidationRule, ValidationSeverity };
