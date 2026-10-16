// src/modules/curtainWall/panelTypes.ts
import { IfcAPI } from 'web-ifc';
import * as THREE from 'three';

/**
 * Generate a curtain‑wall panel of a given type.
 * Types could be "solid", "glazed", "perforated" etc.
 * This stub returns an IfcWindow representing a panel.
 */
export async function createCurtainWallPanel(api: IfcAPI, type: string, width: number, height: number): Promise<number> {
  let geometry: THREE.Mesh;
  if (type === 'glazed') {
    geometry = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.02), new THREE.MeshBasicMaterial({ color: 0x9fd9ff, transparent: true, opacity: 0.3 }));
  } else if (type === 'solid') {
    geometry = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.1), new THREE.MeshStandardMaterial({ color: 0x777777 }));
  } else {
    // default simple panel
    geometry = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.05), new THREE.MeshStandardMaterial({ color: 0xaaaaaa }));
  }
  const placement = await api.CreateAxis2Placement3D({ Location: [0, 0, 0] });
  const shape = await api.CreateIfcShapeRepresentation({
    ContextOfItems: 0,
    RepresentationIdentifier: 'Body',
    RepresentationType: 'SweptSolid',
    Items: [{ type: 'IfcFacetedBrep', geometry }],
  });
  const panel = await api!.CreateIfcWindow!({ ObjectPlacement: placement, Representation: shape });
  return panel.id;
}
