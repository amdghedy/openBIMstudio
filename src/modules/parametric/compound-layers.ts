/**
 * Compound Multi-Layer Assembly Engine.
 *
 * Models layered building elements (slabs, roofs, ceilings, walls) with distinct
 * structural vs finish thicknesses for accurate quantities and IFC material layer sets.
 */

export type LayerFunction =
  | "structure"
  | "substrate"
  | "thermal-air"
  | "membrane"
  | "finish-1"
  | "finish-2";

export interface CompoundLayerSpec {
  id: string;
  name: string;
  materialName: string;
  thicknessM: number;
  function: LayerFunction;
  priority: number; // 1 (structure) to 5 (finish)
}

export interface CompoundAssembly {
  id: string;
  name: string;
  layers: CompoundLayerSpec[];
  totalThicknessM: number;
  structuralThicknessM: number;
  finishThicknessM: number;
}

export function createCompoundAssembly(
  name: string,
  layers: Omit<CompoundLayerSpec, "id">[]
): CompoundAssembly {
  let totalT = 0;
  let structT = 0;
  let finishT = 0;

  const fullLayers: CompoundLayerSpec[] = layers.map((l, i) => {
    totalT += l.thicknessM;
    if (l.function === "structure") structT += l.thicknessM;
    if (l.function === "finish-1" || l.function === "finish-2") finishT += l.thicknessM;

    return {
      ...l,
      id: `lyr-${i + 1}`,
    };
  });

  return {
    id: `assembly-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    name,
    layers: fullLayers,
    totalThicknessM: Math.round(totalT * 1000) / 1000,
    structuralThicknessM: Math.round(structT * 1000) / 1000,
    finishThicknessM: Math.round(finishT * 1000) / 1000,
  };
}

export function toIfcMaterialLayerSet(assembly: CompoundAssembly): object {
  return {
    type: "IfcMaterialLayerSet",
    LayerSetName: assembly.name,
    TotalThickness: assembly.totalThicknessM,
    MaterialLayers: assembly.layers.map((l) => ({
      type: "IfcMaterialLayer",
      Name: l.name,
      LayerThickness: l.thicknessM,
      IsVentilated: l.function === "thermal-air",
      Material: {
        type: "IfcMaterial",
        Name: l.materialName,
      },
    })),
  };
}
