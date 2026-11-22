/**
 * THREE-level Boolean subtraction with the K4 post-condition (K4).
 *
 * Adapter between the THREE meshes the authoring / family paths build
 * and the pure post-condition in ./boolean-postcondition. It runs the
 * subtraction exactly as the old code did (`three-csg-ts`, the engine
 * the wall opening / door / reveal cuts and the family void cuts use),
 * then hands the result — or the throw — to
 * `postconditionThreeCsgResult`, which gates it and falls back to the
 * general kernel when three-csg-ts fails or its result fails the gate
 * (measured: a volume-exact three-csg-ts door cut gates REFUSED with
 * ~50 T-junction boundary edges; a position-only reveal cutter makes
 * `CSG.fromMesh` throw outright).
 *
 * Contract (same as `CSG.fromMesh`): each mesh's `.matrix` is used
 * as-is — callers must have it current (`updateMatrixWorld(true)` on
 * an unparented mesh, or an explicitly copied matrix as `subtractVoids`
 * does). The returned cut mesh carries the source mesh's local
 * transform (position / quaternion / scale decomposed from
 * `mesh.matrix`, as `CSG.toMesh` does) and its `userData`, so it drops
 * into the caller's scene graph exactly where the three-csg-ts result
 * would have gone. The fallback mesh's geometry is emitted non-indexed
 * with `computeVertexNormals` flat face normals — the same shading
 * shape as three-csg-ts output (no uvs: wall / family void meshes use
 * flat-colour materials).
 *
 * This module NEVER returns an uncut mesh as a success: on total
 * failure it returns the original mesh with `cut: false` and the
 * failure attached — the caller must quarantine the element and
 * surface the failure to the user (toast / diagnostic record), never
 * display the wall as cut.
 */

import * as THREE from "three";
import { CSG } from "three-csg-ts";
import { meshVolume, type IndexedMesh } from "../adaptive";
import type { GeometryDiagnostic } from "./validate";
import { threeGeometryToIndexedMesh } from "./validation-gate";
import {
  postconditionThreeCsgResult,
  type BooleanEngine,
} from "./boolean-postcondition";

export interface ThreeSubtractFailure {
  reason: string;
  diagnostics: GeometryDiagnostic[];
  volumeBefore: number;
}

export interface ThreeSubtractOutcome {
  /** Cut mesh on success; the ORIGINAL (uncut) mesh on failure. */
  mesh: THREE.Mesh;
  cut: boolean;
  /** True when the general kernel produced the mesh. */
  fallbackUsed: boolean;
  /** Engine that produced the mesh, or null on failure. */
  engine: BooleanEngine | null;
  /** Present only when `cut` is false. */
  failure?: ThreeSubtractFailure;
}

/** Non-indexed sequential triples of a mesh (flat shading after computeVertexNormals). */
function indexedMeshToPositions(mesh: IndexedMesh): Float32Array {
  const out = new Float32Array(mesh.faces.length * 9);
  let o = 0;
  for (const [a, b, c] of mesh.faces) {
    for (const vi of [a, b, c]) {
      const v = mesh.vertices[vi];
      out[o++] = v.x;
      out[o++] = v.y;
      out[o++] = v.z;
    }
  }
  return out;
}

function meshToIndexed(mesh: THREE.Mesh): IndexedMesh {
  const geo = mesh.geometry as THREE.BufferGeometry | undefined;
  const posAttr = geo?.getAttribute?.("position") as THREE.BufferAttribute | undefined;
  if (!posAttr) {
    throw new Error("subtractThreeMesh: mesh has no position attribute");
  }
  const idxAttr = (geo?.getIndex?.() as THREE.BufferAttribute | null)?.array as ArrayLike<number> | null;
  return threeGeometryToIndexedMesh(
    posAttr.array as ArrayLike<number>,
    idxAttr ?? null,
    mesh.matrix.elements as unknown as ArrayLike<number>,
  );
}

/**
 * Subtract `cutter` from `mesh` with the unified post-condition.
 * `owner` labels the operation in diagnostics, e.g.
 * `wall:<elementId> door <hostId>`.
 */
