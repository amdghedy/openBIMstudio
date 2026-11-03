/**
 * GCC / Middle-East standards rule packs (Phase 3 of the international roadmap).
 *
 * Jurisdictions covered: United Arab Emirates, Saudi Arabia, Egypt and the
 * wider Gulf Cooperation Council. The checks focus on what a federated
 * coordination model can actually verify through IFC properties: egress
 * distances and door widths (UAE Fire & Life Safety Code / SBC 201 lineage),
 * and accessibility clearances (Qatar/USSC-style 900 mm guidance adopted
 * across the GCC, Estidama/Parklife friendly values).
 *
 * Values are conservative engineering defaults intended to be reviewed by a
 * local AHJ before regulatory use — same disclaimer as the other packs.
 */
import type { Rule, RulePack } from "../../types";
import {
  firstPropNumber, anyPropContains, mm,
} from "../../framework";

/* ── Shared rule factories ─────────────────────────────────────────────── */

function travelDistanceRule(
  id: string,
  name: string,
  maxMeters: number,
  standard: string,
): Rule {
  return {
    id,
    name,
    description:
      `Occupied spaces must not exceed ${mm(maxMeters)} travel distance to an ` +
      `exit door without an intermediate exit access (${standard}).`,
    severity: "error",
    category: "Egress",
    standard,
    appliesTo: ["IFCSPACE"],
    check(ctx) {
      const d = firstPropNumber(ctx.props ?? {}, [
        "Pset_SpaceCommon.TravelDistance",
        "TravelDistance",
        "Pset_Egress.TravelDistance",
      ]);
      if (d == null) return { pass: true, message: "Travel distance not recorded" };
      return {
        pass: d <= maxMeters + 1e-4,
        message:
          d <= maxMeters + 1e-4
            ? undefined
            : `Travel distance ${mm(d)} exceeds ${standard} limit`,
        actual: mm(d),
        required: `${mm(maxMeters)} maximum`,
      };
    },
  };
}

function exitDoorWidthRule(
  id: string,
  name: string,
  minMeters: number,
  standard: string,
): Rule {
  return {
    id,
    name,
    description:
      `Exit doors serving assembly or educational occupancies require a ` +
      `minimum clear width of ${mm(minMeters)} (${standard}).`,
    severity: "warning",
    category: "Egress",
    standard,
    appliesTo: ["IFCDOOR", "IFCDOORSTANDARDCASE"],
    check(ctx) {
      const isExit =
        anyPropContains(ctx.props ?? {}, ["Name", "Reference", "Type"], "exit") ||
        anyPropContains(ctx.props ?? {}, ["Pset_DoorCommon.IsExternal", "IsExternal"], "true");
      if (!isExit) return { pass: true, message: "Not identified as an exit door" };
      const w = firstPropNumber(ctx.props ?? {}, [
        "Pset_DoorCommon.ClearWidth",
        "OverallWidth",
        "Width",
      ]);
      if (w == null) return { pass: true, message: "Door width not recorded" };
      return {
        pass: w >= minMeters - 1e-4,
        message:
          w >= minMeters - 1e-4
            ? undefined
            : `Exit door clear width ${mm(w)} below ${standard} minimum`,
        actual: mm(w),
        required: `${mm(minMeters)} minimum`,
      };
    },
  };
}

function accessibleRouteWidthRule(
  id: string,
  name: string,
  minMeters: number,
  standard: string,
): Rule {
  return {
    id,
    name,
    description:
      `Accessible circulation routes must provide at least ${mm(minMeters)} ` +
      `clear width (${standard}).`,
    severity: "warning",
    category: "Accessibility",
    standard,
    appliesTo: ["IFCSPACE"],
    check(ctx) {
      const corridorLike =
        anyPropContains(ctx.props ?? {}, ["Name", "LongName", "Category"], "corridor") ||
        anyPropContains(ctx.props ?? {}, ["Name", "LongName"], "hall") ||
        anyPropContains(ctx.props ?? {}, ["Name"], "ممر");
      if (!corridorLike) return { pass: true, message: "Not a circulation space" };
      const w = firstPropNumber(ctx.props ?? {}, [
        "ClearWidth",
        "Width",
        "Pset_SpaceCommon.Width",
      ]);
      if (w == null) return { pass: true, message: "Route width not recorded" };
      return {
        pass: w >= minMeters - 1e-4,
        message:
          w >= minMeters - 1e-4
            ? undefined
            : `Route clear width ${mm(w)} below ${standard} minimum`,
        actual: mm(w),
        required: `${mm(minMeters)} minimum`,
      };
    },
  };
}

function prayerRoomSeparationRule(id: string, name: string, standard: string): Rule {
  return {
    id,
    name,
    description:
      `Model should contain distinct male and female prayer facilities for ` +
      `workplace/mall projects where required (${standard}).`,
    severity: "info",
    category: "Compliance",
    standard,
    requiresCategories(cats) {
      return cats.includes("IFCSPACE");
    },
    check(ctx) {
      const names = (ctx.elements ?? [])
        .map((e) => String(e.name ?? ""))
        .join("|")
        .toLowerCase();
      const hasPrayer = names.includes("prayer") || names.includes("مصلى") || names.includes("مصلی");
      if (!hasPrayer) return { pass: true, message: "No prayer rooms in model" };
      const hasMale = /prayer.*(male|men)|مصلى رجال/.test(names);
      const hasFemale = /prayer.*(female|women)|مصلى نساء/.test(names);
      const ok = hasMale && hasFemale;
      return {
        pass: ok,
        message: ok
          ? undefined
          : "Prayer facilities present but male/female separation not identifiable",
        actual: `male=${hasMale} female=${hasFemale}`,
        required: "separate male & female prayer rooms",
      };
    },
  };
}

/* ── Packs ─────────────────────────────────────────────────────────────── */

export const fireEgressPackGCC: RulePack = {
  id: "fire-egress-intl-gcc",
  name: "Fire & Egress (GCC)",
  description:
    "UAE Fire & Life Safety Code / Saudi Building Code 201 travel-distance and " +
    "exit-door checks applied across GCC jurisdictions.",
  jurisdiction: "International",
  version: "UAE FSC 2018 / SBC 201",
  rules: [
    travelDistanceRule(
      "gcc.egress.travel-45",
      "Travel distance ≤ 45 m (GCC)",
      45,
      "UAE FSC / SBC 201",
    ),
    exitDoorWidthRule(
      "gcc.egress.exit-width-900",
      "Exit door width ≥ 900 mm (GCC)",
      0.9,
      "UAE FSC / SBC 201",
    ),
    prayerRoomSeparationRule(
      "gcc.compliance.prayer-separation",
      "Prayer facility separation (GCC)",
      "UAE FSC workplace guidance",
    ),
  ],
};

export const accessibilityPackGCC: RulePack = {
  id: "accessibility-intl-gcc",
  name: "Accessibility (GCC)",
  description:
    "Gulf accessibility guidance (Dubai Build / Qatar USSC lineage): 900 mm " +
    "accessible routes and 900 mm door clear widths.",
  jurisdiction: "International",
  version: "Dubai Build 2017 / USSC",
  rules: [
    accessibleRouteWidthRule(
      "gcc.access.route-900",
      "Accessible route ≥ 900 mm (GCC)",
      0.9,
      "Dubai Build / USSC",
    ),
    exitDoorWidthRule(
      "gcc.access.door-900",
      "Accessible door ≥ 900 mm (GCC)",
      0.9,
      "Dubai Build / USSC",
    ),
  ],
};

export const gccPacks: RulePack[] = [fireEgressPackGCC, accessibilityPackGCC];
