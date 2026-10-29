/**
 * International Rebar Standards & Design Code Presets.
 *
 * Supports:
 * - ACI 318 (American Concrete Institute - US Customary & Metric)
 * - Eurocode 2 (EN 1992-1-1 - European Standard)
 * - IS 456 (Bureau of Indian Standards)
 * - GB 50010 (Code for Design of Concrete Structures - China)
 */

export type StandardCode = "ACI318" | "EC2" | "IS456" | "GB50010";

export interface BarSize {
  label: string;
  diameter: number; // in meters (e.g. 0.016 for 16mm)
  area: number; // in m²
  weight: number; // in kg/m
}

export interface RebarStandard {
  code: StandardCode;
  name: string;
  yieldStrengthMPa: number;
  bars: BarSize[];
  minCover: Record<string, number>; // in meters
  hookAngles: number[]; // e.g. [90, 135, 180]
  bendMultiplier: number;
}

export const REBAR_STANDARDS: Record<StandardCode, RebarStandard> = {
  ACI318: {
    code: "ACI318",
    name: "ACI 318-19 (US)",
    yieldStrengthMPa: 420,
    bars: [
      { label: "#3", diameter: 0.009525, area: 0.000071, weight: 0.56 },
      { label: "#4", diameter: 0.0127, area: 0.000129, weight: 0.994 },
      { label: "#5", diameter: 0.015875, area: 0.000199, weight: 1.552 },
      { label: "#6", diameter: 0.01905, area: 0.000284, weight: 2.235 },
      { label: "#7", diameter: 0.022225, area: 0.000387, weight: 3.042 },
      { label: "#8", diameter: 0.0254, area: 0.00051, weight: 3.973 },
      { label: "#9", diameter: 0.02865, area: 0.000645, weight: 5.06 },
      { label: "#10", diameter: 0.03226, area: 0.000819, weight: 6.404 },
      { label: "#11", diameter: 0.03581, area: 0.001006, weight: 7.907 },
      { label: "#14", diameter: 0.043, area: 0.001452, weight: 11.38 },
      { label: "#18", diameter: 0.05733, area: 0.002581, weight: 20.24 },
    ],
    minCover: {
      dryInterior: 0.04,
      exteriorExposed: 0.05,
      castAgainstEarth: 0.075,
      slabsInterior: 0.02,
    },
    hookAngles: [90, 135, 180],
    bendMultiplier: 4,
  },
  EC2: {
    code: "EC2",
    name: "Eurocode 2 (EN 1992-1-1)",
    yieldStrengthMPa: 500,
    bars: [
      { label: "Ø6", diameter: 0.006, area: 0.0000283, weight: 0.222 },
      { label: "Ø8", diameter: 0.008, area: 0.0000503, weight: 0.395 },
      { label: "Ø10", diameter: 0.01, area: 0.0000785, weight: 0.617 },
      { label: "Ø12", diameter: 0.012, area: 0.000113, weight: 0.888 },
      { label: "Ø16", diameter: 0.016, area: 0.000201, weight: 1.58 },
      { label: "Ø20", diameter: 0.02, area: 0.000314, weight: 2.47 },
      { label: "Ø25", diameter: 0.025, area: 0.000491, weight: 3.85 },
      { label: "Ø32", diameter: 0.032, area: 0.000804, weight: 6.31 },
      { label: "Ø40", diameter: 0.04, area: 0.001257, weight: 9.87 },
      { label: "Ø50", diameter: 0.05, area: 0.001963, weight: 15.4 },
    ],
    minCover: {
      XC1: 0.025, // Dry or permanently wet
      XC2: 0.035, // Wet, rarely dry
      XC3: 0.035, // Moderate humidity
      XC4: 0.04,  // Cyclic wet and dry
      XS1: 0.045, // Airborne salt marine
      XD1: 0.04,  // De-icing salts
    },
    hookAngles: [90, 135, 180],
    bendMultiplier: 4,
  },
  IS456: {
    code: "IS456",
    name: "IS 456:2000 (India)",
    yieldStrengthMPa: 500,
    bars: [
      { label: "6M", diameter: 0.006, area: 0.0000283, weight: 0.222 },
      { label: "8M", diameter: 0.008, area: 0.0000503, weight: 0.395 },
      { label: "10M", diameter: 0.01, area: 0.0000785, weight: 0.617 },
      { label: "12M", diameter: 0.012, area: 0.000113, weight: 0.888 },
      { label: "16M", diameter: 0.016, area: 0.000201, weight: 1.58 },
      { label: "20M", diameter: 0.02, area: 0.000314, weight: 2.47 },
      { label: "25M", diameter: 0.025, area: 0.000491, weight: 3.85 },
      { label: "28M", diameter: 0.028, area: 0.000615, weight: 4.83 },
      { label: "32M", diameter: 0.032, area: 0.000804, weight: 6.31 },
      { label: "36M", diameter: 0.036, area: 0.001018, weight: 7.99 },
    ],
    minCover: {
      mild: 0.02,
      moderate: 0.03,
      severe: 0.045,
      verySevere: 0.05,
      extreme: 0.075,
    },
    hookAngles: [90, 135, 180],
    bendMultiplier: 4,
  },
  GB50010: {
    code: "GB50010",
    name: "GB 50010-2010 (China)",
    yieldStrengthMPa: 400,
    bars: [
      { label: "6", diameter: 0.006, area: 0.0000283, weight: 0.222 },
      { label: "8", diameter: 0.008, area: 0.0000503, weight: 0.395 },
      { label: "10", diameter: 0.01, area: 0.0000785, weight: 0.617 },
      { label: "12", diameter: 0.012, area: 0.000113, weight: 0.888 },
      { label: "14", diameter: 0.014, area: 0.000154, weight: 1.21 },
      { label: "16", diameter: 0.016, area: 0.000201, weight: 1.58 },
      { label: "18", diameter: 0.018, area: 0.000254, weight: 2.0 },
      { label: "20", diameter: 0.02, area: 0.000314, weight: 2.47 },
      { label: "22", diameter: 0.022, area: 0.00038, weight: 2.98 },
      { label: "25", diameter: 0.025, area: 0.000491, weight: 3.85 },
      { label: "28", diameter: 0.028, area: 0.000615, weight: 4.83 },
      { label: "32", diameter: 0.032, area: 0.000804, weight: 6.31 },
    ],
    minCover: {
      interiorDry: 0.02,
      interiorHumid: 0.025,
      exteriorDirect: 0.035,
      soilContact: 0.05,
    },
    hookAngles: [90, 135, 180],
    bendMultiplier: 4,
  },
};

