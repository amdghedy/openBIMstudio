/**
 * World-space AABB helper for Fragments models.
 *
 * The SDK's `model.getBoxes()` does not consistently return boxes in the
 * same coordinate system that Three.js renders. Depending on the SDK
 * version and on whether the autoCoordinator (or our positioning logic)
 * has moved the model, `getBoxes()` may return:
 *
 *   - local geometry space (untransformed), or
 *   - world space (already aligned), or
 *   - some intermediate space if a coordination matrix is applied only
 *     during rendering.
 *
 * Solution: use the rendered scene graph as ground truth.
 *   visualBox = Box3.setFromObject(model.object)
 * is exactly what Three.js uses to place geometry on screen. We compare
 * the aggregate of the raw boxes to `visualBox` and derive the correct
 * transform by detection, not by assumption.
 *
 * Robustness notes:
 *   • getBoxes() is called in chunks of 5000. A single call with 100k+ ids
 *     can fail (worker message limit, timeout, or SDK-specific caps) and
 *     silently return fewer boxes than requested.
 *   • Any chunk failure is logged. Partial results are still used; only
 *     a total wipeout returns [].
 *   • All SDK calls are wrapped. When the worker no longer has the model,
 *     we log once and return an empty result instead of throwing
 *     "Fragments: Model not found" into the console forever.
 */
import * as THREE from "three";
import { ctx } from "../../core/context";

export interface WorldBox {
  id: number;
  box: THREE.Box3;
  center: THREE.Vector3;
}

const NOT_FOUND = /Fragments\s*:?\s*Model not found/i;
const pruned = new Set<string>();

/** Chunk size for getBoxes calls. 5,000 keeps every worker message small. */
const BOX_CHUNK = 5000;

function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return NOT_FOUND.test(msg);
}

function pruneStale(modelId: string): void {
  if (!modelId || modelId === "?") return;
  if (pruned.has(modelId)) return;
  pruned.add(modelId);
  console.warn(
    `[world-box] pruning stale model "${modelId}" — worker no longer has it`,
  );
  try {
    (ctx.fragments.list as any).delete?.(modelId);
  } catch {
    /* */
  }
  try {
    if (ctx.fragments.list.has(modelId)) {
      (ctx.fragments.list as any).delete?.(modelId);
    }
  } catch {
    /* */
  }
}

/**
 * Read the world-space boxes of a set of elements.
 *
 * @param model   A `FragmentsModel` (has `.object` and `.getBoxes()`).
 * @param ids     Local fragment ids.
 * @param modelId Optional. When omitted, we try `model.modelId`, then
 *                `model.id`. Used to prune stale entries when the worker
 *                rejects the request.
 */