export function subtractThreeMesh(
  mesh: THREE.Mesh,
  cutter: THREE.Mesh,
  material: THREE.Material,
  owner: string,
): ThreeSubtractOutcome {
  let wallBefore: IndexedMesh;
  let cutterIdx: IndexedMesh;
  let volumeBefore = NaN;
  try {
    wallBefore = meshToIndexed(mesh);
    volumeBefore = meshVolume(wallBefore);
    cutterIdx = meshToIndexed(cutter);
  } catch (err) {
    // Malformed operands: neither engine can run soundly. Fail closed
    // rather than returning a mesh three-csg-ts may have mangled.
    return {
      mesh,
      cut: false,
      fallbackUsed: false,
      engine: null,
      failure: {
        reason: `opening cut failed: the wall or cutter geometry could not be read (${err instanceof Error ? err.message : String(err)})`,
        diagnostics: [
          {
            code: "invalid-boolean",
            severity: "error",
            message: `${owner}: operand conversion failed: ${err instanceof Error ? err.message : String(err)}`,
            affected: [owner],
            recoveryAction: "Rebuild the opening from its hosted element parameters.",
            commitEligible: false,
          },
        ],
        volumeBefore,
      },
    };
  }

  // ── Leg 1: three-csg-ts, exactly as the old code ran it.
  let csgMesh: THREE.Mesh | null = null;
  let csgResult: IndexedMesh | null = null;
  let threeCsgError: string | null = null;
  try {
    const resultBsp = CSG.fromMesh(mesh).subtract(CSG.fromMesh(cutter));
    csgMesh = CSG.toMesh(resultBsp, mesh.matrix, material);
    // toMesh already applied inv(mesh.matrix) to the geometry, so the
    // result positions are in the mesh's local frame; re-applying
    // mesh.matrix converts them into the frame wallBefore is in.
    csgResult = meshToIndexed(csgMesh);
  } catch (err) {
    threeCsgError = err instanceof Error ? err.message : String(err);
  }

  const outcome = postconditionThreeCsgResult({
    wallBefore,
    cutter: cutterIdx,
    result: csgResult,
    threeCsgError,
    owner,
  });

  if (outcome.status === "failed") {
    return {
      mesh,
      cut: false,
      fallbackUsed: false,
      engine: null,
      failure: {
        reason: outcome.reason,
        diagnostics: outcome.diagnostics,
        volumeBefore: outcome.volumeBefore,
      },
    };
  }

  if (!outcome.fallbackUsed && csgMesh) {
    csgMesh.userData = { ...mesh.userData };
    return { mesh: csgMesh, cut: true, fallbackUsed: false, engine: "three-csg-ts" };
  }

  // ── Leg 2 (fallback): build a THREE mesh from the gated
  // general-kernel result, in the source mesh's local frame.
  let inv: THREE.Matrix4;
  try {
    inv = new THREE.Matrix4().copy(mesh.matrix).invert();
  } catch {
    return {
      mesh,
      cut: false,
      fallbackUsed: false,
      engine: null,
      failure: {
        reason: "opening cut failed: the general-kernel fallback succeeded but the wall transform is not invertible, so the cut mesh cannot be placed",
        diagnostics: [
          {
            code: "invalid-boolean",
            severity: "error",
            message: `${owner}: fallback result cannot be placed (wall matrix not invertible)`,
            affected: [owner],
            recoveryAction: "Rebuild the wall from its parameters.",
            commitEligible: false,
          },
        ],
        volumeBefore: outcome.volumeBefore,
      },
    };
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(indexedMeshToPositions(outcome.mesh), 3));
  geo.applyMatrix4(inv);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  const out = new THREE.Mesh(geo, material);
  out.matrix.copy(mesh.matrix);
  out.matrix.decompose(out.position, out.quaternion, out.scale);
  out.userData = { ...mesh.userData };
  out.castShadow = true;
  out.receiveShadow = true;
  return { mesh: out, cut: true, fallbackUsed: true, engine: "general-kernel" };
}