export function getBarByDiameter(std: StandardCode, nomDiameter: number): BarSize | undefined {
  const standard = REBAR_STANDARDS[std] || REBAR_STANDARDS.EC2;
  // find closest diameter within 1mm
  return standard.bars.find((b) => Math.abs(b.diameter - nomDiameter) < 0.001);
}

export function getMinCover(std: StandardCode, exposure: string): number {
  const standard = REBAR_STANDARDS[std] || REBAR_STANDARDS.EC2;
  return standard.minCover[exposure] ?? 0.03;
}

export function calcLapLength(std: StandardCode, diameter: number, fck: number = 30): number {
  // Common empirical approximations
  switch (std) {
    case "ACI318":
      // Class B tension lap splice approx ~ 1.3 * ld, ld ≈ (fy / (1.4 * sqrt(f'c))) * d_b
      return Math.max(0.3, Math.round(50 * diameter * 1000) / 1000);
    case "EC2": {
      // l_0 = alpha_1 * alpha_6 * l_b,rqd
      const fbd = 0.315 * Math.pow(fck, 2 / 3);
      const l_brqd = (diameter / 4) * (500 / fbd);
      return Math.max(0.3, Math.round(l_brqd * 1.5 * 1000) / 1000);
    }
    case "IS456":
      // Ld = (sigma_s * phi) / (4 * tau_bd), with lap = Ld or 30*dia
      return Math.max(0.3, Math.round(45 * diameter * 1000) / 1000);
    case "GB50010":
      return Math.max(0.3, Math.round(40 * diameter * 1000) / 1000);
    default:
      return Math.max(0.3, Math.round(48 * diameter * 1000) / 1000);
  }
}

export function calcAnchorLength(std: StandardCode, diameter: number, fck: number = 30): number {
  return Math.round(calcLapLength(std, diameter, fck) * 0.7 * 1000) / 1000;
}
