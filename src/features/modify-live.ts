/**
 * Viewport wiring for the Revit-parity Modification Command Framework.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { history } from "./history";
import {
  CommandHost,
  type ModifyStatus,
  type PointerSample,
} from "../modules/modify/interaction";
import {
  getElements,
  getSelectedIds,
  selectAllAuthored,
  rebuildAuthored,
  getAuthoredGroup,
} from "./authoring";

function shiftElParams(el: any, dx: number, dz: number): void {
  if (el.params?.start) el.params.start = [el.params.start[0] + dx, el.params.start[1] + dz];
  if (el.params?.end) el.params.end = [el.params.end[0] + dx, el.params.end[1] + dz];
  if (el.params?.point) el.params.point = [el.params.point[0] + dx, el.params.point[1] + dz];
  if (el.params?.polygon) {
    el.params.polygon = el.params.polygon.map((p: number[]) => [p[0] + dx, p[1] + dz]);
  }
  if (el.transform?.position) {
    el.transform.position[0] += dx;
    el.transform.position[2] += dz;
  }
}

let host: CommandHost | null = null;
let installed = false;

function notifyStatus(status: ModifyStatus): void {
  try {
    const label = (window as any).__obsActiveToolLabel as HTMLElement | undefined;
    if (label && status.prompt) {
      label.textContent = `Active Tool: ${status.tool ? status.tool[0].toUpperCase() + status.tool.slice(1) : "None"} · ${status.prompt}`;
    }
  } catch { /* */ }
  try {
    window.dispatchEvent(new CustomEvent("obs-status", { detail: { text: status.prompt, state: status.state, tool: status.tool } }));
    window.dispatchEvent(new CustomEvent("obs-modify-state", { detail: status }));
  } catch { /* */ }
}

function collectMeshes(ids: string[]): Map<string, THREE.Object3D[]> {
  const map = new Map<string, THREE.Object3D[]>();
  try {
    const group = typeof getAuthoredGroup === "function" ? getAuthoredGroup() : null;
    const root: THREE.Object3D | null = (group as any) ?? ctx.world?.scene ?? null;
    if (!root) return map;
    const idSet = new Set(ids);
    root.traverse((o: any) => {
      const id = o.userData?.elementId;
      if (!id || !idSet.has(id)) return;
      if (!(o.isMesh || o.userData?.elementRoot)) return;
      const arr = map.get(id) ?? [];
      arr.push(o);
      map.set(id, arr);
    });
  } catch { /* */ }
  return map;
}

