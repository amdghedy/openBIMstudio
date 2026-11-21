/**
 * Clash worker protocol — shared contract between the main thread and the
 * clash worker (src/workers/clash.worker.ts). Pure types + validation only:
 * no DOM, no THREE, so it is safe to import from both sides and from tests.
 *
 * WHY THE WORKER VALIDATES ITS INPUT
 * ----------------------------------
 * The worker is same-origin and created by the app, so this guards against
 * a buggy caller and against hostile geometry reaching the engine — not a
 * remote attacker. Clash items come from model geometry, and model geometry
 * comes from files: a hostile import that yields an unbounded item list (or
 * NaN boxes, or a triangle buffer of unbounded size) would otherwise OOM or
 * hang the worker with no typed error. Every rejection is a typed
 * `{ type: "error", requestId, message }` reply, so the main thread's
 * pending request rejects instead of hanging.
 *
 * Caps are generous against any real model (the largest clash fixtures in
 * tests use tens of items; a large building is tens of thousands) but bound
 * the worker's allocation: 250,000 items, 1,000,000 triangles (9M floats,
 * 36 MB of Float32 data).
 */
import type {
  ClashKind, ClashMethod, ClashPrecision, ClashProgress, ClashRules,
} from "./clash-core";

/** Hard caps on a single clash run (issue #90). */
export const CLASH_WORKER_MAX_ITEMS = 250_000;
/** Max total triangle floats across all items (9 floats per triangle). */
export const CLASH_WORKER_MAX_TRIANGLE_FLOATS = 9_000_000;
export const CLASH_WORKER_MAX_REQUEST_ID = 256;
export const CLASH_WORKER_MAX_LABEL = 1024;

export const CLASH_METHODS: ReadonlySet<string> = new Set([
  "hard-triangle", "hard-conservative", "convex-gjk", "sphere",
  "center-in-volume", "clearance", "duplicates", "penetration-depth",
]);
export const CLASH_KINDS: ReadonlySet<string> = new Set([
  "intersect", "touching", "clearance", "duplicate",
]);
export const CLASH_PRECISIONS: ReadonlySet<string> = new Set([
  "triangles", "bbox", "hull", "sphere", "center", "duplicate", "depth",
]);
export const CLASH_PHASES: ReadonlySet<string> = new Set([
  "broadphase", "narrowphase", "done",
]);

export interface ClashWorkerItem {
  modelId: string;
  localId: number;
  name: string;
  category: string;
  box: [number, number, number, number, number, number];
  positions?: Float32Array;
}

export interface ClashWorkerRun {
  type: "run";
  requestId: string;
  items: ClashWorkerItem[];
  groups: number[][];
  rules: ClashRules;
  method: ClashMethod;
  selfPairs: boolean;
  sides?: number[];
}

export type ClashWorkerRequestValidation =
  | { ok: true; request: ClashWorkerRun | { type: "cancel"; requestId: string } }
  | { ok: false; requestId: string | null; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown, max = CLASH_WORKER_MAX_LABEL): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function validRequestId(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= CLASH_WORKER_MAX_REQUEST_ID ? v : null;
}

function validBox(v: unknown): v is [number, number, number, number, number, number] {
  if (!Array.isArray(v) || v.length !== 6) return false;
  for (const n of v) if (!isFiniteNumber(n)) return false;
  return v[0] <= v[3] && v[1] <= v[4] && v[2] <= v[5];
}

function validRules(v: unknown): v is ClashRules {
  if (!isRecord(v)) return false;
  for (const k of ["tolerance", "clearance", "lowerBound", "minVolume"] as const) {
    if (!isFiniteNumber(v[k])) return false;
  }
  return typeof v.ignoreIdentical === "boolean" && typeof v.ignoreSameCategory === "boolean";
}

function validGroups(v: unknown): v is number[][] {
  if (!Array.isArray(v)) return false;
  let total = 0;
  for (const g of v) {
    if (!Array.isArray(g)) return false;
    for (const i of g) if (!Number.isSafeInteger(i) || i < 0) return false;
    total += g.length;
    if (total > CLASH_WORKER_MAX_ITEMS) return false;
  }
  return true;
}

/**
 * Validate an incoming clash-worker request before any item is deserialized.
 * Returns the normalized run (or cancel) on success; on failure the worker
 * posts a typed error reply for the requestId when one is recoverable.
 */
