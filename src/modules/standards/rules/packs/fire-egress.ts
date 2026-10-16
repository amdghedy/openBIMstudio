/**
 * Fire & egress rule packs.
 *
 * Rule severity is deliberately soft. A missing property produces an
 * "info" or "warning" rather than an "error", because a coordination model
 * frequently omits psets that the discipline-specific authoring tool
 * carries. Only clear physical violations (a door narrower than the code
 * minimum) produce "error".
 */
import type { Rule, RulePack, RuleContext, RuleCheckResult } from "../../types";
import {
  propNumber, firstPropNumber, anyPropContains, hasProp, mm,
} from "../../framework";

/* ── Rule factories ────────────────────────────────────────────────────── */

function doorMinWidth(
  id: string,
  name: string,
  minMeters: number,
  jurisdiction: string,
): Rule {
  return {
    id,
    name,
    description:
      `Egress doors must have a clear opening width of at least ` +
      `${mm(minMeters)}.`,
    severity: "error",
    category: "Fire & Egress",
    appliesTo: ["IFCDOOR", "IFCDOORSTANDARDCASE"],
    check(ctx): RuleCheckResult {
      const w = firstPropNumber(ctx.props ?? {}, [
        "OverallWidth",
        "Width",
        "Pset_DoorCommon.Width",
        "Pset_DoorCommon.ClearWidth",
      ]);
      if (w == null) {
        return {
          pass: true,
          message: `Door width not recorded — ${jurisdiction} rule skipped`,
        };
      }
      return {
        pass: w >= minMeters - 1e-4,
        message:
          w >= minMeters - 1e-4
            ? undefined
            : `Clear width ${mm(w)} is below ${jurisdiction} minimum`,
        actual: mm(w),
        required: `${mm(minMeters)} minimum`,
      };
    },
  };
}

function doorMinHeight(
  id: string,
  name: string,
  minMeters: number,
  jurisdiction: string,
): Rule {
  return {
    id,
    name,
    description:
      `Egress doors must have a clear opening height of at least ` +
      `${mm(minMeters)}.`,
    severity: "error",
    category: "Fire & Egress",
    appliesTo: ["IFCDOOR", "IFCDOORSTANDARDCASE"],
    check(ctx): RuleCheckResult {
      const h = firstPropNumber(ctx.props ?? {}, [
        "OverallHeight",
        "Height",
        "Pset_DoorCommon.Height",
      ]);
      if (h == null) return { pass: true, message: "Door height not recorded" };
      return {
        pass: h >= minMeters - 1e-4,
        message:
          h >= minMeters - 1e-4
            ? undefined
            : `Clear height ${mm(h)} is below ${jurisdiction} minimum`,
        actual: mm(h),
        required: `${mm(minMeters)} minimum`,
      };
    },
  };
}

function corridorMinWidth(
  id: string,
  name: string,
  minMeters: number,
  jurisdiction: string,
): Rule {
  return {
    id,
    name,
    description: `Corridors must be at least ${mm(minMeters)} wide.`,
    severity: "warning",
    category: "Fire & Egress",
    appliesTo: ["IFCSPACE"],
    check(ctx): RuleCheckResult {
      const isCorridor = anyPropContains(
        ctx.props,
        ["Name", "LongName", "ObjectType", "Pset_SpaceCommon.Category"],
        "corridor",
      );
      if (!isCorridor) return { pass: true };
      const w = firstPropNumber(ctx.props ?? {}, [
        "Pset_SpaceCommon.Width",
        "Width",
      ]);
      if (w == null) return { pass: true, message: "Corridor width not recorded" };
      return {
        pass: w >= minMeters - 1e-4,
        message:
          w >= minMeters - 1e-4
            ? undefined
            : `Corridor width ${mm(w)} is below ${jurisdiction} minimum`,
        actual: mm(w),
        required: `${mm(minMeters)} minimum`,
      };
    },
  };
}

