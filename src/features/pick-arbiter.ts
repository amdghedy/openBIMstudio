/**
 * Which hit owns a viewport click when BOTH an authored element (incl. a Native Twin) and a
 * linked fragment element lie under the cursor. Nearest along the ray wins.
 * Pure, so it can be unit-tested.
 */
export function authoredOwnsClick(
  authored: { distance: number; isNativeTwin: boolean } | null,
  fragmentDistance: number | null | undefined,
): boolean {
  if (!authored) return false;
  if (fragmentDistance == null || !Number.isFinite(fragmentDistance)) return true; // nothing (or nothing measurable) in the linked model
  if (!Number.isFinite(authored.distance)) return authored.isNativeTwin;
  // Tolerance: a twin is the same surface as its (hidden) source element.
  const tol = Math.max(0.02, Math.abs(fragmentDistance) * 0.005);
  return authored.distance <= fragmentDistance + tol;
}
