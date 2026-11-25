/**
 * CAD snap overrides — AutoCAD parity gap A15.
 *
 * AutoCAD behaviour: during a command, typing a one-shot override at the
 * prompt (END, MID, CEN, INT, NEA, …) restricts the *next* snap pick to
 * that one snap type. The override is one-shot: it clears after the next
 * successful snap pick (or Esc / tool change). Right-click during a
 * command offers the same list (Snap Overrides).
 *
 * This module is the CAD-viewer flavour of the plan-view G14 module
 * (`src/modules/views/plan-snap-override.ts`): same two-letter keys
 * (SE/SM/SC/SI/SN) and the same one-shot state machine, so a user who
 * learned overrides in the plan view finds them working the same way in
 * the drawing editor. Pure module — no DOM, no ctx imports — so the
 * state machine, the key resolution and the honest omission table are
 * unit-testable without booting the app (G8 pattern). The live wiring
 * lives in `src/features/cad-viewer.ts`, which owns the keydown
 * interception, the right-click menu and the snap-path filter.
 *
 * Honest scope: the CAD snapper can produce every kind below (endpoint,
 * midpoint, centre, intersection, nearest all have producers in
 * `viewer-math.ts` findSnap). Perpendicular / tangent / quadrant also
 * have producers, but their two-letter keys are NOT bound in this
 * branch (see OMITTED_OVERRIDE_KEYS) — SP/ST/SQ are a follow-up once
 * the SC conflict pattern below is proven in the browser.
 *
 * SC is contested three ways — this is the resolution, written down so
 * the next reader does not "fix" it back:
 *   1. SC = SCALE command alias in the CAD command line
 *      (`CAD_COMMANDS`, cad-viewer.ts) — the AutoCAD alias.
 *   2. SC = G8 gizmo-scale binding in the global shortcut registry
 *      (`revit-g8-keys.ts` id "bim-sc").
 *   3. SC = snap-centre one-shot override (this module).
 * Resolution is context-dependent, exactly like the plan view:
 *   - While a CAD drafting tool is active (a point-awaiting tool, no
 *     pick/mod step), SC = snap-centre override: the CAD keydown
 *     handler consumes the pair before the command line ever sees it.
 *   - While no CAD tool is active, SC falls through to the command
 *     line, where it runs SCALE — the registry never fires inside the
 *     drawing editor at all, because it yields bare letters while the
 *     CAD editor owns the keyboard (`__obsCadOwnsKeys`, shortcuts.ts).
 * `resolveOverrideKeys` pins that precedence here.
 */

export type CadSnapOverrideKind =
  | "endpoint"
  | "midpoint"
  | "center"
  | "intersection"
  | "nearest";

export interface CadSnapOverrideEntry {
  readonly kind: CadSnapOverrideKind;
  /** Registry format: lowercase two-letter sequence. */
  readonly keys: string;
  readonly label: string;
}

/** The override types, in Revit/AutoCAD order. */
export const CAD_SNAP_OVERRIDE_ENTRIES: readonly CadSnapOverrideEntry[] = [
  { kind: "endpoint", keys: "se", label: "Endpoint" },
  { kind: "midpoint", keys: "sm", label: "Midpoint" },
  { kind: "center", keys: "sc", label: "Center" },
  { kind: "intersection", keys: "si", label: "Intersection" },
  { kind: "nearest", keys: "sn", label: "Nearest" },
];

export const CAD_SNAP_OVERRIDE_BY_KEYS: Readonly<Record<string, CadSnapOverrideKind>> =
  Object.fromEntries(CAD_SNAP_OVERRIDE_ENTRIES.map((e) => [e.keys, e.kind]));

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
 * Override keys this branch deliberately does NOT bind. Unlike the plan
 * snapper, the CAD snapper HAS producers for perpendicular / tangent /
 * quadrant — the omission here is scope, not capability: the five
 * plan-matching overrides come first, and SP/ST/SQ are a follow-up once
 * the SC conflict pattern is proven. ST additionally collides with the
 * STYLE command alias in the CAD command line, so it needs the same
 * context-dependent treatment as SC before it can be bound.
 */
export const OMITTED_OVERRIDE_KEYS: readonly OmittedOverrideKey[] = [
  { keys: "sp", label: "Perpendicular", reason: "not bound in this branch; the CAD snapper can produce perpendicular — follow-up once the SC pattern is proven" },
  { keys: "st", label: "Tangent", reason: "not bound in this branch; the CAD snapper can produce tangent, but ST is the STYLE command alias in the CAD viewer" },
  { keys: "sq", label: "Quadrant", reason: "not bound in this branch; the CAD snapper can produce quadrant — follow-up once the SC pattern is proven" },
  { keys: "sv", label: "Vertex", reason: "no vertex snap kind in the CAD snapper (polyline vertices surface as endpoints)" },
];

export function cadSnapOverrideLabel(kind: CadSnapOverrideKind): string {
  const entry = CAD_SNAP_OVERRIDE_ENTRIES.find((e) => e.kind === kind);
  return entry ? entry.label : kind;
}

/**
 * Resolve a two-letter sequence typed while the CAD drawing editor is open.
 *
 * @param first  first letter (lowercase)
 * @param second second letter (lowercase)
 * @param cadToolActive true while a CAD point-awaiting tool is active
 * @returns the override kind, or null when the pair is not an override
 *   in this context (the caller then falls through to the command line —
 *   e.g. SC falls through to the SCALE command when no CAD tool is
 *   active, and the G8 gizmo scale never fires inside the editor).
 */
export function resolveOverrideKeys(
  first: string,
  second: string,
  cadToolActive: boolean,
): CadSnapOverrideKind | null {
  if (!cadToolActive) return null;
  if (first.toLowerCase() !== "s") return null;
  return CAD_SNAP_OVERRIDE_BY_KEYS[(first + second).toLowerCase()] ?? null;
}

export interface CadSnapOverride {
  /** The armed kind, or null when no override is armed. */
  readonly active: CadSnapOverrideKind | null;
  /** Arm a one-shot override, replacing any previously armed one. */
  arm(kind: CadSnapOverrideKind): void;
  /** Disarm without consuming (Esc, tool change, explicit Clear). */
  clear(): void;
  /**
   * Consume the override after a successful snap pick: clears it and
   * returns true when one was armed, false when none was armed.
   * AutoCAD semantics: the override applies to the *next* snap only.
   */
  consumeAfterSnap(): boolean;
}

/** One-shot override state machine. Pure — no DOM, no timers. */
export function createCadSnapOverride(): CadSnapOverride {
  let armed: CadSnapOverrideKind | null = null;
  return {
    get active(): CadSnapOverrideKind | null {
      return armed;
    },
    arm(kind: CadSnapOverrideKind): void {
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
