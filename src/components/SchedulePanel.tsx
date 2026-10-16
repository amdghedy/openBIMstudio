// src/components/SchedulePanel.tsx
import React, { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField } from '@mui/material';
import { useAppDispatch } from '../storeHooks';
import { pushCommand } from '../main';
import { Command } from '../commands/CommandBase';
import { IfcAPI } from 'web-ifc';

/**
 * Very simple schedule export for new M2 element types.
 * Generates a CSV string and triggers a file download.
 */
export const SchedulePanel: React.FC<{ open: boolean; onClose: () => void; api: IfcAPI }> = ({ open, onClose, api }) => {
  const dispatch = useAppDispatch();
  const [title, setTitle] = useState('Stair Schedule');

  const handleExport = async () => {
    // Gather all stairs (example) – real implementation would query IFC for specific types
    const stairs = api.GetAllLines(api.GetModelID(), 'IFCSTAIR');
    const rows = [['ID', 'Rise', 'Run', 'Steps']];
    for (const id of stairs) {
      const line: any = api.GetLine(api.GetModelID(), id);
      rows.push([id.toString(), line.Rise?.value ?? '', line.Run?.value ?? '', line.NumberOfRiser?.value ?? '']);
    }
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/\s+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Export Schedule</DialogTitle>
      <DialogContent>
        <TextField label="Schedule Title" fullWidth margin="dense" value={title} onChange={e => setTitle(e.target.value)} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleExport}>Export CSV</Button>
      </DialogActions>
    </Dialog>
  );
};
