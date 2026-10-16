// src/components/CalloutTool.tsx
import React, { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField } from '@mui/material';
import { useAppDispatch } from '../storeHooks';
import { pushCommand } from '../main';
import { Command } from '../commands/CommandBase';
import { IfcAPI } from 'web-ifc';
import * as THREE from 'three';

/**
 * Simple call‑out creation tool – places a leader line and a text label.
 * In a full implementation the call‑out would be a 2‑D annotation stored as an
 * IfcAnnotation (or custom JSON) attached to the viewport.
 */
export const CalloutTool: React.FC<{ api: IfcAPI; open: boolean; onClose: () => void }> = ({ api, open, onClose }) => {
  const [text, setText] = useState('');
  const dispatch = useAppDispatch();

  const handleCreate = async () => {
    // Hard‑coded leader points for demo
    const start: [number, number, number] = [0, 0, 0];
    const end: [number, number, number] = [2000, 2000, 0];
    class CalloutCommand extends Command {
      name = 'Callout';
      private annotationId!: number;
      async execute() {
        const lineShape = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(...start),
          new THREE.Vector3(...end),
        ]);
        const placement = await api.CreateAxis2Placement3D({ Location: start });
        const shape = await api!.CreateIfcShapeRepresentation!({
          ContextOfItems: 0,
          RepresentationIdentifier: 'Annotation',
          RepresentationType: 'Annotation2D',
          Items: [{ type: 'IfcPolyline', Points: [start, end] }],
        });
        const annotation = await api!.CreateIfcAnnotation!({ ObjectPlacement: placement, Representation: shape, AnnotationText: { value: text } });
        this.annotationId = annotation.id;
        return this.annotationId;
      }
      async undo() { await api.DeleteEntity(this.annotationId); }
    }
    const cmd = new CalloutCommand();
    await cmd.execute();
    dispatch(pushCommand(cmd));
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Create Callout</DialogTitle>
      <DialogContent>
        <TextField label="Callout Text" fullWidth margin="dense" value={text} onChange={e => setText(e.target.value)} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleCreate}>Create</Button>
      </DialogActions>
    </Dialog>
  );
};
