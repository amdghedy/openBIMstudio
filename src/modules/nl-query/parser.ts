/**
 * Natural Language BIM Query Parser.
 *
 * Fast, deterministic, client-side NLP parser that translates plain-English
 * AEC questions and commands into structured BIM filters without needing any API keys.
 */

export type FilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";

export interface PropertyCriterion {
  property: string;
  operator: FilterOperator;
  value: string | number | boolean;
  unit?: string;
}

export interface ParsedBimQuery {
  rawQuery: string;
  action: "select" | "highlight" | "count" | "show" | "hide" | "isolate";
  targetCategories: string[]; // e.g. ["IFCWALL", "IFCWALLSTANDARDCASE"]
  criteria: PropertyCriterion[];
  confidence: number;
  interpretedSummary: string;
}

const CATEGORY_MAP: Record<string, string[]> = {
  wall: ["IFCWALL", "IFCWALLSTANDARDCASE"],
  walls: ["IFCWALL", "IFCWALLSTANDARDCASE"],
  door: ["IFCDOOR"],
  doors: ["IFCDOOR"],
  window: ["IFCWINDOW"],
  windows: ["IFCWINDOW"],
  column: ["IFCCOLUMN"],
  columns: ["IFCCOLUMN"],
  beam: ["IFCBEAM", "IFCMEMBER"],
  beams: ["IFCBEAM", "IFCMEMBER"],
  slab: ["IFCSLAB"],
  slabs: ["IFCSLAB"],
  floor: ["IFCSLAB"],
  floors: ["IFCSLAB"],
  roof: ["IFCROOF", "IFCSLAB"],
  roofs: ["IFCROOF", "IFCSLAB"],
  pipe: ["IFCPIPESEGMENT", "IFCPIPEFITTING"],
  pipes: ["IFCPIPESEGMENT", "IFCPIPEFITTING"],
  duct: ["IFCDUCTSEGMENT", "IFCDUCTFITTING"],
  ducts: ["IFCDUCTSEGMENT", "IFCDUCTFITTING"],
  rebar: ["IFCREINFORCINGBAR"],
  rebars: ["IFCREINFORCINGBAR"],
  reinforcement: ["IFCREINFORCINGBAR", "IFCREINFORCINGMESH"],
};

export function parseNLQuery(text: string): ParsedBimQuery {
  const query = text.trim();
  const lower = query.toLowerCase();

  // 1. Detect Action
  let action: ParsedBimQuery["action"] = "select";
  if (lower.startsWith("count") || lower.includes("how many")) {
    action = "count";
  } else if (lower.startsWith("highlight") || lower.startsWith("color")) {
    action = "highlight";
  } else if (lower.startsWith("hide")) {
    action = "hide";
  } else if (lower.startsWith("isolate")) {
    action = "isolate";
  } else if (lower.startsWith("show")) {
    action = "show";
  }

  // 2. Detect Categories
  const targetCategories: string[] = [];
  for (const [word, ifcTypes] of Object.entries(CATEGORY_MAP)) {
    const reg = new RegExp(`\\b${word}\\b`, "i");
    if (reg.test(lower)) {
      for (const t of ifcTypes) {
        if (!targetCategories.includes(t)) targetCategories.push(t);
      }
    }
  }

  // 3. Detect Property Criteria
  const criteria: PropertyCriterion[] = [];

  // Thickness / Width check (e.g. "thicker than 200mm", "> 200 mm", "300mm")
  const thickMatch = lower.match(/(?:thicker than|thickness\s*(?:>|>=))\s*(\d+(?:\.\d+)?)\s*(mm|m)?/);
  if (thickMatch) {
    let val = parseFloat(thickMatch[1]);
    const unit = thickMatch[2] || "mm";
    if (unit === "mm") val = val / 1000; // convert to meters
    criteria.push({ property: "Width", operator: "gte", value: val, unit: "m" });
  }

  // Height check (e.g. "taller than 3m", "height > 2.5m")
  const heightMatch = lower.match(/(?:taller than|height\s*(?:>|>=))\s*(\d+(?:\.\d+)?)\s*(mm|m)?/);
  if (heightMatch) {
    let val = parseFloat(heightMatch[1]);
    const unit = heightMatch[2] || "m";
    if (unit === "mm") val = val / 1000;
    criteria.push({ property: "Height", operator: "gte", value: val, unit: "m" });
  }

  // Fire rating (e.g. "fire rated", "fire rating EI30")
  if (lower.includes("fire rated") || lower.includes("fire-rated") || lower.includes("fire rating")) {
    criteria.push({ property: "FireRating", operator: "contains", value: "EI" });
  }

  // Load bearing
  if (lower.includes("load bearing") || lower.includes("load-bearing") || lower.includes("structural")) {
    criteria.push({ property: "LoadBearing", operator: "eq", value: true });
  }

  // External / Exterior
  if (lower.includes("external") || lower.includes("exterior")) {
    criteria.push({ property: "IsExternal", operator: "eq", value: true });
  }

  // Material check
  for (const mat of ["concrete", "steel", "timber", "glass", "brick", "masonry"]) {
    if (new RegExp(`\\b${mat}\\b`, "i").test(lower)) {
      criteria.push({ property: "Material", operator: "contains", value: mat });
    }
  }

  // Summary generation
  const catSummary = targetCategories.length
    ? targetCategories.map((c) => c.replace("IFC", "")).join(", ")
    : "Elements";
  const critSummary = criteria.map((c) => `${c.property} ${c.operator} ${c.value}`).join(" AND ");
  const interpreted = `${action.toUpperCase()} ${catSummary}${critSummary ? ` WHERE (${critSummary})` : ""}`;

  return {
    rawQuery: query,
    action,
    targetCategories: targetCategories.length ? targetCategories : ["ALL"],
    criteria,
    confidence: targetCategories.length ? 0.95 : 0.65,
    interpretedSummary: interpreted,
  };
}
