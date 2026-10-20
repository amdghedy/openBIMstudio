/**
 * Material assignment engine — assign physical materials to elements.
 *
 * Materials drive: render appearance (color, roughness, metalness),
 * quantity takeoff (density, cost), thermal properties, and structural
 * properties. BIM's "Material" browser assigns materials per element
 * type or per instance.
 */

/** A material definition. */
export interface MaterialDef {
  id: string;
  name: string;
  /** Render color (hex). */
  color: string;
  /** Metalness (0-1). 0 = dielectric, 1 = metal. */
  metalness: number;
  /** Roughness (0-1). 0 = mirror, 1 = matte. */
  roughness: number;
  /** Density (kg/m³). */
  density: number;
  /** Cost per unit (per kg or per m³). */
  costPerUnit: number;
  costUnit: "kg" | "m3";
  /** Thermal conductivity (W/m·K). */
  thermalConductivity?: number;
  /** Specific heat (J/kg·K). */
  specificHeat?: number;
  /** Category (concrete, steel, wood, glass, etc.). */
  category: string;
}

/** Built-in materials library. */
export const BUILTIN_MATERIALS: MaterialDef[] = [
  { id: "concrete-c30", name: "Concrete C30/37", color: "#a8a29e", metalness: 0, roughness: 0.9, density: 2400, costPerUnit: 0.15, costUnit: "kg", thermalConductivity: 1.7, specificHeat: 880, category: "concrete" },
  { id: "steel-s355", name: "Structural Steel S355", color: "#64748b", metalness: 0.9, roughness: 0.35, density: 7850, costPerUnit: 1.2, costUnit: "kg", thermalConductivity: 50, specificHeat: 490, category: "steel" },
  { id: "rebar-b500", name: "Rebar B500B", color: "#475569", metalness: 0.85, roughness: 0.4, density: 7850, costPerUnit: 1.0, costUnit: "kg", category: "steel" },
  { id: "brick-solid", name: "Solid Brick", color: "#a16207", metalness: 0, roughness: 0.95, density: 1800, costPerUnit: 0.3, costUnit: "kg", thermalConductivity: 0.8, specificHeat: 900, category: "masonry" },
  { id: "glass-clear", name: "Clear Glass", color: "#bfdbfe", metalness: 0, roughness: 0.05, density: 2500, costPerUnit: 200, costUnit: "m3", thermalConductivity: 1.0, specificHeat: 840, category: "glass" },
  { id: "wood-pine", name: "Pine Wood", color: "#d6d3d1", metalness: 0, roughness: 0.7, density: 500, costPerUnit: 0.8, costUnit: "kg", thermalConductivity: 0.13, specificHeat: 1600, category: "wood" },
  { id: "aluminium", name: "Aluminium Alloy", color: "#cbd5e1", metalness: 0.95, roughness: 0.2, density: 2700, costPerUnit: 3.5, costUnit: "kg", thermalConductivity: 200, specificHeat: 900, category: "metal" },
  { id: "gypsum-board", name: "Gypsum Board", color: "#f5f5f4", metalness: 0, roughness: 0.85, density: 800, costPerUnit: 5, costUnit: "m3", thermalConductivity: 0.25, specificHeat: 1090, category: "gypsum" },
  { id: "insulation-mineral", name: "Mineral Wool Insulation", color: "#e7e5e4", metalness: 0, roughness: 1, density: 100, costPerUnit: 50, costUnit: "m3", thermalConductivity: 0.04, specificHeat: 1030, category: "insulation" },
];

/** Material assignments: element ID → material ID. */
const assignments = new Map<string, string>();

/** Assign a material to an element. */
export function assignMaterial(elementId: string, materialId: string): void {
  assignments.set(elementId, materialId);
}

/** Get the material assigned to an element. */
export function getMaterial(elementId: string): MaterialDef | null {
  const matId = assignments.get(elementId);
  if (!matId) return null;
  return BUILTIN_MATERIALS.find((m) => m.id === matId) ?? null;
}

/** Get the material ID assigned to an element (raw string). */
export function getMaterialId(elementId: string): string | null {
  return assignments.get(elementId) ?? null;
}

/** Remove material assignment from an element. */
export function removeMaterialAssignment(elementId: string): void {
  assignments.delete(elementId);
}

/** Get all material assignments. */
export function getAllAssignments(): Array<{ elementId: string; materialId: string }> {
  return [...assignments.entries()].map(([elementId, materialId]) => ({ elementId, materialId }));
}

/** Get a material by ID. */
export function getMaterialDef(id: string): MaterialDef | null {
  return BUILTIN_MATERIALS.find((m) => m.id === id) ?? null;
}

/** List all materials. */
export function listMaterials(): Array<{ id: string; name: string; category: string }> {
  return BUILTIN_MATERIALS.map((m) => ({ id: m.id, name: m.name, category: m.category }));
}
