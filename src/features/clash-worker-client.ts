/**
 * Clash worker client.
 *
 * Spawns the worker once, reuses it, falls back to main-thread engine if
 * the worker cannot be created. Public API mirrors runClashEngine.
 */
import * as THREE from "three";
import {
  collectItems,
  runClashEngine,
  type ClashInput,
  type ClashRunOptions,
} from "./clash-engine";
import {
  DEFAULT_CLASH_RULES,
  type ClashMethod,
  type ClashProgress,
  type ClashRules,
  type ElementClash,
} from "../modules/clash/clash-core";
import type { ClashCoreItem } from "../modules/clash/clash-core";

// -- Unified cancel signal -----------------------------------------------
// Supports both W3C AbortSignal and the legacy { cancelled: boolean } shape
// used by older ClashRunOptions callers.
type CancelSignal =
  | { cancelled: boolean }
  | AbortSignal
  | undefined;

function isAbortSignal(s: CancelSignal): s is AbortSignal {
  return !!s && typeof (s as AbortSignal).addEventListener === "function";
}

function isCancelled(s: CancelSignal): boolean {
  if (!s) return false;
  if (isAbortSignal(s)) return s.aborted;
  return (s as { cancelled: boolean }).cancelled === true;
}

type InMessage =
  | { type: "progress"; requestId: string; progress: ClashProgress }
  | {
      type: "result";
      requestId: string;
      clashes: Array<{
        a: ElementClash["a"];
        b: ElementClash["b"];
        kind: ElementClash["kind"];
        method: ElementClash["method"];
        precision: ElementClash["precision"];
        depthVol: number;
        triPairs: number;
        minGap: number;
        boxA: [number, number, number, number, number, number];
        boxB: [number, number, number, number, number, number];
        point: [number, number, number] | null;
      }>;
    }
  | { type: "error"; requestId: string; message: string; stack?: string };

type OutMessage =
  | {
      type: "run";
      requestId: string;
      items: unknown[];
      groups: unknown;
      rules: ClashRules;
      method: ClashMethod;
      selfPairs: boolean;
    }
  | { type: "cancel"; requestId: string };

interface Pending {
  resolve: (clashes: ElementClash[]) => void;
  reject: (err: unknown) => void;
  onProgress?: (p: ClashProgress) => void;
}

let worker: Worker | null = null;
let workerFailed = false;
const pending = new Map<string, Pending>();
let nextRequestId = 0;

function spawnWorker(): Worker | null {
  if (worker) return worker;
  if (workerFailed) return null;
  try {
    worker = new Worker(new URL("../workers/clash.worker.ts", import.meta.url), {
      type: "module",
      name: "obs-clash-worker",
    });
    worker.addEventListener("message", onWorkerMessage);
    worker.addEventListener("error", onWorkerError);
    console.log("[clash-worker] spawned");
    return worker;
  } catch (err) {
    workerFailed = true;
    console.warn("[clash-worker] could not spawn — using main thread", err);
    return null;
  }
}

type SerializedClash = {
  a: ElementClash["a"];
  b: ElementClash["b"];
  kind: ElementClash["kind"];
  method: ElementClash["method"];
  precision: ElementClash["precision"];
  depthVol: number;
  triPairs: number;
  minGap: number;
  boxA: [number, number, number, number, number, number];
  boxB: [number, number, number, number, number, number];
  point: [number, number, number] | null;
};

function rehydrateClash(s: SerializedClash): ElementClash {
  const boxA = new THREE.Box3(
    new THREE.Vector3(s.boxA[0], s.boxA[1], s.boxA[2]),
    new THREE.Vector3(s.boxA[3], s.boxA[4], s.boxA[5]),
  );
  const boxB = new THREE.Box3(
    new THREE.Vector3(s.boxB[0], s.boxB[1], s.boxB[2]),
    new THREE.Vector3(s.boxB[3], s.boxB[4], s.boxB[5]),
  );
  const point = s.point
    ? new THREE.Vector3(s.point[0], s.point[1], s.point[2])
    : null;
  return {
    a: s.a,
    b: s.b,
    kind: s.kind,
    method: s.method,
    precision: s.precision,
    depthVol: s.depthVol,
    triPairs: s.triPairs,
    minGap: s.minGap,
    boxA,
    boxB,
    point,
  };
}

function onWorkerMessage(e: MessageEvent<InMessage>): void {
  const msg = e.data;
  const p = pending.get(msg.requestId);
  if (!p) return;

  if (msg.type === "progress") {
    p.onProgress?.(msg.progress);
    return;
  }
  if (msg.type === "result") {
    pending.delete(msg.requestId);
    p.resolve(msg.clashes.map(rehydrateClash));
    return;
  }
  if (msg.type === "error") {
    pending.delete(msg.requestId);
    console.error("[clash-worker] error from worker", msg.message, msg.stack);
    p.reject(new Error(msg.message));
  }
}

