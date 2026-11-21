/**
 * Draw-tool order model — Revit 2D environment audit gap G6.
 *
 * The single source of truth for the order of the draw tools in the
 * Architecture Build group and the Structure Framing / Foundations groups
 * in `src/shell/ribbon.ts` (`TABS`). `tests/ribbon-draw-order.test.cjs`
 * pins `ribbon.ts` to this model, so the two cannot drift apart silently:
 * change the order here first, then move the buttons in `ribbon.ts` to
 * match.
 *
 * Target order is Revit's (audit §2 G6):
 * - Architecture Build: Wall, Door, Window, Component, Column, Roof,
 *   Ceiling, Floor, Curtain System, Railing, Ramp, Stair, then Room /
 *   Area / Model Text / Model Line / Model Group where placeable.
 * - Structure Framing: Beam, Beam System, Brace, Column, Wall, Floor
 *   (Truss closes the panel, as in Revit).
 * - Foundations: Isolated / Wall / Slab.
 * - Reinforcement: Rebar / Area / Path / Fabric.
 *
 * Two kinds of entries:
 * - `tool` — a native authoring tool started with `toolBtn`, which calls
 *   the module-level `setAuthoringTool`. These are tools the authoring
 *   click handler understands (`DRAW_TOOLS` / the placement switch in
 *   `src/features/authoring.ts`).
 * - `m2` — a Milestone-2 placement tool started with `startM2Tool`
 *   (`src/modules/bim-gaps/m2-tools.ts`): click points in the viewport
 *   (two-point tools: click start, then end; polyline tools: click
 *   points, double-click / Enter to finish; Esc cancels). These MUST NOT
 *   go through `toolBtn`: the ribbon calls the module-level
 *   `setAuthoringTool`, which bypasses the M2 redirect installed on
 *   `ctx.features.authoring` (`installM2Redirects`), and the authoring
 *   click handler has no case for stairs / railing / roof / ceiling —
 *   a `toolBtn` for one of them leaves a dead tool active. The shortcuts
 *   (ST / RA / RF / CL) and the command palette go through the wrapped
 *   feature method, so they already worked; the ribbon buttons did not.
 * - `button` — a command button (no placement tool behind it).
 *
 * The "Objects" button (`bimObjectStudioButton()`, the BIM Object Studio
 * library launcher) sits in the Build group between Comp and Column. It
 * is not a draw tool and is not in the order below; the test asserts it
 * is still present, exactly once, in the Build group.
 */

export type DrawToolEntry =
  | {
      kind: "tool";
      /** Authoring tool id — the 3rd argument of `toolBtn`. */
      tool: string;
      /** Button label. */
      label: string;
      /** Two-letter shortcut shown on the button, if bound. */
      kbd?: string;
    }
  | {
      kind: "m2";
      /** M2 kind — the 1st argument of `startM2Tool`. */
      tool: "stairs" | "railing" | "roof" | "ceiling";
      /** Stair shape; only meaningful for `stairs`. */
      shape?: "straight" | "L" | "U";
      /** Button label. */
      label: string;
      /** Two-letter shortcut shown on the button, if bound. */
      kbd?: string;
    }
  | {
      kind: "button";
      /** Button label. */
      label: string;
      /** Two-letter shortcut shown on the button, if bound. */
      kbd?: string;
    };

export const ARCHITECTURE_BUILD_ORDER: readonly DrawToolEntry[] = [
  { kind: "tool", tool: "wall", label: "Wall", kbd: "WA" },
  { kind: "tool", tool: "door", label: "Door", kbd: "DR" },
  { kind: "tool", tool: "window", label: "Window", kbd: "WN" },
  // Comp is the `equipment` tool (component / family instance placement).
  { kind: "tool", tool: "equipment", label: "Comp" },
  // "Objects" (BIM Object Studio launcher) sits here — not a draw tool.
  { kind: "tool", tool: "column", label: "Column", kbd: "CM" },
  { kind: "m2", tool: "roof", label: "Roof", kbd: "RF" },
  { kind: "m2", tool: "ceiling", label: "Ceiling", kbd: "CL" },
  // Floor places the `slab` tool.
  { kind: "tool", tool: "slab", label: "Floor", kbd: "SL" },
  { kind: "tool", tool: "curtain-wall", label: "Curtain Wall", kbd: "CW" },
  { kind: "m2", tool: "railing", label: "Railing", kbd: "RA" },
  // Ramp has no shortcut: the old "RM" kbd label was wrong — RM is Room
  // (bim-input-compatibility.ts), and Revit binds no key to Ramp.
  { kind: "tool", tool: "ramp", label: "Ramp" },
  { kind: "m2", tool: "stairs", shape: "straight", label: "Stair", kbd: "ST" },
  { kind: "tool", tool: "room", label: "Room", kbd: "RM" },
  { kind: "tool", tool: "mline", label: "Model Line" },
  // Model Group groups the current selection (same flow as the GP shortcut).
  { kind: "button", label: "Model Group", kbd: "GP" },
] as const;

