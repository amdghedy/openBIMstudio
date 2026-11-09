/**
 * Stacked wall element — one authored wall composed of vertical members
 * with different wall types (RVT: "Stacked Wall", e.g. brick base 0–2.4 m
 * + metal panel 2.4–4.2 m placed and edited as a single element).
 *
 * Compatibility notes (documented honestly):
 *   - RVT's stacked-wall UI allows 2 members; the data model allows N and
 *     so do we (2 is the common case, N covers precast/composite builds).
 *   - All members share the plan location line — by construction here.
 *   - RVT requires a single thickness across members; we flag mixed
 *     thicknesses as a warning instead of rejecting (precast edges case).
 *   - Members are contiguous: member i's top is member i+1's base. Gaps
 *     and overlaps are impossible in the expanded output — validation is
 *     about *input* sanity (heights > 0, count >= 2).
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 */

export interface StackedMember {
  /** Wall type preset id for the member (architecture-depth wall-types). */
  wallType: string;
  /** Member height in m (positive). */
  height: number;
  /** Optional member thickness in m — defaults to the stack thickness. */
  thickness?: number;
}

export interface StackedWallDef {
  /** Plan start [x, z] of the shared location line. */
  start: [number, number];
  /** Plan end [x, z] of the shared location line. */
  end: [number, number];
  /** Base elevation of the lowest member (m). */
  baseElevation: number;
  /** Members bottom-up. */
  members: StackedMember[];
  /** Stack thickness applied to members that don't override it (m). */
  thickness?: number;
}

export interface StackedIssue {
  code: "members" | "height" | "length" | "thickness" | "elevation" | "type";
  message: string;
}

export interface StackedSpan {
  index: number;
  wallType: string;
  thickness: number;
  /** Base elevation of this member (m). */
  baseElevation: number;
  /** Member height (m). */
  height: number;
  /** Top elevation of this member (m) = base + height. */
  topElevation: number;
}

export interface StackedValidation {
  ok: boolean;
  issues: StackedIssue[];
  totalHeight: number;
  lengthM: number;
  spans: StackedSpan[];
}

export interface StackedMemberPlacement {
  index: number;
  wallType: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  elev: number;
  height: number;
  thickness: number;
}

// ─── Validation + spans ───────────────────────────────────────────────────

function isFinitePair(p: unknown): p is [number, number] {
  return Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
}

/** Validate a stacked wall definition and compute its member spans. */
export function validateStackedWall(def: StackedWallDef, opts: { warnMixedThickness?: boolean } = {}): StackedValidation {
  const issues: StackedIssue[] = [];
  const members = Array.isArray(def?.members) ? def.members : [];

  if (!isFinitePair(def?.start) || !isFinitePair(def?.end)) {
    issues.push({ code: "length", message: "start/end must be finite [x, z] pairs" });
  }
  if (!Number.isFinite(def?.baseElevation)) {
    issues.push({ code: "elevation", message: "baseElevation must be a finite number" });
  }
  if (members.length < 2) {
    issues.push({ code: "members", message: `a stacked wall needs at least 2 members (got ${members.length})` });
  }
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (!Number.isFinite(m?.height) || m.height <= 0) {
      issues.push({ code: "height", message: `member ${i + 1} height must be positive (got ${m?.height})` });
    }
    if (typeof m?.wallType !== "string" || !m.wallType.trim()) {
      issues.push({ code: "type", message: `member ${i + 1} needs a wallType` });
    }
    if (m?.thickness != null && (!Number.isFinite(m.thickness) || m.thickness <= 0)) {
      issues.push({ code: "thickness", message: `member ${i + 1} thickness must be positive` });
    }
  }

  const lengthM = isFinitePair(def?.start) && isFinitePair(def?.end)
    ? Math.hypot(def.end[0] - def.start[0], def.end[1] - def.start[1])
    : 0;
  if (lengthM < 0.05) {
    issues.push({ code: "length", message: `stacked wall length ${lengthM.toFixed(3)} m is degenerate (< 5 cm)` });
  }

  const warnMixed = opts.warnMixedThickness !== false;
  const stackThickness = def?.thickness;
  const eff = members.map((m) => m.thickness ?? stackThickness ?? 0.2);
  if (members.length >= 2 && warnMixed && eff.some((t) => Math.abs(t - eff[0]) > 1e-9)) {
    issues.push({
      code: "thickness",
      message: `members have mixed thicknesses (${eff.map((t) => t.toFixed(3)).join(", ")} m) — RVT stacked walls share one thickness`,
    });
  }

  // Contiguous spans bottom-up (cumulative; NaN-safe when heights are bad).
  const spans: StackedSpan[] = [];
  let base = Number.isFinite(def?.baseElevation) ? def.baseElevation : 0;
  for (let i = 0; i < members.length; i++) {
    const h = Number.isFinite(members[i]?.height) && members[i].height > 0 ? members[i].height : 0;
    spans.push({
      index: i,
      wallType: members[i]?.wallType ?? "?",
      thickness: eff[i],
      baseElevation: base,
      height: h,
      topElevation: base + h,
    });
    base += h;
  }
  const totalHeight = spans.reduce((a, s) => a + s.height, 0);

  return {
    ok: !issues.some((i) => i.code !== "thickness"),
    issues,
    totalHeight,
    lengthM,
    spans,
  };
}

// ─── Expansion to placeable member walls ─────────────────────────────────

/**
 * Expand the stacked definition into one placeable wall per member.
 * All members share the plan line; elevations are contiguous by
 * construction. Throws when the definition is invalid (validate first for
 * a report instead of an exception).
 */
export function expandStackedWall(def: StackedWallDef, opts: { warnMixedThickness?: boolean } = {}): StackedMemberPlacement[] {
  const v = validateStackedWall(def, opts);
  if (!v.ok) {
    throw new Error("Invalid stacked wall: " + v.issues.map((i) => i.message).join("; "));
  }
  return v.spans.map((s) => ({
    index: s.index,
    wallType: s.wallType,
    x1: def.start[0],
    z1: def.start[1],
    x2: def.end[0],
    z2: def.end[1],
    elev: s.baseElevation,
    height: s.height,
    thickness: s.thickness,
  }));
}

/** Human-readable summary for dialogs/reports. */
export function stackedWallSummary(def: StackedWallDef, opts: { warnMixedThickness?: boolean } = {}): {
  totalHeight: number;
  lengthM: number;
  members: number;
  ok: boolean;
  issues: string[];
} {
  const v = validateStackedWall(def, opts);
  return {
    totalHeight: v.totalHeight,
    lengthM: v.lengthM,
    members: v.spans.length,
    ok: v.ok,
    issues: v.issues.map((i) => i.message),
  };
}
