// src/components/AdaptiveComponentEditor.tsx
import React from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField } from '@mui/material';
import { useAppDispatch } from '../storeHooks';
import { pushCommand } from '../main';
import { Command } from '../commands/CommandBase';
import { IfcAPI } from 'web-ifc';
import * as THREE from 'three';

/**
 * A placeholder UI for creating Adaptive Components.
 * Users specify a host element ID and a rule (simple JavaScript expression).
 * The rule will be evaluated at runtime to modify geometry based on host size.
 */
export const AdaptiveComponentEditor: React.FC<{ open: boolean; onClose: () => void; api: IfcAPI }> = ({ open, onClose, api }) => {
  const [hostId, setHostId] = React.useState('');
  const [rule, setRule] = React.useState('size * 0.5'); // very simple placeholder
  const dispatch = useAppDispatch();

  const handleCreate = () => {
    class AdaptiveCommand extends Command {
      name = 'Adaptive Component';
      private createdId!: number;
      async execute() {
        const host = api.GetLine(api.GetModelID(), Number(hostId)); // simplistic
        const size = (host?.BoundingBox?.[0]?.value ?? 1) as number; // placeholder
        const factor = eval(rule); // unsafe – only for demo
        const geometry = new THREE.BoxGeometry(factor, factor, factor);
        const placement = await api.CreateAxis2Placement3D({ Location: [0, 0, 0] });
        const shape = await api!.CreateIfcShapeRepresentation!({
          ContextOfItems: 0,
          RepresentationIdentifier: 'Body',
          RepresentationType: 'SweptSolid',
          Items: [{ type: 'IfcFacetedBrep', geometry }],
        });
        const elem = await api!.CreateIfcBuildingElementProxy!({ ObjectPlacement: placement, Representation: shape });
        this.createdId = elem.id;
        return this.createdId;
      }
      async undo() { await api.DeleteEntity(this.createdId); }
    }
    const cmd = new AdaptiveCommand();
    cmd.execute();
    dispatch(pushCommand(cmd));
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Adaptive Component</DialogTitle>
      <DialogContent>
        <TextField label="Host Element ID" fullWidth margin="dense" value={hostId} onChange={e => setHostId(e.target.value)} />
        <TextField label="Rule (JS expression)" fullWidth margin="dense" value={rule} onChange={e => setRule(e.target.value)} helperText='Use "size" variable representing host size' />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleCreate}>Create</Button>
      </DialogActions>
    </Dialog>
  );
};
