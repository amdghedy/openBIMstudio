/**
 * Stable yaw/pitch editing for family-local MEP connector directions.
 *
 * Convention:
 * - +X is yaw 0°.
 * - Positive yaw rotates from +X toward +Z.
 * - Positive pitch points upward toward +Y.
 * - Returned vectors are always normalized.
 */
export type ConnectorDirection3 = [number, number, number];

export interface ConnectorYawPitch {
  yawDeg: number;
  pitchDeg: number;
}

const DEGREES_PER_RADIAN = 180 / Math.PI;
const RADIANS_PER_DEGREE = Math.PI / 180;
const VECTOR_EPSILON = 1e-10;

export function normalizeConnectorDirection(
  direction: readonly number[],
): ConnectorDirection3 {
  if (!Array.isArray(direction) || direction.length !== 3 ||
      !direction.every(Number.isFinite)) {
    throw new Error("Connector direction must contain three finite coordinates");
  }

  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!Number.isFinite(length) || length < VECTOR_EPSILON) {
    throw new Error("Connector direction must be non-zero");
  }

  return [
    direction[0] / length,
    direction[1] / length,
    direction[2] / length,
  ];
}

/** Convert a connector direction vector to yaw and pitch in degrees. */
export function connectorDirectionToYawPitch(
  direction: readonly number[],
): ConnectorYawPitch {
  const [x, y, z] = normalizeConnectorDirection(direction);
  const horizontalLength = Math.hypot(x, z);
  return {
    // Yaw is undefined for a vertical vector; choose zero deterministically.
    yawDeg: horizontalLength < VECTOR_EPSILON
      ? 0
      : Math.atan2(z, x) * DEGREES_PER_RADIAN,
    pitchDeg: Math.asin(Math.max(-1, Math.min(1, y))) * DEGREES_PER_RADIAN,
  };
}

/**
 * Convert yaw/pitch degrees to a normalized family-local direction vector.
 * Pitch is deliberately bounded to [-90°, 90°]; yaw may be any finite angle.
 */
export function yawPitchToConnectorDirection(
  yawDeg: number,
  pitchDeg: number,
): ConnectorDirection3 {
  if (!Number.isFinite(yawDeg) || !Number.isFinite(pitchDeg)) {
    throw new Error("Connector yaw and pitch must be finite numbers");
  }
  if (pitchDeg < -90 || pitchDeg > 90) {
    throw new Error("Connector pitch must be between -90° and 90°");
  }

  const yaw = yawDeg * RADIANS_PER_DEGREE;
  const pitch = pitchDeg * RADIANS_PER_DEGREE;
  const horizontal = Math.cos(pitch);
  return normalizeConnectorDirection([
    horizontal * Math.cos(yaw),
    Math.sin(pitch),
    horizontal * Math.sin(yaw),
  ]);
}
