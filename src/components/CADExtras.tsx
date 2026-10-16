// src/components/CADExtras.tsx
import React from 'react';
import { Button } from '@mui/material';
import { useAppDispatch } from '../storeHooks';
import { pushCommand } from '../main';
import { Command } from '../commands/CommandBase';
import { IfcAPI } from 'web-ifc';

/**
 * Placeholder UI for optional CAD extras: hatch, block/XREF, chamfer.
 * Each command logs a message – a full implementation would extend the CAD engine.
 */
export const CADExtras: React.FC<{ api: IfcAPI }> = ({ api }) => {
  const dispatch = useAppDispatch();

  const runCommand = (name: string, fn: () => void) => {
    class ExtraCommand extends Command {
      name = name;
      async execute() { fn(); }
      async undo() { /* no‑op */ }
    }
    const cmd = new ExtraCommand();
    cmd.execute();
    dispatch(pushCommand(cmd));
  };

  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
      <Button variant="outlined" onClick={() => runCommand('Hatch Fill', () => console.log('Hatch fill not implemented'))}>Hatch Fill</Button>
      <Button variant="outlined" onClick={() => runCommand('Block Insert', () => console.log('Block insert not implemented'))}>Insert Block</Button>
      <Button variant="outlined" onClick={() => runCommand('Chamfer', () => console.log('Chamfer not implemented'))}>Chamfer</Button>
    </div>
  );
};