function onWorkerError(e: ErrorEvent): void {
  console.error("[clash-worker] fatal worker error", e.message, e.error);
  workerFailed = true;
  worker?.terminate();
  worker = null;
  const reason = new Error(`Clash worker crashed: ${e.message}`);
  for (const [, p] of pending) p.reject(reason);
  pending.clear();
}

function serializeItem(item: ClashCoreItem): {
  payload: unknown;
  transfer: Transferable[];
} {
  const min = item.box.min;
  const max = item.box.max;
  const box: [number, number, number, number, number, number] = [
    min.x, min.y, min.z, max.x, max.y, max.z,
  ];

  let positions: Float32Array | undefined;
  const transfer: Transferable[] = [];

  if (item.tris?.length) {
    const total = item.tris.length * 9;
    positions = new Float32Array(total);
    let n = 0;
    for (const t of item.tris) {
      for (let i = 0; i < 9; i++) positions[n++] = t[i];
    }
    transfer.push(positions.buffer);
  }

  return {
    payload: {
      modelId: item.modelId,
      localId: item.localId,
      name: item.name,
      category: item.category,
      box,
      positions,
    },
    transfer,
  };
}

/**
 * Run clash detection, preferring the worker. Falls back to main thread.
 */
export async function runClashOffThread(
  inputs: ClashInput[],
  opts: ClashRunOptions = {},
): Promise<ElementClash[]> {
  if ((globalThis as any).__obs_forceMainThread) {
    return runClashEngine(inputs, opts);
  }

  const rules: ClashRules = { ...DEFAULT_CLASH_RULES, ...(opts.rules ?? {}) };
  const method: ClashMethod = opts.method ?? "hard-triangle";
  const allowSelfPairs = opts.allowSelfPairs ?? true;
  const onProg = opts.onProgress ?? (() => {});

  const w = spawnWorker();
  if (!w) {
    console.log("[clash-worker] fallback → main thread");
    return runClashEngine(inputs, opts);
  }

  onProg({ phase: "broadphase", current: 0, total: 0, found: 0 });
  const collected = await collectItems(inputs, opts);
  if (!collected.items.length) {
    onProg({ phase: "done", current: 0, total: 0, found: 0 });
    return [];
  }

  const payloadItems: unknown[] = [];
  const transfer: Transferable[] = [];
  for (const it of collected.items) {
    const { payload, transfer: t } = serializeItem(it);
    payloadItems.push(payload);
    for (const b of t) transfer.push(b);
  }

  const requestId = `cr-${++nextRequestId}-${Date.now()}`;

  return new Promise<ElementClash[]>((resolve, reject) => {
    // Immediate cancel path — works with both AbortSignal and the legacy
    // { cancelled: boolean } shape.
    const sendCancel = (): void => {
      try {
        const msg: OutMessage = { type: "cancel", requestId };
        w.postMessage(msg);
      } catch { /* worker already gone */ }
    };

    const signal = opts.signal as CancelSignal;

    if (isCancelled(signal)) {
      reject(new DOMException("Clash cancelled", "AbortError"));
      return;
    }

    // Only standard AbortSignal supports event-driven cancel; the legacy
    // shape is polled in onProgress below.
    const onAbort = (): void => sendCancel();
    if (isAbortSignal(signal)) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = (): void => {
      if (isAbortSignal(signal)) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    pending.set(requestId, {
      resolve: (r) => { cleanup(); resolve(r); },
      reject:  (e) => { cleanup(); reject(e); },
      onProgress: (p) => {
        onProg(p);
        // Belt-and-braces for both shapes: poll for cancel between ticks.
        if (isCancelled(signal)) sendCancel();
      },
    });

    try {
      const runMsg: OutMessage = {
        type: "run",
        requestId,
        items: payloadItems,
        groups: collected.groups,
        rules,
        method,
        selfPairs: allowSelfPairs,
      };
      w.postMessage(runMsg, transfer);
    } catch (err) {
      pending.delete(requestId);
      console.warn("[clash-worker] postMessage failed — falling back", err);
      // A single postMessage failure (e.g. detached buffer) is NOT a worker
      // crash. Leave workerFailed alone so the next clash run still tries
      // the worker.
      void runClashEngine(inputs, opts).then(resolve, reject);
    }
  });
}

export function disposeClashWorker(): void {
  if (worker) {
    worker.removeEventListener("message", onWorkerMessage);
    worker.removeEventListener("error", onWorkerError);
    worker.terminate();
    worker = null;
  }
  for (const [, p] of pending) {
    p.reject(new Error("Clash worker disposed"));
  }
  pending.clear();
  // Reset the failure flag so a subsequent run can respawn a fresh worker.
  workerFailed = false;
}

// Vite HMR: tear the worker down when this module is hot-replaced.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    try { disposeClashWorker(); } catch { /* HMR best-effort */ }
  });
}
