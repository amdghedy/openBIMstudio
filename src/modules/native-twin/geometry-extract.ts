/**
 * Robust per-element geometry extraction for Native Twin conversion.
 *
 * Fragments 3.x stores geometry in tile samples; getItemsGeometry is the
 * supported API. Viewport meshes often only carry userData.itemIds (not
 * classic idRanges), so traverse-based extractors frequently return null
 * even when the element is visible.
 */
import * as THREE from "three";
import type { Tri } from "../clash/geometry";

export type ExtractFailureReason =
  | "model_not_found"
  | "no_geometry_mapping"
  | "geometry_api_empty"
  | "geometry_invalid"
  | "unsupported_representation"
  | "unknown";

export interface ExtractResult {
  ok: boolean;
  tris: Tri[];
  box: THREE.Box3;
  path: string;
  reason?: ExtractFailureReason;
  detail?: string;
  meshCount?: number;
  vertexCount?: number;
  triangleCount?: number;
}

function finiteMatrixFromUnknown(input: unknown): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (!input) return m.identity();
  if (input instanceof THREE.Matrix4) return m.copy(input);
  const any = input as any;
  if (any.isMatrix4 && any.elements) return m.fromArray(Array.from(any.elements));
  if (Array.isArray(any.elements) || ArrayBuffer.isView(any.elements)) {
    return m.fromArray(Array.from(any.elements as ArrayLike<number>));
  }
  if (Array.isArray(input) || ArrayBuffer.isView(input)) {
    const arr = Array.from(input as ArrayLike<number>);
    if (arr.length >= 16) return m.fromArray(arr.slice(0, 16));
  }
  return m.identity();
}

function positionsUsable(positions: ArrayLike<number> | undefined | null): boolean {
  if (!positions || typeof positions.length !== "number" || positions.length < 9) return false;
  for (let i = 0; i < Math.min(positions.length, 12); i++) {
    if (!Number.isFinite(Number(positions[i]))) return false;
  }
  return true;
}

// NOTE: full file restoration in progress - temporary stub marker RESTORE_PENDING
export async function extractElementGeometry(
  model: any,
  localId: number,
  modelId = "?",
): Promise<ExtractResult> {
  return {
    ok: false,
    tris: [],
    box: new THREE.Box3(),
    path: "none",
    reason: "unknown",
    detail: "RESTORE_PENDING",
  };
}

export function failureUserMessage(modelId: string, localId: number, result: ExtractResult): string {
  return `Native Twin: could not retrieve usable geometry for ${modelId} / ${localId}.`;
}
