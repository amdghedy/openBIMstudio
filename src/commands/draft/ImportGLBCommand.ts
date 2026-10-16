import { Command } from '../CommandBase';
import { IfcAPI } from 'web-ifc';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import * as THREE from 'three';
import { select } from '../../main';

/**
 * Imports a GLB/GLTF file, creates a separate IFC element for each mesh,
 * and selects the first imported element.
 */
export class ImportGLBCommand extends Command {
  name = 'Import GLB';
  private file: File;
  private createdIds: number[] = [];

  constructor(file: File) {
    super();
    this.file = file;
  }

  async execute() {
    const api = (window as any).ifcAPI as IfcAPI; // assume global reference
    if (!api) throw new Error('IFC API not available');

    const arrayBuffer = await this.file.arrayBuffer();
    const loader = new GLTFLoader();
    const gltf: any = await new Promise((resolve, reject) => {
      loader.parse(arrayBuffer, '', resolve, reject);
    });

    // Find all meshes in the GLB
    const meshes: any[] = [];
    gltf.scene.traverse((obj: any) => {
      if (obj.isMesh) meshes.push(obj);
    });
    if (meshes.length === 0) throw new Error('No mesh found in GLB file');

    for (const mesh of meshes) {
      const placement = await api.CreateAxis2Placement3D({ Location: [0, 0, 0] });
      const shape = await api.CreateIfcShapeRepresentation({
        ContextOfItems: 0,
        RepresentationIdentifier: 'Body',
        RepresentationType: 'SweptSolid',
        Items: [], // Placeholder – real geometry conversion would be added here
      });
      const elem = await api.CreateIfcBuildingElementProxy({ ObjectPlacement: placement, Representation: shape });
      this.createdIds.push(elem.id);
    }

    // Select the first created element for convenience
    if (this.createdIds.length > 0) {
      select(this.createdIds[0]);
    }
    return this.createdIds;
  }

  async undo() {
    const api = (window as any).ifcAPI as IfcAPI;
    for (const id of this.createdIds) {
      await api.DeleteEntity(id);
    }
  }
}