export async function getElementWorldBoxes(
  model: any,
  ids: number[],
  modelId?: string,
): Promise<WorldBox[]> {
  if (!model || !ids?.length) return [];

  const mid: string =
    modelId ?? (model as any)?.modelId ?? (model as any)?.id ?? "?";

  try {
    model.object?.updateMatrixWorld?.(true);
  } catch {
    /* */
  }

  // ── 1. Raw boxes from the SDK — chunked to survive large models ──
  const slots: (THREE.Box3 | null)[] = new Array(ids.length).fill(null);
  let chunkFailures = 0;
  let firstError: unknown = null;

  for (let start = 0; start < ids.length; start += BOX_CHUNK) {
    const end = Math.min(start + BOX_CHUNK, ids.length);
    const slice = ids.slice(start, end);
    let boxes: any;
    try {
      boxes = await model.getBoxes(slice);
    } catch (err) {
      if (isNotFound(err)) {
        pruneStale(mid);
        return [];
      }
      chunkFailures++;
      if (!firstError) firstError = err;
      console.error(
        `[world-box] getBoxes failed · model "${mid}" · ` +
          `chunk ${start}..${end} (${slice.length} id(s)):`,
        err,
      );
      continue;
    }
    if (!Array.isArray(boxes)) {
      chunkFailures++;
      if (!firstError) firstError = new Error(`getBoxes returned ${typeof boxes}`);
      console.warn(
        `[world-box] getBoxes returned non-array · model "${mid}" · chunk ${start}`,
      );
      continue;
    }
    const n = Math.min(slice.length, boxes.length);
    for (let i = 0; i < n; i++) {
      const b = boxes[i];
      if (b && b.isBox3 !== false) slots[start + i] = b;
    }
    if (boxes.length < slice.length) {
      console.warn(
        `[world-box] getBoxes returned ${boxes.length} of ${slice.length} ` +
          `boxes · model "${mid}" · chunk ${start}`,
      );
    }
  }

  if (chunkFailures > 0) {
    console.warn(
      `[world-box] model "${mid}": ${chunkFailures} chunk(s) failed. ` +
        `First error: ${firstError instanceof Error ? firstError.message : firstError}`,
    );
  }

  // Compact down to ids that actually got a box.
  const alignedIds: number[] = [];
  const alignedBoxes: THREE.Box3[] = [];
  for (let i = 0; i < ids.length; i++) {
    const b = slots[i];
    if (b && !b.isEmpty()) {
      alignedIds.push(ids[i]);
      alignedBoxes.push(b);
    }
  }

  if (!alignedBoxes.length) {
    console.warn(
      `[world-box] model "${mid}": no boxes returned for ${ids.length} id(s) — ` +
        `the model will contribute nothing to any spatial query`,
    );
    return [];
  }

  // ── 2. Aggregate of all raw boxes ──
  const rawAgg = new THREE.Box3();
  for (const b of alignedBoxes) rawAgg.union(b);
  if (rawAgg.isEmpty()) return [];

  // ── 3. Visual box — the ground truth ──
  let visualBox = new THREE.Box3();
  try {
    visualBox = new THREE.Box3().setFromObject(model.object);
  } catch {
    visualBox = new THREE.Box3();
  }

  // ── 4. Decide the transform by detection ──
  let resolved: THREE.Box3[];

  if (visualBox.isEmpty()) {
    const mw: THREE.Matrix4 =
      model.object?.matrixWorld?.clone?.() ?? new THREE.Matrix4();
    resolved = alignedBoxes.map((b) => b.clone().applyMatrix4(mw));
  } else {
    const rawCenter = rawAgg.getCenter(new THREE.Vector3());
    const visCenter = visualBox.getCenter(new THREE.Vector3());
    const gap = rawCenter.distanceTo(visCenter);

    const rawSize = new THREE.Vector3();
    const visSize = new THREE.Vector3();
    rawAgg.getSize(rawSize);
    visualBox.getSize(visSize);
    const sizeDiff =
      Math.abs(rawSize.x - visSize.x) +
      Math.abs(rawSize.y - visSize.y) +
      Math.abs(rawSize.z - visSize.z);
    const referenceSize = Math.max(rawSize.length(), visSize.length(), 0.001);

    if (gap < 0.05) {
      // Raw boxes already match the rendered position — no transform.
      resolved = alignedBoxes.map((b) => b.clone());
    } else if (sizeDiff < referenceSize * 0.05) {
      // Same size, different position: pure translation.
      const delta = visCenter.clone().sub(rawCenter);
      resolved = alignedBoxes.map((b) => b.clone().translate(delta));
    } else {
      // Sizes differ — rotation or scale is involved. Use matrixWorld.
      const mw: THREE.Matrix4 =
        model.object?.matrixWorld?.clone?.() ?? new THREE.Matrix4();
      resolved = alignedBoxes.map((b) => b.clone().applyMatrix4(mw));
    }
  }

  // ── 5. Emit per-id ──
  const out: WorldBox[] = [];
  for (let i = 0; i < alignedIds.length; i++) {
    const b = resolved[i];
    if (!b || b.isEmpty()) continue;
    out.push({
      id: alignedIds[i],
      box: b,
      center: b.getCenter(new THREE.Vector3()),
    });
  }
  return out;
}

/** Convenience: a single element's world box. */
export async function getElementWorldBox(
  model: any,
  id: number,
  modelId?: string,
): Promise<THREE.Box3 | null> {
  const r = await getElementWorldBoxes(model, [id], modelId);
  return r[0]?.box ?? null;
}

/** Reset the pruned-model tracking (call after a successful model load). */
export function clearPrunedCache(): void {
  pruned.clear();
}