export function validateClashWorkerRequest(data: unknown): ClashWorkerRequestValidation {
  if (!isRecord(data)) {
    return { ok: false, requestId: null, message: "The clash worker received a malformed request (expected an object)." };
  }
  const requestId = validRequestId(data.requestId);
  if (requestId === null) {
    return { ok: false, requestId: null, message: "The clash worker received a request without a valid request id." };
  }
  if (data.type === "cancel") return { ok: true, request: { type: "cancel", requestId } };
  if (data.type !== "run") {
    return { ok: false, requestId, message: `The clash worker received an unknown request type (${String(data.type)}).` };
  }
  if (!Array.isArray(data.items)) {
    return { ok: false, requestId, message: "The clash run received items that are not an array." };
  }
  if (data.items.length > CLASH_WORKER_MAX_ITEMS) {
    return { ok: false, requestId, message: `The clash run has ${data.items.length.toLocaleString()} items, over the ${CLASH_WORKER_MAX_ITEMS.toLocaleString()}-item limit.` };
  }
  if (!validGroups(data.groups)) {
    return { ok: false, requestId, message: "The clash run received malformed groups (expected arrays of non-negative integer indices)." };
  }
  if (!validRules(data.rules)) {
    return { ok: false, requestId, message: "The clash run received malformed rules (expected finite tolerance/clearance/lowerBound/minVolume and boolean ignore flags)." };
  }
  if (typeof data.method !== "string" || !CLASH_METHODS.has(data.method)) {
    return { ok: false, requestId, message: `The clash run received an unknown method (${String(data.method)}).` };
  }
  if (typeof data.selfPairs !== "boolean") {
    return { ok: false, requestId, message: "The clash run received a non-boolean selfPairs flag." };
  }
  if (data.sides !== undefined) {
    if (!Array.isArray(data.sides) || data.sides.some((s) => !Number.isSafeInteger(s))) {
      return { ok: false, requestId, message: "The clash run received malformed sides (expected an array of integers)." };
    }
    if (data.sides.length !== data.items.length) {
      return { ok: false, requestId, message: "The clash run received sides whose length does not match the items." };
    }
  }
  let totalFloats = 0;
  const items: ClashWorkerItem[] = [];
  for (let i = 0; i < data.items.length; i++) {
    const s = data.items[i];
    if (!isRecord(s)) return { ok: false, requestId, message: `Clash item ${i} is not an object.` };
    if (!isNonEmptyString(s.modelId)) return { ok: false, requestId, message: `Clash item ${i} has no valid modelId.` };
    if (!Number.isSafeInteger(s.localId)) return { ok: false, requestId, message: `Clash item ${i} has no valid localId.` };
    if (!isNonEmptyString(s.name) || !isNonEmptyString(s.category)) return { ok: false, requestId, message: `Clash item ${i} has no valid name/category.` };
    if (!validBox(s.box)) return { ok: false, requestId, message: `Clash item ${i} has no valid box (expected 6 finite numbers with min <= max).` };
    const item: ClashWorkerItem = {
      modelId: s.modelId as string,
      localId: s.localId as number,
      name: s.name as string,
      category: s.category as string,
      box: s.box as [number, number, number, number, number, number],
    };
    if (s.positions !== undefined) {
      if (!(s.positions instanceof Float32Array)) return { ok: false, requestId, message: `Clash item ${i} has positions that are not a Float32Array.` };
      if (s.positions.length % 9 !== 0) return { ok: false, requestId, message: `Clash item ${i} has a positions buffer whose length is not a multiple of 9.` };
      totalFloats += s.positions.length;
      if (totalFloats > CLASH_WORKER_MAX_TRIANGLE_FLOATS) {
        return { ok: false, requestId, message: `The clash run has over ${(CLASH_WORKER_MAX_TRIANGLE_FLOATS / 9).toLocaleString()} triangles, over the limit.` };
      }
      for (let f = 0; f < s.positions.length; f++) {
        if (!Number.isFinite(s.positions[f])) return { ok: false, requestId, message: `Clash item ${i} has a non-finite triangle coordinate.` };
      }
      item.positions = s.positions;
    }
    items.push(item);
  }
  const run: ClashWorkerRun = {
    type: "run",
    requestId,
    items,
    groups: data.groups as number[][],
    rules: data.rules as ClashRules,
    method: data.method as ClashMethod,
    selfPairs: data.selfPairs as boolean,
    ...(data.sides !== undefined ? { sides: data.sides as number[] } : {}),
  };
  return { ok: true, request: run };
}