function buildMoveApi() {
  return {
    getSelection: () => getSelectedIds(),
    resolveElements: (ids: string[]) => {
      const els = getElements();
      return ids
        .map((id) => els.find((e) => e.id === id))
        .filter(Boolean)
        .map((e: any) => ({ id: e.id, name: e.name ?? e.type, pinned: !!e.properties?.pinned }));
    },
    buildTransaction: (ids: string[], dx: number, dz: number, mode: "move" | "copy") => {
      const els = getElements();
      const targets = ids
        .map((id) => els.find((e) => e.id === id))
        .filter((e): e is any => !!e && !e.properties?.pinned);
      if (!targets.length) return null;

      if (mode === "copy") {
        const clones = targets.map((src) => {
          const c = JSON.parse(JSON.stringify(src));
          c.id = `el_${Math.random().toString(36).slice(2, 10)}`;
          c.name = `${src.name ?? src.type} (copy)`;
          if (c.hostId) delete c.hostId;
          shiftElParams(c, dx, dz);
          return c;
        });
        const cloneIds = clones.map((c: any) => c.id);
        return {
          label: targets.length === 1 ? `Copy ${targets[0].name}` : `Copy ${targets.length} elements`,
          apply: () => {
            const list = getElements() as any[];
            for (const c of clones) {
              if (!list.find((x) => x.id === c.id)) list.push(c);
            }
            rebuildAuthored();
          },
          revert: () => {
            const list = getElements() as any[];
            for (const id of cloneIds) {
              const i = list.findIndex((x) => x.id === id);
              if (i >= 0) list.splice(i, 1);
            }
            rebuildAuthored();
          },
        };
      }

      const before = targets.map((t) => JSON.parse(JSON.stringify(t.params)));
      const beforeXform = targets.map((t) => (t.transform ? JSON.parse(JSON.stringify(t.transform)) : null));
      for (const t of targets) shiftElParams(t, dx, dz);
      const after = targets.map((t) => JSON.parse(JSON.stringify(t.params)));
      const afterXform = targets.map((t) => (t.transform ? JSON.parse(JSON.stringify(t.transform)) : null));
      targets.forEach((t, i) => {
        t.params = JSON.parse(JSON.stringify(before[i]));
        if (beforeXform[i]) t.transform = JSON.parse(JSON.stringify(beforeXform[i]));
      });

      return {
        label: targets.length === 1 ? `Move ${targets[0].name}` : `Move ${targets.length} elements`,
        apply: () => {
          targets.forEach((t, i) => {
            t.params = JSON.parse(JSON.stringify(after[i]));
            if (afterXform[i]) t.transform = JSON.parse(JSON.stringify(afterXform[i]));
          });
          rebuildAuthored();
        },
        revert: () => {
          targets.forEach((t, i) => {
            t.params = JSON.parse(JSON.stringify(before[i]));
            if (beforeXform[i]) t.transform = JSON.parse(JSON.stringify(beforeXform[i]));
          });
          rebuildAuthored();
        },
      };
    },
  };
}

function ensureHost(): CommandHost {
  if (host) return host;
  host = new CommandHost({
    getScene: () => ctx.world?.scene ?? null,
    collectMeshes,
    historyPush: (cmd) => {
      history.push({
        label: cmd.label,
        apply: () => { cmd.apply(); },
        revert: () => { cmd.revert(); },
      });
      try { cmd.apply(); } catch (e) { console.warn("[modify-live] apply failed", e); }
    },
    onStatus: notifyStatus,
    moveApi: buildMoveApi(),
    getSelection: () => getSelectedIds(),
    clearSelection: () => selectAllAuthored([]),
  });
  return host;
}

export function startLiveMove(mode: "move" | "copy" = "move"): boolean {
  return ensureHost().startMove(getSelectedIds(), mode);
}

export function isModifyLiveActive(): boolean {
  return !!host?.isActive();
}

export function modifyLiveEscape(): boolean {
  return host?.onEscape() ?? false;
}

export function modifyLiveKey(e: KeyboardEvent): boolean {
  if (!host?.isActive()) return false;
  return host.onKey({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, code: e.code });
}

export function modifyLivePointerMove(e: PointerEvent, world: { x: number; z: number; y?: number }): void {
  if (!host?.isActive()) return;
  host.onPointerMove({
    world: { x: world.x, z: world.z, y: world.y },
    screenX: e.clientX, screenY: e.clientY,
    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, button: e.buttons,
  });
}

export function modifyLiveClick(e: MouseEvent, world: { x: number; z: number; y?: number }): void {
  if (!host?.isActive()) return;
  host.onClick({
    world: { x: world.x, z: world.z, y: world.y },
    screenX: e.clientX, screenY: e.clientY,
    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, button: e.button,
  });
}

export function stopModifyLive(): void {
  host?.stop();
}

export function setupModifyLive(): void {
  if (installed) return;
  installed = true;
  ensureHost();
  (window as any).__obsStartLiveMove = () => startLiveMove("move");
  (window as any).__obsStartLiveCopy = () => startLiveMove("copy");
  (window as any).__obsModifyLive = {
    startMove: () => startLiveMove("move"),
    startCopy: () => startLiveMove("copy"),
    stop: stopModifyLive,
    isActive: isModifyLiveActive,
  };
  console.log("[modify-live] Revit-parity command host ready (Move/Copy)");
}
