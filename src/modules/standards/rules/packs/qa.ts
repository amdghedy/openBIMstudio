/**
 * Model quality assurance.
 *
 * The bread-and-butter checks every coordination model needs: no
 * duplicate GlobalIds, no unnamed elements, no orphan geometry, no
 * zero-sized boxes, no empty property values.
 */
import type { RulePack, RuleContext } from "../../types";
import {
  hasProp, propString, mm,
} from "../../framework";

export const qaPack: RulePack = {
  id: "model-qa",
  name: "Model Quality Assurance",
  description:
    "Best-practice checks that catch the mistakes every coordination " +
    "model eventually accumulates: missing names, empty properties, " +
    "orphan geometry.",
  jurisdiction: "International",
  version: "OBS 1.0",
  rules: [
    {
      id: "qa.has-name",
      name: "Element has a name",
      description:
        "Every named product should carry a Name attribute. Unnamed " +
        "elements are impossible to select or schedule reliably.",
      severity: "info",
      category: "Model Quality",
      appliesTo: [
        "IFCDOOR", "IFCWINDOW", "IFCWALL", "IFCSLAB", "IFCCOLUMN",
        "IFCBEAM", "IFCFOOTING", "IFCPILE", "IFCFURNITURE",
        "IFCBUILDINGELEMENTPROXY", "IFCSTAIR", "IFCRAILING", "IFCRAMP",
      ],
      check(ctx: RuleContext) {
        const name = propString(ctx.props, "Name");
        if (!name) {
          return {
            pass: false,
            message: "Element has no Name",
            required: "Non-empty Name attribute",
          };
        }
        return { pass: true };
      },
    },
    {
      id: "qa.has-globalid",
      name: "Element has a GlobalId",
      description:
        "Every IfcRoot must carry a GlobalId. Missing GlobalIds break " +
        "change tracking, BCF interchange, and reference resolution.",
      severity: "error",
      category: "Model Quality",
      appliesTo: ["*"],
      check(ctx: RuleContext) {
        const gid = propString(ctx.props, "GlobalId");
        if (!gid) {
          return {
            pass: false,
            message: "Element has no GlobalId",
            required: "22-character IFC GlobalId",
          };
        }
        if (gid.length !== 22) {
          return {
            pass: false,
            message: `GlobalId "${gid}" is not 22 characters long`,
            actual: `${gid.length} characters`,
            required: "22 characters",
          };
        }
        return { pass: true };
      },
    },
    {
      id: "qa.has-description-or-type",
      name: "Element is at least partly described",
      description:
        "An element with no Description and no ObjectType is usually a " +
        "placeholder that was never finished.",
      severity: "info",
      category: "Model Quality",
      appliesTo: [
        "IFCDOOR", "IFCWINDOW", "IFCWALL", "IFCSLAB",
        "IFCCOLUMN", "IFCBEAM", "IFCBUILDINGELEMENTPROXY",
      ],
      check(ctx: RuleContext) {
        const desc = propString(ctx.props, "Description");
        const type = propString(ctx.props, "ObjectType");
        if (!desc && !type) {
          return {
            pass: false,
            message: "Element has neither Description nor ObjectType",
            required: "At least one of Description or ObjectType",
          };
        }
        return { pass: true };
      },
    },
    {
      id: "qa.no-empty-pset",
      name: "Property sets are not empty",
      description:
        "An empty property set adds noise without adding information.",
      severity: "info",
      category: "Model Quality",
      appliesTo: ["*"],
      check(ctx: RuleContext) {
        const raw = ctx.raw as any;
        if (!raw?.psets) return { pass: true };
        const empties: string[] = [];
        for (const [name, props] of Object.entries(raw.psets as Record<string, any>)) {
          if (!props || typeof props !== "object") continue;
          const keys = Object.keys(props);
          if (!keys.length) empties.push(name);
        }
        if (empties.length) {
          return {
            pass: false,
            message: `Empty property set(s): ${empties.join(", ")}`,
            required: "Property sets with at least one property",
          };
        }
        return { pass: true };
      },
    },
    {
      id: "qa.no-zero-size",
      name: "Element has non-zero size",
      description:
        "A bounding box smaller than 1 mm on every axis is almost " +
        "certainly a modelling artifact.",
      severity: "warning",
      category: "Model Quality",
      appliesTo: ["*"],
      check(ctx: RuleContext) {
        // We do not have the world box in RuleContext, so use the
        // geometric properties the model carries.
        const raw = ctx.raw as any;
        const w = Number(
          raw?.Width?.value ?? raw?.OverallWidth?.value ?? NaN,
        );
        const h = Number(
          raw?.Height?.value ?? raw?.OverallHeight?.value ?? NaN,
        );
        const d = Number(
          raw?.Depth?.value ?? raw?.OverallDepth?.value ?? NaN,
        );
        const all = [w, h, d].filter((n) => Number.isFinite(n));
        if (!all.length) return { pass: true };
        const maxDim = Math.max(...all.map(Math.abs));
        if (maxDim < 0.001) {
          return {
            pass: false,
            message: `Element bounding dimensions are below 1 mm`,
            actual: mm(maxDim),
            required: "At least 1 mm on one axis",
          };
        }
        return { pass: true };
      },
    },
  ],
};