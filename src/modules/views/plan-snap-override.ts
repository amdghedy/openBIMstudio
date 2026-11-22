/**
 * Plan snap overrides — audit gap G14.
 *
 * Revit behaviour: during a command, right-click → Snap Overrides, or type
 * a two-letter override (SE endpoint, SM midpoint, SC centre, SI
 * intersection, SN nearest, …) to restrict the *next* snap pick to that one
 * snap type. The override is one-shot: it clears after the next successful
 * snap pick (or Esc / tool change).
 *
 * Pure module — no DOM, no ctx imports — so the state machine, the key
 * resolution and the honest omission table are unit-testable without
 * booting the app (G8 pattern). The live wiring lives in
 * `src/features/plan-view-panel.ts`, which owns the right-click menu, the
 * keydown interception and the snap-path filter.
 *
 * Honest scope (verified against the plan snapper, `plan-snap.ts`):
 * the plan snapper can produce exactly endpoint, midpoint, centre,
 * intersection and nearest. It has NO producer for perpendicular,
 * tangent, quadrant or vertex, so those keys are deliberately NOT bound
 * (see OMITTED_OVERRIDE_KEYS) — listing a type the snapper cannot
 * produce would be a lie. ST is additionally bound to Stairs on main,
 * so it is doubly unavailable.
 *
 * SC is contested: G8 binds `sc` → gizmo scale mode (unconditional, in
 * the global shortcut registry). Resolution is context-dependent: while
 * a plan placement/dim tool is active, SC = snap-centre one-shot
 * override; everywhere else SC = gizmo scale (G8's binding, untouched).
 * The plan keydown handler is registered before the registry
 * (main.ts: plan-view step runs before shortcuts-install), so while a
 * plan tool is active it consumes the pair before the registry ever
 * sees the second key. `resolveOverrideKeys` pins that precedence here.
 */

export type PlanSnapOverrideKind =
  | "endpoint"
  | "midpoint"
  | "center"
  | "intersection"
  | "nearest";

export interface PlanSnapOverrideEntry {
  readonly kind: PlanSnapOverrideKind;
  /** Registry format: lowercase two-letter sequence. */
  readonly keys: string;
  readonly label: string;
}

/** The override types the plan snapper can actually produce, in Revit order. */
export const PLAN_SNAP_OVERRIDE_ENTRIES: readonly PlanSnapOverrideEntry[] = [
  { kind: "endpoint", keys: "se", label: "Endpoint" },
  { kind: "midpoint", keys: "sm", label: "Midpoint" },
  { kind: "center", keys: "sc", label: "Center" },
  { kind: "intersection", keys: "si", label: "Intersection" },
  { kind: "nearest", keys: "sn", label: "Nearest" },
];

export const PLAN_SNAP_OVERRIDE_BY_KEYS: Readonly<Record<string, PlanSnapOverrideKind>> =
  Object.fromEntries(PLAN_SNAP_OVERRIDE_ENTRIES.map((e) => [e.keys, e.kind]));

/** Every override key starts with `s` (SE/SM/SC/SI/SN). */
export function isOverrideFirstKey(key: string): boolean {
  return key.toLowerCase() === "s";
}

export interface OmittedOverrideKey {
  readonly keys: string;
  readonly label: string;
  readonly reason: string;
}

/**
 * Revit override keys this app deliberately does NOT bind: the plan
 * snapper has no producer for the type (and ST is already bound to
 * Stairs on main). Recorded here so the omission is a decision, not an
 * oversight, and so the node test can pin it.
 */
export const OMITTED_OVERRIDE_KEYS: readonly OmittedOverrideKey[] = [
  { keys: "sp", label: "Perpendicular", reason: "no perpendicular producer in the plan snapper" },
  { keys: "st", label: "Tangent", reason: "no tangent producer in the plan snapper; ST is also bound to Stairs on main" },
  { keys: "sq", label: "Quadrant", reason: "no quadrant producer in the plan snapper" },
  { keys: "sv", label: "Vertex", reason: "no vertex producer in the plan snapper (slab vertices surface as corners)" },
];

export function planSnapOverrideLabel(kind: PlanSnapOverrideKind): string {
  const entry = PLAN_SNAP_OVERRIDE_ENTRIES.find((e) => e.kind === kind);
  return entry ? entry.label : kind;
}

/**
 * Resolve a two-letter sequence typed while the plan view is open.
 *
 * @param first  first letter (lowercase)
 * @param second second letter (lowercase)
 * @param planToolActive true while a plan placement/dim tool is active
 * @returns the override kind, or null when the pair is not an override
 *   in this context (the caller then falls through to the command line /
 *   global registry — e.g. SC falls through to G8's gizmo scale when no
 *   plan tool is active).
 */
export function resolveOverrideKeys(
  first: string,
  second: string,
  planToolActive: boolean,
): PlanSnapOverrideKind | null {
  if (!planToolActive) return null;
  if (first.toLowerCase() !== "s") return null;
  return PLAN_SNAP_OVERRIDE_BY_KEYS[(first + second).toLowerCase()] ?? null;
}

export interface PlanSnapOverride {
  /** The armed kind, or null when no override is armed. */
  readonly active: PlanSnapOverrideKind | null;
  /** Arm a one-shot override, replacing any previously armed one. */
  arm(kind: PlanSnapOverrideKind): void;
  /** Disarm without consuming (Esc, tool change, explicit Clear). */
  clear(): void;
  /**
   * Consume the override after a successful snap pick: clears it and
   * returns true when one was armed, false when none was armed.
   * Revit semantics: the override applies to the *next* snap only.
   */
  consumeAfterSnap(): boolean;
}

/** One-shot override state machine. Pure — no DOM, no timers. */
export function createPlanSnapOverride(): PlanSnapOverride {
  let armed: PlanSnapOverrideKind | null = null;
  return {
    get active(): PlanSnapOverrideKind | null {
      return armed;
    },
    arm(kind: PlanSnapOverrideKind): void {
      armed = kind;
    },
    clear(): void {
      armed = null;
    },
    consumeAfterSnap(): boolean {
      if (!armed) return false;
      armed = null;
      return true;
    },
  };
}
