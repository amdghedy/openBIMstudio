/**
 * Accessibility rule packs.
 *
 * ADA (US), Approved Document M (UK), DIN 18040 (Germany), and
 * GB 50763 (China). Focus on the checks a coordination model can actually
 * verify — clear widths, ramp slopes, hardware types, and handrail
 * heights.
 */
import type { Rule, RulePack } from "../../types";
import {
  firstPropNumber, firstPropString, anyPropContains, mm,
} from "../../framework";

/* ── Rule factories ────────────────────────────────────────────────────── */

function accessibleDoorClearWidth(
  id: string,
  name: string,
  minMeters: number,
  jurisdiction: string,
): Rule {
  return {
    id,
    name,
    description:
      `Accessible doors must have a clear opening width of at least ` +
      `${mm(minMeters)}.`,
    severity: "warning",
    category: "Accessibility",
    appliesTo: ["IFCDOOR", "IFCDOORSTANDARDCASE"],
    check(ctx) {
      const w = firstPropNumber(ctx.props ?? {}, [
        "Pset_DoorCommon.ClearWidth",
        "Pset_DoorCommon.Width",
        "OverallWidth",
        "Width",
      ]);
      if (w == null) return { pass: true, message: "Door width not recorded" };
      return {
        pass: w >= minMeters - 1e-4,
        message:
          w >= minMeters - 1e-4
            ? undefined
            : `Clear width ${mm(w)} is below ${jurisdiction} accessible minimum`,
        actual: mm(w),
        required: `${mm(minMeters)} minimum`,
      };
    },
  };
}

function accessibleDoorHardware(
  id: string,
  name: string,
  bannedKeywords: string[],
): Rule {
  return {
    id,
    name,
    description:
      `Accessible doors must not use ${bannedKeywords.join(", ")} hardware.`,
    severity: "warning",
    category: "Accessibility",
    appliesTo: ["IFCDOOR", "IFCDOORSTANDARDCASE"],
    check(ctx) {
      const hw = firstPropString(ctx.props ?? {}, [
        "Pset_DoorCommon.HardwareType",
        "HardwareType",
        "Pset_DoorCommon.HandleType",
      ]);
      if (!hw) return { pass: true, message: "Door hardware not specified" };
      const lower = hw.toLowerCase();
      const bad = bannedKeywords.find((k) => lower.includes(k.toLowerCase()));
      return {
        pass: !bad,
        message: bad ? `Door hardware "${hw}" is not accessible` : undefined,
        actual: hw,
        required: `No ${bannedKeywords.join(", ")}`,
      };
    },
  };
}

function rampSlope(
  id: string,
  name: string,
  maxRatio: number,
  jurisdiction: string,
): Rule {
  // maxRatio: 12 = 1:12
  return {
    id,
    name,
    description:
      `Accessible ramps must have a slope no steeper than 1:${maxRatio}.`,
    severity: "error",
    category: "Accessibility",
    appliesTo: ["IFCRAMP", "IFCRAMPFLIGHT"],
    check(ctx) {
      const ratio = firstPropNumber(ctx.props ?? {}, [
        "Pset_RampCommon.Slope",
        "Pset_RampFlightCommon.Slope",
        "Slope",
      ]);
      if (ratio == null) return { pass: true, message: "Ramp slope not recorded" };
      // Accept either a decimal slope (0.083) or a ratio-as-number (12).
      const asRatio = ratio > 1 ? ratio : 1 / ratio;
      return {
        pass: asRatio >= maxRatio - 1e-3,
        message:
          asRatio >= maxRatio - 1e-3
            ? undefined
            : `Ramp slope 1:${asRatio.toFixed(1)} is steeper than ${jurisdiction} limit`,
        actual: `1:${asRatio.toFixed(2)}`,
        required: `1:${maxRatio} maximum`,
      };
    },
  };
}

function handrailHeight(
  id: string,
  name: string,
  minMeters: number,
  maxMeters: number,
  jurisdiction: string,
): Rule {
  return {
    id,
    name,
    description:
      `Handrails must be between ${mm(minMeters)} and ${mm(maxMeters)} ` +
      `above the walking surface.`,
    severity: "warning",
    category: "Accessibility",
    appliesTo: ["IFCRAILING", "IFCSTAIR", "IFCRAMP"],
    check(ctx) {
      const h = firstPropNumber(ctx.props ?? {}, [
        "Pset_RailingCommon.Height",
        "Height",
        "Pset_StairCommon.HandrailHeight",
      ]);
      if (h == null) return { pass: true, message: "Handrail height not recorded" };
      const ok = h >= minMeters - 1e-4 && h <= maxMeters + 1e-4;
      return {
        pass: ok,
        message: ok
          ? undefined
          : `Handrail ${mm(h)} is outside ${jurisdiction} range`,
        actual: mm(h),
        required: `${mm(minMeters)} to ${mm(maxMeters)}`,
      };
    },
  };
}

