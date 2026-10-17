/**
 * Material library — professional material definitions for QTO, appearance & thermal.
 */
import type { MaterialDef } from "../projects/types";

const uid = () =>
  (crypto as any).randomUUID?.() ?? `mat-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const DEFAULTS: Omit<MaterialDef, "id">[] = [
  { name: "Concrete C25/30", category: "concrete", color: "#9ca3af", density: 2400, costPerUnit: 120, unit: "m³" },
  { name: "Concrete C30/37", category: "concrete", color: "#6b7280", density: 2400, costPerUnit: 135, unit: "m³" },
  { name: "Structural Steel S355", category: "steel", color: "#64748b", density: 7850, costPerUnit: 1.8, unit: "kg" },
  { name: "Rebar B500B", category: "steel", color: "#475569", density: 7850, costPerUnit: 1.2, unit: "kg" },
  { name: "Softwood Timber", category: "timber", color: "#d97706", density: 500, costPerUnit: 450, unit: "m³" },
  { name: "CLT Panel", category: "timber", color: "#b45309", density: 500, costPerUnit: 650, unit: "m³" },
  { name: "Float Glass 6mm", category: "glass", color: "#7dd3fc", density: 2500, costPerUnit: 45, unit: "m²" },
  { name: "Double Glazing", category: "glass", color: "#38bdf8", density: 20, costPerUnit: 180, unit: "m²" },
  { name: "Mineral Wool", category: "insulation", color: "#fef3c7", density: 40, thermalConductivity: 0.035, costPerUnit: 25, unit: "m²" },
  { name: "Gypsum Board 12.5", category: "finish", color: "#f8fafc", density: 700, costPerUnit: 8, unit: "m²" },
  { name: "Ceramic Tile", category: "finish", color: "#e2e8f0", density: 2000, costPerUnit: 35, unit: "m²" },
  { name: "Copper Pipe", category: "mep", color: "#f59e0b", density: 8960, costPerUnit: 12, unit: "m" },
  { name: "PVC Pipe", category: "mep", color: "#94a3b8", density: 1400, costPerUnit: 4, unit: "m" },
  { name: "Galvanised Duct", category: "mep", color: "#cbd5e1", density: 7850, costPerUnit: 28, unit: "m²" },
];

let materials: MaterialDef[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function onMaterialsChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function listMaterials(): MaterialDef[] {
  return materials.slice().sort((a, b) => a.name.localeCompare(b.name));
}

export function ensureDefaultMaterials() {
  if (materials.length) return;
  materials = DEFAULTS.map((m) => ({ ...m, id: uid() }));
  notify();
}

export function addMaterial(partial: Partial<MaterialDef> & { name: string }): MaterialDef {
  const mat: MaterialDef = {
    id: uid(),
    name: partial.name,
    category: partial.category ?? "other",
    color: partial.color ?? "#94a3b8",
    density: partial.density,
    thermalConductivity: partial.thermalConductivity,
    costPerUnit: partial.costPerUnit,
    unit: partial.unit,
  };
  materials.push(mat);
  notify();
  return mat;
}

export function getMaterial(id: string) {
  return materials.find((m) => m.id === id);
}

export function loadMaterialsFromProject(list: MaterialDef[] | undefined) {
  materials = list?.length ? list.map((m) => ({ ...m })) : [];
  if (!materials.length) ensureDefaultMaterials();
  notify();
}

export function getMaterialsForSave(): MaterialDef[] {
  return materials.map((m) => ({ ...m }));
}
