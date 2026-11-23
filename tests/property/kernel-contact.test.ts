import fc from 'fast-check';
import {
  generalBoolean, generateVoid, meshVolume,
  validateMeshDiagnostics, weldMesh,
  gateSolid, listQuarantinedSolids, clearQuarantinedSolids,
  type IndexedMesh,
} from '../../src/modules/solid-kernel';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

// Touching-contact kernel regressions (#98): deterministic pins of the
// PE-09 findings recorded in docs/engineering/pr-description-pe09.md.
// The general kernel resolves face and point contact (watertight, gate
// `ok`); only edge contact is non-manifold, and the validation gate
// quarantines it — as it quarantines any producer that keeps both
// skins of a contact. Each case asserts BOTH directions of the
// behaviour, so a silent change fails here: a face/point union that
// regresses to non-manifold fails C1/C2, an edge-contact union that
// silently becomes watertight fails C3, and a gate that stops
// quarantining fails C3/C4.

function box(cx: number, cy: number, cz: number): IndexedMesh {
  return generateVoid({
    kind: 'box',
    center: { x: cx, y: cy, z: cz },
    size: { x: 1, y: 1, z: 1 },
  });
}

function near(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

function errorDiagnostics(m: IndexedMesh) {
  return validateMeshDiagnostics(weldMesh(m)).filter((d) => d.severity === 'error');
}

function nonManifoldCount(m: IndexedMesh): number {
  return errorDiagnostics(m).filter((d) => d.code === 'non-manifold-edge').length;
}

/** Assert every error diagnostic is the junction/contact class. */
function assertOnlyNonManifold(m: IndexedMesh, label: string): void {
  const errs = errorDiagnostics(m);
  if (errs.length === 0) throw new Error(`${label}: expected non-manifold errors, got none`);
  if (!errs.every((d) => d.code === 'non-manifold-edge')) {
    throw new Error(`${label}: unexpected error codes: ${[...new Set(errs.map((d) => d.code))].join(',')}`);
  }
}

// (C1) Face-contact union: watertight, exact volume, gate `ok`, and no
// quarantine record is left behind.
fc.assert(
  fc.property(fc.constant(0), () => {
    const u = generalBoolean('union', box(0.5, 0.5, 0.5), box(1.5, 0.5, 0.5));
    if (!near(meshVolume(u), 2)) return false;
    if (errorDiagnostics(u).length !== 0) return false;
    clearQuarantinedSolids();
    const g = gateSolid(u, 'kernel-contact-face-touch', { source: 'property-test' });
    if (g.verdict !== 'ok') return false;
    return listQuarantinedSolids().length === 0;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (C2) Point-contact union: watertight, exact volume, gate `ok`.
fc.assert(
  fc.property(fc.constant(0), () => {
    const u = generalBoolean('union', box(0.5, 0.5, 0.5), box(1.5, 1.5, 1.5));
    if (!near(meshVolume(u), 2)) return false;
    if (errorDiagnostics(u).length !== 0) return false;
    clearQuarantinedSolids();
    const g = gateSolid(u, 'kernel-contact-point-touch', { source: 'property-test' });
    if (g.verdict !== 'ok') return false;
    return listQuarantinedSolids().length === 0;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (C3) Edge-contact union: exact volume, non-manifold (the shared edge
// is used four times), and the gate quarantines it — admitted, but
// recorded in the registry with the junction-only diagnostics.
fc.assert(
  fc.property(fc.constant(0), () => {
    const u = generalBoolean('union', box(0.5, 0.5, 0.5), box(1.5, 1.5, 0.5));
    if (!near(meshVolume(u), 2)) return false;
    assertOnlyNonManifold(u, 'edge-contact union');
    if (nonManifoldCount(u) < 1) return false;
    clearQuarantinedSolids();
    const g = gateSolid(u, 'kernel-contact-edge-touch', { source: 'property-test' });
    if (g.verdict !== 'quarantined') return false;
    if (!near(g.volume, 2)) return false;
    const records = listQuarantinedSolids();
    if (records.length !== 1) return false;
    const record = records[0];
    if (record.id !== 'kernel-contact-edge-touch') return false;
    if (record.disposition !== 'quarantined' || !record.admitted) return false;
    return record.diagnostics.every((d) => d.code === 'non-manifold-edge');
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (C4) Double-skin producer: two closed boxes sharing a face, kept as
// a raw soup (both skins of the contact face present, as an imported
// tessellation or three-csg-ts output would produce). The volume is
// exact, the shared face's four edges are non-manifold, and the gate
// quarantines the mesh instead of silently admitting it.
fc.assert(
  fc.property(fc.constant(0), () => {
    const a = box(0.5, 0.5, 0.5);
    const b = box(1.5, 0.5, 0.5);
    const soup: IndexedMesh = {
      vertices: [...a.vertices, ...b.vertices],
      faces: [
        ...a.faces,
        ...b.faces.map(([x, y, z]) => [x + a.vertices.length, y + a.vertices.length, z + a.vertices.length] as [number, number, number]),
      ],
    };
    if (!near(meshVolume(weldMesh(soup)), 2)) return false;
    assertOnlyNonManifold(soup, 'double-skin soup');
    if (nonManifoldCount(soup) < 1) return false;
    clearQuarantinedSolids();
    const g = gateSolid(soup, 'kernel-contact-double-skin', { source: 'property-test' });
    if (g.verdict !== 'quarantined') return false;
    const records = listQuarantinedSolids();
    if (records.length !== 1) return false;
    const record = records[0];
    if (record.id !== 'kernel-contact-double-skin') return false;
    if (record.disposition !== 'quarantined' || !record.admitted) return false;
    return record.diagnostics.every((d) => d.code === 'non-manifold-edge');
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

console.log(`PASS kernel-contact (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
