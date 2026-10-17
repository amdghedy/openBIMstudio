import { realtimeClient } from "./realtime-client";
import { selection } from "../../features/selection";

// Map of element ID -> { clientId, name }
const lockedElements = new Map<string, { clientId: string; name: string }>();

function broadcastLock(ids: string[], action: "lock" | "unlock") {
  if (!realtimeClient.connected) return;
  realtimeClient.sendChange(action, { elementIds: ids });
}

function onSelectionChange() {
  if (!realtimeClient.connected) return;
  
  const snap = selection.snapshot();
  const ids: string[] = [];
  for (const [modelId, set] of Object.entries(snap)) {
    for (const id of set as Set<number>) {
      ids.push(`${modelId}:${id}`);
    }
  }
  
  if (ids.length > 0) {
    broadcastLock(ids, "lock");
  }
}

export function setupWorkshareLocks() {
  selection.onChange(onSelectionChange);

  window.addEventListener("obs:remote-change", (e: Event) => {
    const change = (e as CustomEvent).detail?.change;
    if (!change || !change.payload?.elementIds) return;

    const { type, clientId, payload } = change;
    
    // Find the name of the client who sent this
    const presence = (window as any).__obsLastPresence || [];
    const user = presence.find((p: any) => p.clientId === clientId);
    const name = user ? user.name : "Another User";

    if (type === "lock") {
      for (const id of payload.elementIds) {
        lockedElements.set(id, { clientId, name });
      }
    } else if (type === "unlock") {
      for (const id of payload.elementIds) {
        const existing = lockedElements.get(id);
        if (existing && existing.clientId === clientId) {
          lockedElements.delete(id);
        }
      }
    }
  });

  // Listen to presence to cache the last known names
  window.addEventListener("obs:presence", (e: Event) => {
    (window as any).__obsLastPresence = (e as CustomEvent).detail?.presence || [];
  });

  // Clean up locks if a user disconnects
  window.addEventListener("obs:live-disconnected", () => {
    lockedElements.clear();
  });
}

export function isElementLocked(id: string): boolean {
  const lock = lockedElements.get(id);
  return lock !== undefined && lock.clientId !== realtimeClient.clientId;
}

export function getLockOwner(id: string): string | null {
  const lock = lockedElements.get(id);
  return lock ? lock.name : null;
}
