/** Derive a simple axis-aligned plan polygon from mesh positions (world XZ). */

export function derivePlanAabbPolygon(
  positions: ArrayLike<number>,
  worldPosition: [number, number, number] = [0, 0, 0],
  worldScale: [number, number, number] = [1, 1, 1],
): [number, number][] | null {
  const n = Math.floor(positions.length / 3);
  if (n < 3) return null;
  const [px, , pz] = worldPosition;
  const [sx, , sz] = worldScale;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = Number(positions[i * 3]) * sx + px;
    const z = Number(positions[i * 3 + 2]) * sz + pz;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  if (!(maxX > minX) || !(maxZ > minZ)) return null;
  if (maxX - minX < 1e-4 || maxZ - minZ < 1e-4) return null;
  return [
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
  ];
}