function fireRatingPresent(
  id: string,
  name: string,
  appliesTo: string[],
  acceptedKeywords: string[],
): Rule {
  return {
    id,
    name,
    description:
      `Fire-rated assemblies must declare a rating in one of: ` +
      `${acceptedKeywords.join(", ")}.`,
    severity: "warning",
    category: "Fire & Egress",
    appliesTo,
    check(ctx): RuleCheckResult {
      const rating = anyPropContains(
        ctx.props,
        [
          "FireRating",
          "Pset_WallCommon.FireRating",
          "Pset_DoorCommon.FireRating",
          "Pset_SlabCommon.FireRating",
          "Pset_CoveringCommon.FireRating",
          "Pset_BeamCommon.FireRating",
          "Pset_ColumnCommon.FireRating",
        ],
        "fire",
      );
      const value = String(
        firstPropNumber(ctx.props ?? {}, []) ??
        (ctx.props?.["FireRating"] ?? ""),
      );
      if (!rating && !value) {
        return {
          pass: true,
          message: "No fire rating declared — assumed non-rated",
        };
      }
      const ok = acceptedKeywords.some((kw) =>
        String(value).toLowerCase().includes(kw.toLowerCase()),
      );
      return {
        pass: ok,
        message: ok ? undefined : `Fire rating "${value}" is not in accepted list`,
        actual: value,
        required: acceptedKeywords.join(" / "),
      };
    },
  };
}

function stairMinWidth(
  id: string,
  name: string,
  minMeters: number,
  jurisdiction: string,
): Rule {
  return {
    id,
    name,
    description: `Egress stairs must be at least ${mm(minMeters)} wide.`,
    severity: "error",
    category: "Fire & Egress",
    appliesTo: ["IFCSTAIRFLIGHT", "IFCSTAIR"],
    check(ctx): RuleCheckResult {
      const w = firstPropNumber(ctx.props ?? {}, [
        "Pset_StairFlightCommon.Width",
        "Width",
        "Pset_StairCommon.Width",
      ]);
      if (w == null) return { pass: true, message: "Stair width not recorded" };
      return {
        pass: w >= minMeters - 1e-4,
        message:
          w >= minMeters - 1e-4
            ? undefined
            : `Stair width ${mm(w)} is below ${jurisdiction} minimum`,
        actual: mm(w),
        required: `${mm(minMeters)} minimum`,
      };
    },
  };
}

function egressTravelDistanceLimit(
  id: string,
  name: string,
  maxMeters: number,
  jurisdiction: string,
): Rule {
  return {
    id,
    name,
    description:
      `Travel distance to the nearest exit must not exceed ` +
      `${maxMeters} m (dead-end limit).`,
    severity: "info",
    category: "Fire & Egress",
    appliesTo: ["IFCSPACE"],
    check(ctx): RuleCheckResult {
      const d = firstPropNumber(ctx.props ?? {}, [
        "Pset_SpaceFireSafetyRequirements.TravelDistanceToExit",
        "TravelDistance",
      ]);
      if (d == null) {
        return {
          pass: true,
          message: "Travel distance not recorded — cannot verify",
        };
      }
      return {
        pass: d <= maxMeters + 1e-4,
        message:
          d <= maxMeters + 1e-4
            ? undefined
            : `Travel distance ${d.toFixed(1)} m exceeds ${jurisdiction} limit`,
        actual: `${d.toFixed(2)} m`,
        required: `${maxMeters} m maximum`,
      };
    },
  };
}

/* ── Pack builders ─────────────────────────────────────────────────────── */

export const fireEgressPackUS: RulePack = {
  id: "fire-egress-us",
  name: "Fire & Egress (US)",
  description:
    "IBC 2021 egress requirements: door clear width, door clear height, " +
    "corridor and stair width, fire-rated assemblies, dead-end travel " +
    "distances.",
  jurisdiction: "United States",
  version: "IBC 2021",
  rules: [
    doorMinWidth(
      "us.egress.door-width",
      "Egress door clear width",
      0.813,   // 32 inches
      "IBC",
    ),
    doorMinHeight(
      "us.egress.door-height",
      "Egress door clear height",
      2.032,   // 80 inches
      "IBC",
    ),
    corridorMinWidth(
      "us.egress.corridor-width",
      "Egress corridor width",
      1.118,   // 44 inches
      "IBC",
    ),
    stairMinWidth(
      "us.egress.stair-width",
      "Egress stair width",
      1.118,
      "IBC",
    ),
    fireRatingPresent(
      "us.fire.rating",
      "Fire-rated assembly declares rating",
      ["IFCWALL", "IFCWALLSTANDARDCASE", "IFCDOOR", "IFCSLAB"],
      ["1-HR", "2-HR", "3-HR", "4-HR", "FIRE", "F-", "MIN"],
    ),
    egressTravelDistanceLimit(
      "us.egress.travel-distance",
      "Dead-end travel distance",
      23,      // ~75 ft
      "IBC",
    ),
  ],
};

