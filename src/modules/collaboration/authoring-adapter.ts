/**
 * Browser adapter for the central binding: translates between the live
 * authoring model (`src/features/authoring.ts`) and the central field maps.
 *
 * Remote field application goes through the validated
 * `applyElementParamChange` path (one call: first changed field as the
 * anchor, the rest as companion `extra` params — the same mechanism the
 * palette uses for anchored dimension edits), so a remote update gets the
 * same validation, geometry rebuild and undo behaviour as a local edit.
 * Level constraints (`baseLevelId`/`topLevelId`) are applied only when the
 * referenced level exists in this project; otherwise they are reported as
 * skipped (the binding pins the field instead of echoing the stale local
 * value back). `name`/`hostId` are root fields, set directly.
 *
 * Remote creation uses the same history-wrapped `createElementByType` the
 * draw tools use, so a materialised wall is a real authored element
 * (defaults, validation, rebuild) — not a synthetic object. The binding
 * translates the central host id to the local host id before calling here.
 */

import { ctx } from "../../core/context";
import {
  applyElementParamChange,
  getElementById,
  getElements,
  getLevels,
  onAuthoringChange,
  removeElementById,
} from "../../features/authoring";
import { getLockOwner, isElementLocked } from "./workshare-locks";
import { getWorksharingEngine } from "./worksharing-engine";
import {
  SYNC_PARAM_KEYS,
  type CentralElementLike,
  type CentralModelAdapter,
} from "./central-binding";

function cloneJson<T>(v: T): T {
  return v === undefined ? (undefined as unknown as T) : JSON.parse(JSON.stringify(v));
}

function toElementLike(el: {
  id: string;
  type: string;
  name: string;
  hostId?: string;
  params: Record<string, unknown>;
}): CentralElementLike {
  return {
    id: el.id,
    type: el.type,
    name: el.name,
    hostId: el.hostId,
    params: cloneJson(el.params || {}),
  };
}

/** Param keys createElementByType accepts for a remote element. */
const CREATE_PARAM_KEYS = [
  "start",
  "end",
  "point",
  "polygon",
  "height",
  "thickness",
  "elevation",
  "width",
  "depth",
  "rotation",
];

function notifyChange(): void {
  try {
    (ctx.features as any)?.authoring?.notifyAuthoringChange?.();
  } catch { /* refresh is best-effort */ }
}

function toast(kind: string, message: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", { detail: { kind, message } }),
    );
  } catch { /* toast is cosmetic */ }
}

export function createAuthoringAdapter(): CentralModelAdapter {
  return {
    listElements(): CentralElementLike[] {
      return getElements().map((el) => toElementLike(el as any));
    },

    getElement(id: string): CentralElementLike | null {
      const el = getElementById(id);
      return el ? toElementLike(el as any) : null;
    },

    getLevels(): Array<{ id: string }> {
      try {
        return getLevels().map((l: any) => ({ id: String(l.id) }));
      } catch {
        return [];
      }
    },

    getActiveWorksetId(): string {
      try {
        return getWorksharingEngine().getActiveWorkset().id || "ws-arch";
      } catch {
        return "ws-arch";
      }
    },

    applyRemoteFields(
      id: string,
      fields: Record<string, unknown>,
    ): { ok: boolean; reason?: string; skippedFields?: string[] } {
      const el = getElementById(id);
      if (!el) return { ok: false, reason: "element_not_found" };
      const skipped: string[] = [];
      const patch: Record<string, unknown> = {};
      let name: string | undefined;
      let hostId: string | undefined;
      let levelIds: Set<string>;
      try {
        levelIds = new Set(getLevels().map((l: any) => String(l.id)));
      } catch {
        levelIds = new Set();
      }
      for (const [k, v] of Object.entries(fields)) {
        if (k === "type") continue; // immutable after creation
        if (k === "name") {
          name = String(v);
          continue;
        }
        if (k === "hostId") {
          hostId = String(v);
          continue;
        }
        if (!(SYNC_PARAM_KEYS as readonly string[]).includes(k)) continue;
        if (
          (k === "baseLevelId" || k === "topLevelId") &&
          v &&
          !levelIds.has(String(v))
        ) {
          // The level does not exist in this project: keep the absolute
          // elevation/height and let the binding pin the constraint.
          skipped.push(k);
          continue;
        }
        patch[k] = cloneJson(v);
      }
      if (name !== undefined && el.name !== name) el.name = name;
      if (hostId !== undefined && el.hostId !== hostId) el.hostId = hostId;
      const keys = Object.keys(patch);
      if (!keys.length) {
        if (name !== undefined || hostId !== undefined) notifyChange();
        return { ok: true, skippedFields: skipped };
      }
      const anchor = keys[0];
      const extra: Record<string, unknown> = { ...patch };
      delete extra[anchor];
      // Values may be Vec2 arrays (start/end/point/polygon); the authoring
      // path assigns them verbatim in its generic branch.
      const r = applyElementParamChange(id, anchor, patch[anchor] as any, extra);
      if (!r.ok) return { ok: false, reason: r.reason, skippedFields: skipped };
      return { ok: true, skippedFields: skipped };
    },

    async createElementFromCentral(
      fields: Record<string, unknown>,
    ): Promise<string | null> {
      const type = String(fields.type || "").trim();
      if (!type) return null;
      const params: Record<string, unknown> = {};
      for (const k of CREATE_PARAM_KEYS) {
        if (fields[k] !== undefined) params[k] = cloneJson(fields[k]);
      }
      try {
        const api = (ctx.features as any)?.authoring;
        if (!api?.createElementByType) return null;
        const hostId =
          typeof fields.hostId === "string" && fields.hostId
            ? fields.hostId
            : undefined;
        const id = await api.createElementByType(type, params, hostId);
        return typeof id === "string" && id ? id : null;
      } catch {
        return null;
      }
    },

    removeElementLocal(id: string): boolean {
      return removeElementById(id);
    },

    subscribeLocalChanges(cb: () => void): () => void {
      return onAuthoringChange(cb);
    },

    isLocallyLocked(id: string): { locked: boolean; owner?: string } | null {
      try {
        if (!isElementLocked(id)) return null;
        return { locked: true, owner: getLockOwner(id) || undefined };
      } catch {
        return null;
      }
    },

    onNotice(kind: "info" | "warn" | "error", message: string): void {
      toast(kind === "error" ? "error" : kind, `[Central] ${message}`);
    },
  };
}
