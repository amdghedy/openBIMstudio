// src/commands/CreateStairAdvanced.ts
import { Command } from './CommandBase';
import { IfcAPI } from 'web-ifc';
import * as THREE from 'three';

/**
 * Advanced stair generator that creates separate tread and riser elements.
 * For demo purposes we only create a simple monolithic geometry but expose
 * a clear extension point for generating multiple IFC elements.
 */
export class CreateStairAdvanced extends Command {
  name = 'Create Advanced Stair';
  private stairIds: number[] = [];
  constructor(private api?: IfcAPI, private params?: {
    base: [number, number, number];
    direction: [number, number, number];
    rise: number;
    run: number;
    treadDepth: number;
    treadWidth: number;
    numSteps: number;
  }) { super(); }

  async execute() {
    if (!this.api || !this.params) throw new Error('IfcAPI or parameters not provided');
    const { base, direction, rise, run, treadDepth, treadWidth, numSteps } = this.params!;
    for (let i = 0; i < numSteps; i++) {
      const stepGeometry = new THREE.BoxGeometry(treadWidth, rise, treadDepth);
      const placement = await this.api.CreateAxis2Placement3D({
        Location: [base[0] + direction[0] * (i * treadDepth), base[1] + i * rise, base[2]],
        // orientation omitted for brevity
      });
      const shape = await this.api.CreateIfcShapeRepresentation({
        ContextOfItems: 0,
        RepresentationIdentifier: 'Body',
        RepresentationType: 'SweptSolid',
        Items: [{ type: 'IfcFacetedBrep', geometry: stepGeometry }],
      });
      const elem = await this.api.CreateIfcBuildingElementProxy({ ObjectPlacement: placement, Representation: shape });
      this.stairIds.push(elem.id);
    }
    return this.stairIds;
  }

  async undo() {
    for (const id of this.stairIds) {
      await this.api!.DeleteEntity!(id);
    }
  }
}
