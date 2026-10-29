/**
 * Clash Severity Scoring Engine.
 *
 * Automatically assigns priority and severity scores to clashes based on
 * building discipline pairings (e.g. Structural vs MEP = Critical).
 */

export type DisciplineCategory =
  | "structural"
  | "mep-duct"
  | "mep-pipe"
  | "mep-electrical"
  | "architectural"
  | "fire-protection";

export interface SeverityScore {
  score: number; // 0 to 100
  level: "critical" | "major" | "minor" | "negligible";
  reason: string;
  recommendedAction: string;
}

export function classifyIfcCategory(ifcType: string): DisciplineCategory {
  const t = (ifcType || "").toUpperCase();
  if (t.includes("COLUMN") || t.includes("BEAM") || t.includes("SLAB") || t.includes("FOOTING") || t.includes("MEMBER")) {
    return "structural";
  }
  if (t.includes("DUCT") || t.includes("AIRTERMINAL") || t.includes("DAMPER") || t.includes("FAN")) {
    return "mep-duct";
  }
  if (t.includes("PIPE") || t.includes("VALVE") || t.includes("PUMP")) {
    return "mep-pipe";
  }
  if (t.includes("CABLETRAY") || t.includes("JUNCTIONBOX") || t.includes("LIGHT") || t.includes("OUTLET")) {
    return "mep-electrical";
  }
  if (t.includes("SPRINKLER") || t.includes("FIRE")) {
    return "fire-protection";
  }
  return "architectural";
}

export function calculateClashSeverity(
  catA: DisciplineCategory,
  catB: DisciplineCategory,
  penetrationDepthM: number = 0.05
): SeverityScore {
  // Base weights for discipline pairs
  const pairKey = [catA, catB].sort().join("::");

  let baseScore = 50;
  let reason = "General cross-discipline interference";

  switch (pairKey) {
    case "structural::structural":
      baseScore = 95;
      reason = "Structural load-path conflict / double-modeled bearing element";
      break;
    case "mep-duct::structural":
    case "mep-pipe::structural":
      baseScore = 90;
      reason = "MEP penetration through primary structural element without sleeve";
      break;
    case "fire-protection::structural":
    case "fire-protection::mep-duct":
      baseScore = 85;
      reason = "Fire protection sprinkler head or main obstruction";
      break;
    case "mep-duct::mep-pipe":
    case "mep-duct::mep-electrical":
      baseScore = 75;
      reason = "HVAC / Electrical service routing coordination clash";
      break;
    case "architectural::structural":
      baseScore = 40;
      reason = "Wall / Finish wrap alignment to structural column";
      break;
    case "architectural::architectural":
      baseScore = 25;
      reason = "Minor finish or partition wall overlap";
      break;
    default:
      baseScore = 50;
      break;
  }

  // Adjust for penetration depth
  if (penetrationDepthM > 0.1) baseScore += 10;
  if (penetrationDepthM < 0.01) baseScore -= 15;

  const score = Math.max(0, Math.min(100, baseScore));
  const level: SeverityScore["level"] =
    score >= 80 ? "critical" : score >= 60 ? "major" : score >= 35 ? "minor" : "negligible";

  const action =
    level === "critical"
      ? "Resolve immediately before structural sign-off"
      : level === "major"
      ? "Route MEP around obstacle or coordinate opening"
      : "Adjust drafting alignment or finish thickness";

  return { score, level, reason, recommendedAction: action };
}