export const fireEgressPackUK: RulePack = {
  id: "fire-egress-uk",
  name: "Fire & Egress (UK)",
  description:
    "Approved Document B (Fire Safety) 2019 requirements: egress " +
    "widths, door clear openings, fire door ratings, and travel " +
    "distance limits.",
  jurisdiction: "United Kingdom",
  version: "ADB 2019",
  rules: [
    doorMinWidth(
      "uk.egress.door-width",
      "Egress door clear width",
      0.750,
      "ADB",
    ),
    doorMinHeight(
      "uk.egress.door-height",
      "Egress door clear height",
      1.980,
      "ADB",
    ),
    corridorMinWidth(
      "uk.egress.corridor-width",
      "Egress corridor width",
      1.100,
      "ADB",
    ),
    stairMinWidth(
      "uk.egress.stair-width",
      "Egress stair width",
      1.000,
      "ADB",
    ),
    fireRatingPresent(
      "uk.fire.rating",
      "Fire door rated FD30 or FD60",
      ["IFCDOOR", "IFCDOORSTANDARDCASE"],
      ["FD30", "FD60", "FD90", "FD120", "30", "60"],
    ),
    egressTravelDistanceLimit(
      "uk.egress.travel-distance",
      "Travel distance to exit",
      18,
      "ADB",
    ),
  ],
};

export const fireEgressPackDE: RulePack = {
  id: "fire-egress-de",
  name: "Fire & Egress (Germany)",
  description:
    "Musterbauordnung (MBO) and DIN 4102 egress requirements: door " +
    "clear widths (lichte Breite), stair widths, fire-rating classes " +
    "(Feuerwiderstandsklassen).",
  jurisdiction: "Germany",
  version: "MBO 2016",
  rules: [
    doorMinWidth(
      "de.egress.door-width",
      "Notausgang lichte Breite",
      0.800,
      "MBO",
    ),
    doorMinHeight(
      "de.egress.door-height",
      "Notausgang lichte Höhe",
      2.000,
      "MBO",
    ),
    corridorMinWidth(
      "de.egress.corridor-width",
      "Rettungsweg Breite",
      1.200,
      "MBO",
    ),
    stairMinWidth(
      "de.egress.stair-width",
      "Treppenlauf Breite",
      1.000,
      "MBO",
    ),
    fireRatingPresent(
      "de.fire.rating",
      "Feuerwiderstandsklasse declared",
      ["IFCWALL", "IFCWALLSTANDARDCASE", "IFCDOOR", "IFCSLAB"],
      ["F30", "F60", "F90", "F120", "T30", "T60", "T90", "T120", "REI"],
    ),
    egressTravelDistanceLimit(
      "de.egress.travel-distance",
      "Rettungsweglänge",
      35,
      "MBO",
    ),
  ],
};

export const fireEgressPackCN: RulePack = {
  id: "fire-egress-cn",
  name: "Fire & Egress (China)",
  description:
    "GB 50016-2014 建筑设计防火规范 egress requirements: door clear " +
    "widths, stair widths, fire-rating classifications (耐火等级).",
  jurisdiction: "China",
  version: "GB 50016-2014",
  rules: [
    doorMinWidth(
      "cn.egress.door-width",
      "疏散门净宽度",
      0.900,
      "GB 50016",
    ),
    doorMinHeight(
      "cn.egress.door-height",
      "疏散门净高度",
      2.000,
      "GB 50016",
    ),
    corridorMinWidth(
      "cn.egress.corridor-width",
      "疏散走道净宽度",
      1.100,
      "GB 50016",
    ),
    stairMinWidth(
      "cn.egress.stair-width",
      "疏散楼梯净宽度",
      1.100,
      "GB 50016",
    ),
    fireRatingPresent(
      "cn.fire.rating",
      "耐火等级 declared",
      ["IFCWALL", "IFCWALLSTANDARDCASE", "IFCDOOR", "IFCSLAB"],
      ["一级", "二级", "三级", "四级", "1", "2", "3", "4", "A", "B"],
    ),
    egressTravelDistanceLimit(
      "cn.egress.travel-distance",
      "疏散距离",
      30,
      "GB 50016",
    ),
  ],
};

/* ── Aggregate export ──────────────────────────────────────────────────── */

export const fireEgressPacks: RulePack[] = [
  fireEgressPackUS,
  fireEgressPackUK,
  fireEgressPackDE,
  fireEgressPackCN,
];