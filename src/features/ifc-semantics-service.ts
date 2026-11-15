/**
 * IFC semantic intelligence service (browser wiring).
 *
 * Exposes the pure ifc-semantics module through ctx.features and one
 * command-palette command: it exports the CURRENT authored model in memory,
 * re-reads the produced IFC4 with the independent STEP validator and reports
 * findings (GUID validity, duplicates, units, dangling references, orphan
 * elements, empty psets/quantities) through the toast system.
 *
 * No window globals, no decorative UI — a command that runs real checks.
 */
import { ctx } from "../core/context";
import { notify } from "../core/notify";
import { registerCommand } from "./command-palette";
import {
  buildSemanticModel,
  validateSemanticModel,
  summarizeFindings,
  inspectElement,
  findByGlobalId,
  type SemanticModel,
  type Finding,
} from "../modules/ifc-semantics/index";
import { buildModelIfc } from "../modules/bim-gaps/bim-gaps-boot";

type Any = Record<string, any>;

/** Export the authored model in memory and validate its IFC semantics. */
async function runValidationReport(): Promise<void> {
  try {
    const r = await buildModelIfc("IFC4");
    if (!r.stats.elements && !r.stats.spaces) {
      notify("warn", "Nothing to validate — the authored model is empty");
      return;
    }
    const m = buildSemanticModel(r.text);
    const findings = validateSemanticModel(m);
    const s = summarizeFindings(findings);
    const actionable = findings.filter((f) => f.severity !== "info");
    if (!actionable.length) {
      notify(
        "success",
        `IFC semantics OK — ${r.stats.elements} elements: valid GUIDs, units, spatial containment, psets, quantities (0 errors / 0 warnings)`,
      );
    } else {
      const head = actionable.slice(0, 3).map((f) => f.message).join(" · ");
      notify(
        s.errors ? "warn" : "info",
        `IFC semantics: ${s.errors} error(s), ${s.warnings} warning(s) — ${head}${actionable.length > 3 ? ` (+${actionable.length - 3} more)` : ""}`,
      );
    }
  } catch (err) {
    notify("warn", `IFC semantic validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function setupIfcSemantics(): void {
  const service = {
    /** Validate raw IFC text; returns the findings list (never throws). */
    validateText(text: string): { findings: Finding[]; summary: ReturnType<typeof summarizeFindings> } {
      const m = buildSemanticModel(text);
      const findings = validateSemanticModel(m);
      return { findings, summary: summarizeFindings(findings) };
    },
    /** Build the semantic model of raw IFC text for deeper inspection. */
    buildModel(text: string): SemanticModel {
      return buildSemanticModel(text);
    },
    /** Inspect one element by express id / GlobalId inside a semantic model. */
    inspect(m: SemanticModel, id: number) {
      return inspectElement(m, id);
    },
    findByGlobalId(m: SemanticModel, gid: string) {
      return findByGlobalId(m, gid);
    },
    /** Convenience: export + validate the current authored model. */
    validateAuthoredModel: runValidationReport,
  };
  try {
    (ctx.features as Any).ifcSemantics = service;
  } catch {
    /* ctx not ready — command still registered below */
  }

  registerCommand({
    id: "ifc.semantics.validate",
    label: "IFC: Validate semantics of the authored model",
    category: "IFC",
    hint: "Re-reads the in-memory IFC4 export with the independent STEP validator — GUIDs, units, relationships, psets, quantities, spatial structure",
    run: () => {
      void runValidationReport();
    },
  });

  console.log("[ifc-semantics] service ready — ctx.features.ifcSemantics + palette command");
}