/** Straight-run Stair lives in Build; the other shapes live in Circulation. */
export const CIRCULATION_STAIRS_ORDER: readonly DrawToolEntry[] = [
  { kind: "m2", tool: "stairs", shape: "L", label: "Stair L-Shape" },
  { kind: "m2", tool: "stairs", shape: "U", label: "Stair U-Shape" },
] as const;

export const STRUCTURE_FRAMING_ORDER: readonly DrawToolEntry[] = [
  { kind: "tool", tool: "beam", label: "Beam", kbd: "BM" },
  { kind: "tool", tool: "brace", label: "Brace", kbd: "BR" },
  { kind: "tool", tool: "column", label: "Column", kbd: "CM" },
  { kind: "tool", tool: "wall", label: "Wall" },
  { kind: "tool", tool: "slab", label: "Floor" },
  // Truss closes the panel, as in Revit's Structure panel.
  { kind: "tool", tool: "truss", label: "Truss", kbd: "TR" },
] as const;

export const STRUCTURE_FOUNDATIONS_ORDER: readonly DrawToolEntry[] = [
  { kind: "tool", tool: "footing", label: "Isolated", kbd: "FT" },
  { kind: "tool", tool: "strip", label: "Wall", kbd: "SF" },
  { kind: "tool", tool: "slab", label: "Slab" },
  // Pile has no Revit counterpart in the Foundations panel; kept after
  // Slab as a product extra rather than silently dropped.
  { kind: "tool", tool: "pile", label: "Pile" },
] as const;

/** Group labels renamed to Revit's panel names (were "Found" / "Rebar"). */
export const STRUCTURE_FOUNDATIONS_GROUP = "Foundations";
export const STRUCTURE_REINFORCEMENT_GROUP = "Reinforcement";

/**
 * Documented deviations and gaps — deliberate, not oversights. Each one
 * is pinned by `tests/ribbon-draw-order.test.cjs` (the absent tool is
 * asserted absent from the ribbon, so a later engine addition fails the
 * test until the model is updated to claim it).
 */
export const G6_DEVIATIONS: readonly string[] = [
  "Beam System (Structure Framing, Revit position 2): no beam-system tool or engine exists — no beamSystem type, no placement session. Not added.",
  "Slab Edge (Structure Foundations): no slab-edge tool or engine exists. Not added.",
  "Area / Path / Fabric reinforcement: no area/path/fabric rebar tools exist. The icon set has area-rebar / path-rebar icons but no code references them; the engine only generates rebar inside a selected host (Generate Rebar) plus BBS export and clash review. Not added — adding dead buttons would be a mock.",
  "Area placement (Architecture Build): no click-to-place area tool exists. roomsStore.createArea is store-only with no UI caller; the area-plans module is color-fill schemes only. Not added.",
  "Model Text (Architecture Build): no model-text element type or placement engine exists. Annotate > 3D text is a prompt that places an equipment marker as host, not a text element. Not added — duplicating that prompt into Build would fake a tool.",
  "Winder / Spiral stairs: no placement session exists. stairs.ts buildStair builds at a fixed origin and M2 geometry has no winder/spiral shape, so these two stay instant-build in Circulation rather than being dropped.",
  "Pile is kept in Foundations after Slab: Revit's Foundations panel has no Pile button, but removing a working tool would strand a flow. Documented extra.",
  "Openings group is kept (Opening, Shaft, Hosted Opening) after Door/Window move to Build: Revit has no Openings panel, but these tools have no Revit Build-panel home and are still used.",
  "Beam was removed from Architecture Build (it belongs under Structure only). Structure Framing keeps the only Beam button.",
  "Roof / Ceiling ribbon buttons were dead before this change (toolBtn set an activeTool the click handler never handles); they now start the M2 placement session directly, matching the RF / CL shortcuts.",
] as const;
