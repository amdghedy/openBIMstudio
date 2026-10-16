// src/components/AutoDimension.tsx
import React from 'react';
import { Button } from '@mui/material';
import { useAppDispatch } from '../storeHooks';
import { pushCommand } from '../main';
import { Command } from '../commands/CommandBase';
import { IfcAPI } from 'web-ifc';
import * as THREE from 'three';

/**
 * Simple auto‑dimension tool that creates a dimension line between two selected points.
 * In a full UI it would compute the nearest geometry, place a leader, and add a text label.
 */
export const AutoDimension: React.FC<{ api: IfcAPI }> = ({ api }) => {
  const dispatch = useAppDispatch();

  const handleDimension = async () => {
    // Placeholder – use two hard coded points
    const p1: [number, number, number] = [0, 0, 0];
    const p2: [number, number, number] = [5000, 0, 0];
    class DimCommand extends Command {
      name = 'Auto Dimension';
      private dimId!: number;
      async execute() {
        const lineGeom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(...p1),
          new THREE.Vector3(...p2),
        ]);
        const placement = await api.CreateAxis2Placement3D({ Location: [0, 0, 0] });
        const shape = await api!.CreateIfcShapeRepresentation!({
          ContextOfItems: 0,
          RepresentationIdentifier: 'Annotation',
          RepresentationType: 'DimensionCurve',
          Items: [{ type: 'IfcPolyline', Points: [p1, p2] }],
        });
        const dim = await api!.CreateIfcDimensionCurve!({ ObjectPlacement: placement, Representation: shape });
        this.dimId = dim.id;
        return this.dimId;
      }
      async undo() { await api.DeleteEntity(this.dimId); }
    }
    const cmd = new DimCommand();
    await cmd.execute();
    dispatch(pushCommand(cmd));
  };

  return <Button variant="contained" onClick={handleDimension}>Auto‑Dimension</Button>;
};