function routeMinWidth(
  id: string,
  name: string,
  minMeters: number,
  jurisdiction: string,
): Rule {
  return {
    id,
    name,
    description:
      `Accessible routes must be at least ${mm(minMeters)} wide.`,
    severity: "warning",
    category: "Accessibility",
    appliesTo: ["IFCSPACE"],
    check(ctx) {
      const isAccessible = anyPropContains(
        ctx.props,
        ["Name", "LongName", "ObjectType", "Description"],
        "accessible",
      );
      if (!isAccessible) return { pass: true };
      const w = firstPropNumber(ctx.props ?? {}, [
        "Pset_SpaceCommon.Width",
        "Width",
      ]);
      if (w == null) return { pass: true, message: "Route width not recorded" };
      return {
        pass: w >= minMeters - 1e-4,
        message:
          w >= minMeters - 1e-4
            ? undefined
            : `Route width ${mm(w)} is below ${jurisdiction} minimum`,
        actual: mm(w),
        required: `${mm(minMeters)} minimum`,
      };
    },
  };
}

/* ── Pack builders ─────────────────────────────────────────────────────── */

export const accessibilityPackUS: RulePack = {
  id: "accessibility-us",
  name: "Accessibility (US)",
  description:
    "ADA 2010 Standards for Accessible Design: door clear widths, " +
    "hardware, ramp slopes, handrail heights, and accessible route " +
    "widths.",
  jurisdiction: "United States",
  version: "ADA 2010",
  rules: [
    accessibleDoorClearWidth(
      "us.ada.door-width",
      "Door clear width (ADA)",
      0.813,   // 32 inches
      "ADA",
    ),
    accessibleDoorHardware(
      "us.ada.door-hardware",
      "Door hardware (ADA)",
      ["knob", "round handle"],
    ),
    rampSlope("us.ada.ramp-slope", "Ramp slope (ADA)", 12, "ADA"),
    handrailHeight(
      "us.ada.handrail-height",
      "Handrail height (ADA)",
      0.865,   // 34 inches
      0.965,   // 38 inches
      "ADA",
    ),
    routeMinWidth(
      "us.ada.route-width",
      "Accessible route width (ADA)",
      0.915,   // 36 inches
      "ADA",
    ),
  ],
};

export const accessibilityPackUK: RulePack = {
  id: "accessibility-uk",
  name: "Accessibility (UK)",
  description:
    "Approved Document M (Access to and Use of Buildings) 2015: door " +
    "widths, corridor widths, ramp gradients, and handrail heights.",
  jurisdiction: "United Kingdom",
  version: "Part M 2015",
  rules: [
    accessibleDoorClearWidth(
      "uk.m.door-width",
      "Door clear width (Part M)",
      0.775,   // 750 mm door leaf
      "Part M",
    ),
    accessibleDoorHardware(
      "uk.m.door-hardware",
      "Door hardware (Part M)",
      ["knob"],
    ),
    rampSlope("uk.m.ramp-slope", "Ramp slope (Part M)", 12, "Part M"),
    handrailHeight(
      "uk.m.handrail-height",
      "Handrail height (Part M)",
      0.900,
      1.100,
      "Part M",
    ),
    routeMinWidth(
      "uk.m.route-width",
      "Accessible route width (Part M)",
      1.200,
      "Part M",
    ),
  ],
};

export const accessibilityPackDE: RulePack = {
  id: "accessibility-de",
  name: "Accessibility (Germany)",
  description:
    "DIN 18040-1 (Barrierefreies Bauen): door clear widths, ramp " +
    "slopes, handrail heights, and accessible route widths.",
  jurisdiction: "Germany",
  version: "DIN 18040-1",
  rules: [
    accessibleDoorClearWidth(
      "de.access.door-width",
      "Türbreite (DIN 18040)",
      0.900,
      "DIN 18040",
    ),
    accessibleDoorHardware(
      "de.access.door-hardware",
      "Türdrücker (DIN 18040)",
      ["drehknauf"],
    ),
    rampSlope("de.access.ramp-slope", "Rampenneigung (DIN 18040)", 12, "DIN 18040"),
    handrailHeight(
      "de.access.handrail-height",
      "Handlaufhöhe (DIN 18040)",
      0.850,
      0.900,
      "DIN 18040",
    ),
    routeMinWidth(
      "de.access.route-width",
      "Bewegungsfläche (DIN 18040)",
      1.200,
      "DIN 18040",
    ),
  ],
};

export const accessibilityPackCN: RulePack = {
  id: "accessibility-cn",
  name: "Accessibility (China)",
  description:
    "GB 50763-2012 无障碍设计规范: door clear widths, ramp slopes, " +
    "handrail heights, and route widths.",
  jurisdiction: "China",
  version: "GB 50763-2012",
  rules: [
    accessibleDoorClearWidth(
      "cn.access.door-width",
      "无障碍门净宽 (GB 50763)",
      0.800,
      "GB 50763",
    ),
    rampSlope("cn.access.ramp-slope", "无障碍坡道坡度 (GB 50763)", 12, "GB 50763"),
    handrailHeight(
      "cn.access.handrail-height",
      "扶手高度 (GB 50763)",
      0.850,
      0.900,
      "GB 50763",
    ),
    routeMinWidth(
      "cn.access.route-width",
      "无障碍通道净宽 (GB 50763)",
      1.200,
      "GB 50763",
    ),
  ],
};

export const accessibilityPacks: RulePack[] = [
  accessibilityPackUS,
  accessibilityPackUK,
  accessibilityPackDE,
  accessibilityPackCN,
];