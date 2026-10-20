/** Line weights by element type — pen assignment per category. */
export interface LineWeightRule {
  elementType: string;
  /** Line width in mm on paper (e.g. 0.35 = 0.35mm pen). */
  widthMm: number;
  /** Color (hex). */
  color: string;
}

export const DEFAULT_LINE_WEIGHTS: LineWeightRule[] = [
  { elementType: "wall", widthMm: 0.35, color: "#1e293b" },
  { elementType: "door", widthMm: 0.25, color: "#334155" },
  { elementType: "window", widthMm: 0.25, color: "#334155" },
  { elementType: "column", widthMm: 0.35, color: "#1e293b" },
  { elementType: "beam", widthMm: 0.30, color: "#1e293b" },
  { elementType: "slab", widthMm: 0.30, color: "#1e293b" },
  { elementType: "roof", widthMm: 0.30, color: "#1e293b" },
  { elementType: "stairs", widthMm: 0.25, color: "#475569" },
  { elementType: "duct", widthMm: 0.15, color: "#3b82f6" },
  { elementType: "pipe", widthMm: 0.15, color: "#22c55e" },
  { elementType: "grid", widthMm: 0.10, color: "#94a3b8" },
  { elementType: "dimension", widthMm: 0.18, color: "#1d4ed8" },
  { elementType: "annotation", widthMm: 0.13, color: "#1e293b" },
  { elementType: "default", widthMm: 0.18, color: "#334155" },
];

const rules = new Map<string, LineWeightRule>();
for (const r of DEFAULT_LINE_WEIGHTS) rules.set(r.elementType, r);

export function getLineWeight(elementType: string): LineWeightRule {
  return rules.get(elementType) ?? rules.get("default") ?? DEFAULT_LINE_WEIGHTS[DEFAULT_LINE_WEIGHTS.length - 1];
}
export function setLineWeight(elementType: string, widthMm: number, color?: string): void {
  const existing = rules.get(elementType) ?? { elementType, widthMm, color: "#334155" };
  rules.set(elementType, { ...existing, widthMm, ...(color ? { color } : {}) });
}
export function listLineWeights(): LineWeightRule[] { return [...rules.values()]; }

let installed = false;
export function setupLineWeights() {
  if (installed) return; installed = true;
  (window as any).__obsLineWeights = { get: getLineWeight, set: setLineWeight, list: listLineWeights };
  console.log("[line-weights] ready. Configure pen weights per element type via __obsLineWeights.");
}
