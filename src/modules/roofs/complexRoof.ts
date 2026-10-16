// src/modules/roofs/complexRoof.ts
import { IfcAPI } from 'web-ifc';
import * as THREE from 'three';

/**
 * Generate a sloped roof with hip/valley support.
 * This is a stub – a real implementation would perform polygon triangulation
 * of the roof footprint, then create individual IfcRoof/IfcSlab elements for each
 * planar facet.
 */
export async function createComplexRoof(api: IfcAPI, footprint: Array<[number, number, number]>, pitchDeg: number, hipAngleDeg?: number): Promise<number> {
  // Convert pitch to a normal vector
  const rad = (pitchDeg * Math.PI) / 180;
  const height = Math.tan(rad);
  // Simple extrude the footprint along Z with the computed slope
  const shape = new THREE.Shape(footprint.map(p => new THREE.Vector2(p[0], p[1])));
  const extrude = new THREE.ExtrudeGeometry(shape, { depth: 0, bevelEnabled: false });
  // Apply a shear matrix to simulate pitch (placeholder)
  const matrix = new THREE.Matrix4().makeShear(0, 0, 0, height, 0, 0);
  extrude.applyMatrix4(matrix);
  const placement = await api.CreateAxis2Placement3D({ Location: [0, 0, 0] });
  const shapeRep = await api.CreateIfcShapeRepresentation({
    ContextOfItems: 0,
    RepresentationIdentifier: 'Body',
    RepresentationType: 'SweptSolid',
    Items: [{ type: 'IfcFacetedBrep', geometry: extrude }],
  });
  const roof = await api!.CreateIfcRoof!({ ObjectPlacement: placement, Representation: shapeRep });
  return roof.id;
}
