/**
 * Double-click dispatch — audit gap G5 (Revit 2D environment).
 *
 * Revit opens an editor appropriate to the double-clicked element; a full
 * Family Editor is out of reach in this workstream (no per-element family
 * edit session exists), so the reachable subset is: double-click a model
 * element opens Type Properties for that element (`modify.typeProperties`).
 *
 * Pure decision table + a thin performer over an environment of callbacks,
 * so the rule can be unit-tested without booting the app. The two live call
 * sites are `src/features/dblclick-fit.ts` (3D viewport) and the plan
 * double-click handler in `src/features/plan-view-panel.ts`.
 *
 * Rules (both views):
 *   annotation          -> edit the annotation text (plan; unchanged)
 *   dimension           -> edit the dimension text (plan; unchanged)
 *   authored element    -> open Type Properties for that element;
 *                          Shift+double-click keeps the old fit behaviour
 *   fragment element    -> fit the element (unchanged: linked IFC/FRAG
 *                          elements have no editable type defaults, so
 *                          opening Type Properties for them would be wrong)
 *   empty space         -> plan: fit the view (unchanged);
 *                          3D: nothing (unchanged — Revit's "do nothing")
 */
export type DoubleClickTarget =
  | { kind: "authored-element"; elementId: string }
  | { kind: "fragment-element"; modelId: string; localId: number }
  | { kind: "annotation" }
  | { kind: "dimension" }
  | { kind: "empty" };

export type DoubleClickAction =
  | { kind: "open-type-properties"; elementId: string }
  | { kind: "edit-annotation-text" }
  | { kind: "edit-dimension-text" }
  | { kind: "fit-element" }
  | { kind: "fit-view" }
  | { kind: "none" };

export interface DoubleClickOptions {
  /** Which view the double-click landed in. */
  view: "3d" | "plan";
  /** Shift held: preserves the old fit-on-double-click in 3D. */
  shiftKey: boolean;
}

export function resolveDoubleClickAction(
  target: DoubleClickTarget,
  opts: DoubleClickOptions,
): DoubleClickAction {
  switch (target.kind) {
    case "annotation":
      return { kind: "edit-annotation-text" };
    case "dimension":
      return { kind: "edit-dimension-text" };
    case "authored-element":
      // Shift keeps the pre-G5 behaviour (fit the element) available.
      return opts.shiftKey
        ? { kind: "fit-element" }
        : { kind: "open-type-properties", elementId: target.elementId };
    case "fragment-element":
      // Linked elements have no editable type defaults; keep fitting them.
      return { kind: "fit-element" };
    case "empty":
      // Plan keeps its whole-view fit; 3D keeps doing nothing (Revit parity).
      return opts.view === "plan" ? { kind: "fit-view" } : { kind: "none" };
  }
}

/** Callbacks the live call sites supply for the actions they own. */
export interface DoubleClickEnv {
  /** Make `elementId` the authored selection (Type Properties reads it). */
  selectAuthoredElement: (elementId: string) => void;
  /** Run the `modify.typeProperties` command for the current selection. */
  openTypeProperties: () => void;
  /** Fit the camera / view to the double-clicked element. */
  fitElement: () => void;
  /** Fit the whole view (plan empty-space double-click). */
  fitView: () => void;
}

/**
 * Perform an action resolved by {@link resolveDoubleClickAction}.
 * Text-edit actions are handled by the caller's own prompt flow and
 * `none` is an intentional no-op, so both are no-ops here by design.
 * Type Properties is opened only after the element is selected, because
 * `openTypeProperties` resolves the type from the current selection.
 */
export function performDoubleClickAction(
  action: DoubleClickAction,
  env: DoubleClickEnv,
): void {
  switch (action.kind) {
    case "open-type-properties":
      env.selectAuthoredElement(action.elementId);
      env.openTypeProperties();
      return;
    case "fit-element":
      env.fitElement();
      return;
    case "fit-view":
      env.fitView();
      return;
    case "edit-annotation-text":
    case "edit-dimension-text":
    case "none":
      return;
  }
}
