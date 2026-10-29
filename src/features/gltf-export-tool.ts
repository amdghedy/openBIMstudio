/**
 * High-Speed glTF / GLB Native Twin Exporter UI & Command
 *
 * Direct binary export of authored native twins, parametric elements, and IFC properties
 * to glTF 2.0 binary (.glb) containers for web, mobile AR, and rendering engines.
 */

import {
  exportNativeTwinToGlb,
  createBoxGeometry,
  type NativeTwinGlbElement,
} from "../modules/export/gltf-native-twin";
import { getElements } from "./authoring";
import { registerCommand } from "./command-palette";

export function exportNativeTwinGlbAction(): void {
  try {
    let elements: any[] = [];
    try {
      elements = (getElements() as any[]) || [];
    } catch {
      elements = [];
    }

    const glbElements: NativeTwinGlbElement[] = [];

    if (elements.length > 0) {
      for (const el of elements) {
        const width = el.params?.width || el.params?.thickness || 0.2;
        const height = el.params?.height || el.params?.unconnectedHeight || 3.0;
        const length = el.curve
          ? Math.hypot(el.curve.end[0] - el.curve.start[0], el.curve.end[1] - el.curve.start[1])
          : el.params?.length || 1.0;

        const box = createBoxGeometry(length, height, width);
        const posX = el.position ? el.position[0] : 0;
        const posY = (el.position ? el.position[1] : 0);
        const posZ = el.params?.baseOffset || 0;

        glbElements.push({
          id: el.id,
          name: el.name || `${el.categoryId || "Element"}_${el.id}`,
          category: el.categoryId || "IfcBuildingElementProxy",
          position: [posX, posZ, posY], // convert to Three.js Y-up
          geometry: {
            positions: box.positions,
            indices: box.indices,
            normals: box.normals,
          },
          properties: {
            categoryId: el.categoryId,
            pinned: el.pinned,
            ...el.params,
          },
        });
      }
    } else {
      // Demo proxy twin element if scene is empty
      const box = createBoxGeometry(4.0, 3.0, 0.2);
      glbElements.push({
        id: "demo-arc-wall-twin",
        name: "Demo Twin Element",
        category: "IfcWall",
        position: [0, 1.5, 0],
        geometry: {
          positions: box.positions,
          indices: box.indices,
          normals: box.normals,
        },
        properties: {
          material: "Cast-in-Place Concrete",
          fireRating: "2hr",
          loadBearing: true,
        },
      });
    }

    const glbBuffer = exportNativeTwinToGlb(glbElements, {
      generator: "openBIMstudio Native Twin glTF Exporter v1.0",
      embedPropertiesAsExtras: true,
    });

    // Trigger download in browser
    const blob = new Blob([glbBuffer.buffer as ArrayBuffer], { type: "model/gltf-binary" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `native_twin_export_${Date.now()}.glb`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    alert(`Successfully exported ${glbElements.length} element(s) to GLB container (${(glbBuffer.byteLength / 1024).toFixed(1)} KB).`);
  } catch (err: any) {
    alert(`GLB export failed: ${err?.message || err}`);
  }
}

// Register palette command
registerCommand({
  id: "export.native_twin_glb",
  label: "Export: Native Twin Model to glTF / GLB 3D",
  category: "Export",
  hint: "Direct binary export of native twins and IFC property sets to GLB for web, AR, and rendering",
  run: () => exportNativeTwinGlbAction(),
});
