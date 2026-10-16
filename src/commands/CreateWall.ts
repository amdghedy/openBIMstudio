import { Command } from './CommandBase';
import { IfcAPI } from 'web-ifc';

export interface WallParams {
  start: [number, number, number];
  end: [number, number, number];
  height?: number;
  thickness?: number;
  fireRating?: string;
}

export class CreateWall extends Command {
  name = 'Create Wall';
  private wallId!: number;

  constructor(private api?: IfcAPI, private params?: WallParams) {
    super();
  }

  async execute() {
    if (!this.api || !this.params) throw new Error('IfcAPI or parameters not provided');
    const { start, end, height = 3000, thickness = 200, fireRating } = this.params;
    const profile = await this.api.CreateRectangleProfileDef({ XDim: thickness, YDim: height });
    // direction vector length
    const dir = [end[0] - start[0], end[1] - start[1], end[2] - start[2]] as [number, number, number];
    const length = Math.hypot(...dir);
    const placement = await this.api.CreateAxis2Placement3D({ Location: start });
    const solid = await this.api.CreateExtrudedAreaSolid({
      SweptArea: profile,
      Depth: length,
      ExtrudedDirection: [0, 0, 1],
      Position: placement,
    });
    const wall = await this.api.CreateIfcWallStandardCase({
      ObjectPlacement: placement,
      Representation: {
        Representations: [
          {
            RepresentationIdentifier: 'Body',
            RepresentationType: 'SweptSolid',
            Items: [solid],
          },
        ],
      },
    });
    if (fireRating) {
      const pset = await this.api.CreatePropertySet('Pset_FireRating', [
        { Name: 'FireRating', NominalValue: fireRating },
      ]);
      await this.api.AssignPropertySet(wall, pset);
    }
    this.wallId = wall.id;
    return this.wallId;
  }

  async undo() {
    await this.api!.DeleteEntity!(this.wallId);
  }
}