/* ── Reply validation (main-thread side) ─────────────────────────────── */
/**
 * A worker reply is trusted only after validation: an unvalidated `result`
 * used to be rehydrated blindly, so a malformed reply (clashes not an
 * array, a 5-number box, a NaN depth) threw inside the message handler and
 * left the pending request hanging. A malformed reply now rejects the
 * pending request and the client terminates the worker (fail-closed).
 */
export interface ClashWorkerClash {
  a: { modelId: string; localId: number; name: string; cat: string };
  b: { modelId: string; localId: number; name: string; cat: string };
  kind: ClashKind;
  method: ClashMethod;
  precision: ClashPrecision;
  depthVol: number;
  triPairs: number;
  minGap: number;
  boxA: [number, number, number, number, number, number];
  boxB: [number, number, number, number, number, number];
  point: [number, number, number] | null;
  contained?: boolean;
}

export type ClashWorkerReply =
  | { type: "progress"; requestId: string; progress: ClashProgress }
  | { type: "result"; requestId: string; clashes: ClashWorkerClash[] }
  | { type: "error"; requestId: string; message: string; stack?: string };

function validRef(v: unknown): v is ClashWorkerClash["a"] {
  return isRecord(v) && isNonEmptyString(v.modelId) && Number.isSafeInteger(v.localId) &&
    isNonEmptyString(v.name) && isNonEmptyString(v.cat);
}

function validClash(v: unknown): v is ClashWorkerClash {
  if (!isRecord(v)) return false;
  if (!validRef(v.a) || !validRef(v.b)) return false;
  if (typeof v.kind !== "string" || !CLASH_KINDS.has(v.kind)) return false;
  if (typeof v.method !== "string" || !CLASH_METHODS.has(v.method)) return false;
  if (typeof v.precision !== "string" || !CLASH_PRECISIONS.has(v.precision)) return false;
  for (const k of ["depthVol", "triPairs", "minGap"] as const) if (!isFiniteNumber(v[k])) return false;
  if (!validBox(v.boxA) || !validBox(v.boxB)) return false;
  if (v.point !== null) {
    if (!Array.isArray(v.point) || v.point.length !== 3) return false;
    for (const n of v.point) if (!isFiniteNumber(n)) return false;
  }
  if (v.contained !== undefined && typeof v.contained !== "boolean") return false;
  return true;
}

export type ClashWorkerReplyValidation =
  | { ok: true; reply: ClashWorkerReply }
  | { ok: false; requestId: string | null; message: string };

export function validateClashWorkerReply(msg: unknown): ClashWorkerReplyValidation {
  if (!isRecord(msg)) {
    return { ok: false, requestId: null, message: "The clash worker returned a malformed response (expected an object)." };
  }
  const requestId = validRequestId(msg.requestId);
  if (requestId === null) {
    return { ok: false, requestId: null, message: "The clash worker returned a response without a valid request id." };
  }
  if (msg.type === "error") {
    if (typeof msg.message !== "string") {
      return { ok: false, requestId, message: "The clash worker returned an error without a message." };
    }
    return { ok: true, reply: { type: "error", requestId, message: msg.message as string,
      ...(typeof msg.stack === "string" ? { stack: msg.stack as string } : {}) } };
  }
  if (msg.type === "progress") {
    const p = msg.progress;
    if (!isRecord(p) || typeof p.phase !== "string" || !CLASH_PHASES.has(p.phase)) {
      return { ok: false, requestId, message: "The clash worker returned a progress update with an unknown phase." };
    }
    for (const k of ["current", "total", "found"] as const) {
      if (!isFiniteNumber(p[k])) return { ok: false, requestId, message: "The clash worker returned a progress update with non-finite counters." };
    }
    return { ok: true, reply: { type: "progress", requestId, progress: p as unknown as ClashProgress } };
  }
  if (msg.type === "result") {
    if (!Array.isArray(msg.clashes)) {
      return { ok: false, requestId, message: "The clash worker returned a result whose clashes are not an array." };
    }
    if (msg.clashes.length > CLASH_WORKER_MAX_ITEMS) {
      return { ok: false, requestId, message: "The clash worker returned more clashes than the run could produce." };
    }
    for (let i = 0; i < msg.clashes.length; i++) {
      if (!validClash(msg.clashes[i])) {
        return { ok: false, requestId, message: `The clash worker returned a malformed clash at index ${i}.` };
      }
    }
    return { ok: true, reply: { type: "result", requestId, clashes: msg.clashes as ClashWorkerClash[] } };
  }
  return { ok: false, requestId, message: `The clash worker returned an unknown response type (${String(msg.type)}).` };
}
