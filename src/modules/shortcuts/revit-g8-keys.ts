/**
 * Revit 2D keyboard bindings — audit gap G8.
 *
 * Pure data + dispatch module (no DOM, no ctx imports) so the binding table
 * is unit-testable without booting the app. The live registrations live in
 * `src/features/bim-input-compatibility.ts`, which feeds this table into the
 * shortcut registry with the real environment callbacks.
 *
 * Revit mapping (TR is the breaking change):
 *   TR  Trim / Extend — was bound to Truss; Truss moves to TS.
 *   TS  Truss (new home; TS was unused).
 *   DI  Aligned Dimension, OF Offset, CO Copy, MI Mirror, AR Array, SC Scale,
 *   VG  Visibility/Graphics, TL Thin Lines.
 *   WT (Tile Views) and WC (Close Hidden) are deliberately NOT bound: views
 *   cannot tile until gap G12 lands, so advertising those keys would be a lie.
 *
 * Every target must name a command/tool that already exists and works:
 *   - modify.trimExtend is the immediate two-wall corner command in
 *     bim-experience.ts (trimExtendSelected); it requires exactly two
 *     authored line elements and is undoable.
 *   - copy/mirror/array/offset are real authoring tools (authoring.ts).
 *   - scale is the transform gizmo's scale mode (registry: "scale gizmo").
 *   - dim-aligned is the plan-view dimension tool (plan-view-panel.ts).
 *   - view.graphics is the Visibility/Graphics dialog (bim-experience.ts).
 *   - thin-lines is the view-graphics toggle (view-graphics.ts).
 */
export type RevitG8Target =
  | { kind: "bim-command"; id: string }
  | { kind: "authoring-tool"; tool: string }
  | { kind: "gizmo-mode"; mode: "scale" }
  | { kind: "plan-tool"; tool: string }
  | { kind: "thin-lines" };

export interface RevitG8Binding {
  readonly id: string;
  readonly label: string;
  /** Registry format: lowercase two-letter sequence. */
  readonly keys: string;
  readonly category: "tool" | "view";
  readonly target: RevitG8Target;
}

export const REVIT_G8_BINDINGS: readonly RevitG8Binding[] = [
  { id: "bim-tr", label: "Trim / Extend (BIM TR)", keys: "tr", category: "tool", target: { kind: "bim-command", id: "modify.trimExtend" } },
  { id: "bim-co", label: "Copy (BIM CO)", keys: "co", category: "tool", target: { kind: "authoring-tool", tool: "copy" } },
  { id: "bim-mi", label: "Mirror (BIM MI)", keys: "mi", category: "tool", target: { kind: "authoring-tool", tool: "mirror" } },
  { id: "bim-ar", label: "Array (BIM AR)", keys: "ar", category: "tool", target: { kind: "authoring-tool", tool: "array" } },
  { id: "bim-of", label: "Offset (BIM OF)", keys: "of", category: "tool", target: { kind: "authoring-tool", tool: "offset" } },
  { id: "bim-sc", label: "Scale (BIM SC)", keys: "sc", category: "tool", target: { kind: "gizmo-mode", mode: "scale" } },
  { id: "bim-di", label: "Aligned Dimension (BIM DI)", keys: "di", category: "tool", target: { kind: "plan-tool", tool: "dim-aligned" } },
  { id: "bim-vg", label: "Visibility / Graphics (BIM VG)", keys: "vg", category: "view", target: { kind: "bim-command", id: "view.graphics" } },
  { id: "bim-tl", label: "Thin Lines (BIM TL)", keys: "tl", category: "view", target: { kind: "thin-lines" } },
];

/** Truss's new home. TR belonged to Truss before G8; it now means Trim/Extend. */
export const TRUSS_KEYS = "ts";
export const TRIM_EXTEND_KEYS = "tr";

/** Keys Revit uses that this app deliberately leaves unbound (see header). */
export const G8_UNBOUND_KEYS: readonly string[] = ["wt", "wc"];

export function findG8Binding(keys: string): RevitG8Binding | undefined {
  const k = keys.toLowerCase();
  return REVIT_G8_BINDINGS.find((b) => b.keys === k);
}

/**
 * Environment the live app supplies for one binding. Kept as plain
 * callbacks so the dispatch itself stays testable without DOM/ctx.
 */
export interface RevitG8Env {
  executeBimCommand: (id: string) => void;
  setAuthoringTool: (tool: string) => void;
  setGizmoMode: (mode: "scale") => void;
  openPlanTool: (tool: string) => void;
  toggleThinLines: () => void;
}

/** Run one binding against the environment. Unknown target kinds throw. */
export function runG8Binding(binding: RevitG8Binding, env: RevitG8Env): void {
  const t = binding.target;
  switch (t.kind) {
    case "bim-command":
      env.executeBimCommand(t.id);
      return;
    case "authoring-tool":
      env.setAuthoringTool(t.tool);
      return;
    case "gizmo-mode":
      env.setGizmoMode(t.mode);
      return;
    case "plan-tool":
      env.openPlanTool(t.tool);
      return;
    case "thin-lines":
      env.toggleThinLines();
      return;
    default:
      throw new Error(`Unknown Revit G8 target kind: ${(t as { kind: string }).kind}`);
  }
}
