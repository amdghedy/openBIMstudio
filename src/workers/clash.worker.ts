/// <reference lib="webworker" />
/**
 * Dedicated clash worker.
 * Receives serialized items (boxes + optional triangle arrays), runs pure
 * engine, streams progress + results. Triangle buffers are transferred.
 */
import * as THREE from "three";
import {
  runClashCore,
  type ClashCoreItem,
  type ClashProgress,
  type ClashMethod,
  type ClashRules,
  type ElementClash,
} from "../modules/clash/clash-core";
import type { Tri } from "../modules/clash/geometry";

type InMessage =
  | {
      type: "run";
      requestId: string;
      items: SerializedItem[];
      groups: number[][];
      rules: ClashRules;
      method: ClashMethod;
      selfPairs: boolean;
    }
  | { type: "cancel"; requestId: string };

type OutMessage =
  | { type: "progress"; requestId: string; progress: ClashProgress }
  | { type: "result"; requestId: string; clashes: SerializedClash[] }
  | { type: "error"; requestId: string; message: string; stack?: string };

interface SerializedItem {
  modelId: string;
  localId: number;
  name: string;
  category: string;
  box: [number, number, number, number, number, number];
  positions?: Float32Array;
}

interface SerializedClash {
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
}

const cancelled = new Set<string>();

function deserializeItem(s: SerializedItem): ClashCoreItem {
  const box = new THREE.Box3(
    new THREE.Vector3(s.box[0], s.box[1], s.box[2]),
    new THREE.Vector3(s.box[3], s.box[4], s.box[5]),
  );

  let tris: Tri[] | null = null;
  if (s.positions && s.positions.length >= 9) {
    const count = Math.floor(s.positions.length / 9);
    tris = new Array(count);
    for (let i = 0; i < count; i++) {
      const tri = new Float32Array(9);
      tri.set(s.positions.subarray(i * 9, i * 9 + 9));
      tris[i] = tri;
    }
  }

  return {
    modelId: s.modelId,
    localId: s.localId,
    name: s.name,
    category: s.category,
    box,
    tris,
  };
}

function serializeClash(c: ElementClash): SerializedClash {
  return {
    a: c.a,
    b: c.b,
    kind: c.kind,
    method: c.method,
    precision: c.precision,
    depthVol: c.depthVol,
    triPairs: c.triPairs,
    minGap: c.minGap,
    boxA: [c.boxA.min.x, c.boxA.min.y, c.boxA.min.z, c.boxA.max.x, c.boxA.max.y, c.boxA.max.z],
    boxB: [c.boxB.min.x, c.boxB.min.y, c.boxB.min.z, c.boxB.max.x, c.boxB.max.y, c.boxB.max.z],
    point: c.point ? [c.point.x, c.point.y, c.point.z] : null,
  };
}

function post(msg: OutMessage): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

self.addEventListener("message", (event: MessageEvent<InMessage>) => {
  const data = event.data;

  if (data.type === "cancel") {
    cancelled.add(data.requestId);
    return;
  }

  if (data.type !== "run") return;

  const { requestId } = data;
  cancelled.delete(requestId);

  void (async () => {
    try {
      const items = data.items.map(deserializeItem);

      const clashes = await runClashCore(items, {
        rules: data.rules,
        method: data.method,
        groups: data.groups,
        selfPairs: data.selfPairs,
        onProgress: (p) => post({ type: "progress", requestId, progress: p }),
        shouldCancel: () => cancelled.has(requestId),
        yield: () => Promise.resolve(),
        yieldEvery: 1024,
      });

      post({
        type: "result",
        requestId,
        clashes: clashes.map(serializeClash),
      });
    } catch (err) {
      post({
        type: "error",
        requestId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    } finally {
      cancelled.delete(requestId);
    }
  })();
});
