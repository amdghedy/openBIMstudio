/**
 * Structural QA rule packs.
 *
 * These are model-quality checks rather than code-compliance rules.
 * They catch the kind of mistakes that survive into a federated model:
 * beams with no section, columns with no height, structural elements
 * with no material.
 */
import type { RulePack, RuleContext } from "../../types";
import {
  hasProp, firstPropNumber, firstPropString, mm,
} from "../../framework";

export const structuralPack: RulePack = {
  id: "structural-qa",
  name: "Structural QA",
  description:
    "Non-code structural coordination checks: section presence, " +
    "sensible heights, and material assignment on load-bearing " +
    "elements.",
  jurisdiction: "International",
  version: "OBS 1.0",
  rules: [
    {
      id: "struct.beam.has-section",
      name: "Beam has a defined section",
      description:
        "Structural beams should declare a profile or section name.",
      severity: "warning",
      category: "Structural",
      appliesTo: ["IFCBEAM", "IFCBEAMSTANDARDCASE"],
      check(ctx: RuleContext) {
        const section = firstPropString(ctx.props ?? {}, [
          "ObjectType",
          "Pset_BeamCommon.Reference",
          "Reference",
          "ProfileName",
        ]);
        if (!section) {
          return {
            pass: false,
            message: "Beam has no section or profile reference",
            required: "Section name on ObjectType or Pset_BeamCommon",
          };
        }
        return { pass: true };
      },
    },
    {
      id: "struct.column.height",
      name: "Column height is plausible",
      description:
        "Columns must have a height between 0.5 m and 30 m. Values " +
        "outside that range usually mean a missing or mis-scaled " +
        "geometry.",
      severity: "warning",
      category: "Structural",
      appliesTo: ["IFCCOLUMN", "IFCCOLUMNSTANDARDCASE"],
      check(ctx: RuleContext) {
        const h = firstPropNumber(ctx.props ?? {}, [
          "Height",
          "Pset_ColumnCommon.Height",
          "OverallHeight",
        ]);
        if (h == null) {
          return { pass: true, message: "Column height not recorded" };
        }
        return {
          pass: h >= 0.5 && h <= 30,
          message:
            h < 0.5 ? `Column height ${mm(h)} is suspiciously short`
            : h > 30 ? `Column height ${h.toFixed(1)} m is suspiciously tall`
            : undefined,
          actual: h < 1 ? mm(h) : `${h.toFixed(2)} m`,
          required: "0.5 m to 30 m",
        };
      },
    },
    {
      id: "struct.beam.length",
      name: "Beam length is plausible",
      description:
        "Beams should span between 0.5 m and 50 m. Anything else is a " +
        "sign of a modelling error.",
      severity: "warning",
      category: "Structural",
      appliesTo: ["IFCBEAM", "IFCBEAMSTANDARDCASE"],
      check(ctx: RuleContext) {
        const l = firstPropNumber(ctx.props ?? {}, [
          "Length",
          "Pset_BeamCommon.Span",
          "Span",
        ]);
        if (l == null) return { pass: true, message: "Beam length not recorded" };
        return {
          pass: l >= 0.5 && l <= 50,
          message:
            l < 0.5 ? `Beam length ${mm(l)} is suspiciously short`
            : l > 50 ? `Beam length ${l.toFixed(1)} m is suspiciously long`
            : undefined,
          actual: l < 1 ? mm(l) : `${l.toFixed(2)} m`,
          required: "0.5 m to 50 m",
        };
      },
    },
    {
      id: "struct.loadbearing.material",
      name: "Load-bearing element has material",
      description:
        "Walls marked as load-bearing should declare a material.",
      severity: "info",
      category: "Structural",
      appliesTo: ["IFCWALL", "IFCWALLSTANDARDCASE"],
      check(ctx: RuleContext) {
        const props = ctx.props ?? {};
        const isLoadBearing = String(
          props["Pset_WallCommon.LoadBearing"] ??
          props["LoadBearing"] ??
          "",
        ).toLowerCase();
        if (isLoadBearing !== "true" && isLoadBearing !== "1") {
          return { pass: true };
        }
        const material = firstPropString(props, [
          "Pset_WallCommon.Material",
          "Material",
        ]);
        return {
          pass: !!material,
          message: material ? undefined : "Load-bearing wall has no material assigned",
          required: "Material on IfcWall.Pset_WallCommon",
        };
      },
    },
    {
      id: "struct.slab.thickness",
      name: "Slab thickness is plausible",
      description:
        "Slabs should be between 50 mm and 1 000 mm thick.",
      severity: "info",
      category: "Structural",
      appliesTo: ["IFCSLAB", "IFCSLABSTANDARDCASE", "IFCSLABELEMENTEDCASE"],
      check(ctx: RuleContext) {
        const t = firstPropNumber(ctx.props ?? {}, [
          "Pset_SlabCommon.Thickness",
          "Thickness",
          "OverallThickness",
        ]);
        if (t == null) return { pass: true, message: "Slab thickness not recorded" };
        return {
          pass: t >= 0.05 && t <= 1.0,
          message:
            t < 0.05 ? `Slab thickness ${mm(t)} is suspiciously thin`
            : t > 1.0 ? `Slab thickness ${mm(t)} is suspiciously thick`
            : undefined,
          actual: mm(t),
          required: "50 mm to 1 000 mm",
        };
      },
    },
  ],
};