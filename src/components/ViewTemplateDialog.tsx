// src/components/ViewTemplateDialog.tsx
import React, { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Select, MenuItem } from '@mui/material';
import { useAppDispatch } from '../storeHooks';
import { pushCommand } from '../main';
import { Command } from '../commands/CommandBase';
import { IfcAPI } from 'web-ifc';

/**
 * Simple UI to edit a view‑template (visibility/graphics settings).
 * The command stores the template data in a custom property set on the view element.
 */
export const ViewTemplateDialog: React.FC<{ open: boolean; onClose: () => void; api: IfcAPI }> = ({ open, onClose, api }) => {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('default');
  const dispatch = useAppDispatch();

  const handleSave = () => {
    class ViewTemplateCommand extends Command {
      name = 'Save View Template';
      async execute() {
        const viewId = 0;
        const pset = await api.CreatePropertySet('Pset_ViewTemplate', [
          { Name: 'TemplateName', NominalValue: name },
          { Name: 'VisibilityMode', NominalValue: visibility },
        ]);
        await api.AssignPropertySet({ id: viewId } as any, pset);
      }
      async undo() { /* no‑op */ }
    }
    const cmd = new ViewTemplateCommand();
    cmd.execute();
    dispatch(pushCommand(cmd));
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>View Template</DialogTitle>
      <DialogContent>
        <TextField label="Template Name" fullWidth margin="dense" value={name} onChange={e => setName(e.target.value)} />
        <Select label="Visibility" fullWidth value={visibility} onChange={e => setVisibility(e.target.value as string)}>
          <MenuItem value="default">Default</MenuItem>
          <MenuItem value="hideWalls">Hide Walls</MenuItem>
          <MenuItem value="showOnlyStructure">Structure Only</MenuItem>
        </Select>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave}>Save</Button>
      </DialogActions>
    </Dialog>
  );
};
