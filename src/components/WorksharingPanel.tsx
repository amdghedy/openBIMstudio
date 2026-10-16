// src/components/WorksharingPanel.tsx
import React, { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, List, ListItem, ListItemText } from '@mui/material';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IfcAPI } from 'web-ifc';

/**
 * Minimal UI to show element‑level lock status using Y‑js.
 * Each element gets a lock entry in a Y‑Map: { elementId: userId }.
 * When the current user selects an element, we attempt to acquire the lock.
 */
export const WorksharingPanel: React.FC<{ open: boolean; onClose: () => void; api: IfcAPI }> = ({ open, onClose, api }) => {
  const [ydoc] = useState(() => new Y.Doc());
  const [provider] = useState(() => new WebsocketProvider('wss://yjs.dev:1234', 'openbimstudio-room', ydoc));
  const locks = ydoc.getMap('elementLocks');
  const [lockedElements, setLockedElements] = useState<Array<{ id: number; user: string }>>([]);

  useEffect(() => {
    const update = () => {
      const arr: Array<{ id: number; user: string }> = [];
      locks.forEach((user, id) => arr.push({ id: Number(id), user: user as string }));
      setLockedElements(arr);
    };
    locks.observe(update);
    return () => locks.unobserve(update);
  }, [locks]);

  const attemptLock = (elemId: number) => {
    const myId = 'user-' + Math.random().toString(36).substring(2, 8);
    const current = locks.get(elemId.toString());
    if (!current) {
      locks.set(elemId.toString(), myId);
      alert(`Locked element ${elemId}`);
    } else {
      alert(`Element ${elemId} already locked by ${current}`);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Worksharing – Element Locks</DialogTitle>
      <DialogContent>
        <List>
          {lockedElements.map(l => (
            <ListItem key={l.id}>
              <ListItemText primary={`Element ${l.id}`} secondary={`Locked by ${l.user}`} />
            </ListItem>
          ))}
        </List>
        <Button variant="contained" onClick={() => attemptLock(1)}>Lock Element 1 (demo)</Button>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};
