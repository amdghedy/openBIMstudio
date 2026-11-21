/**
 * Ribbon tab order model — Revit 2D environment audit gap G1a.
 *
 * The single source of truth for the order of the permanent ribbon tabs in
 * `src/shell/ribbon.ts` (`TABS`) and the group order inside each tab.
 * `tests/ribbon-tab-order.test.cjs` pins `TABS` to this model, so the two
 * cannot drift apart silently: change the order here first, then move the
 * tab blocks in `ribbon.ts` to match.
 *
 * Target order is Revit's ribbon order (Revit 2015 Getting Started Guide):
 * Architecture, Structure, Systems, Insert, Annotate, Analyze,
 * Massing & Site, Collaborate, View, Manage, Add-Ins, Modify (contextual).
 *
 * Documented deviations from Revit (deliberate, not oversights):
 * - `file` is kept as a permanent tab. Revit has no File tab — it has the
 *   application menu. A browser app has no application menu, so the File
 *   tab is the honest equivalent (New/Open/Save/Export live there).
 * - `edit` stays a permanent tab instead of being demoted to contextual-only.
 *   Demotion would strand its selection-independent dialog launchers (Solid
 *   Forms, Modify Engine, Group 1 Tools, Snap settings, BIM Objects): the
 *   contextual Modify tab only appears while a tool is active or elements
 *   are selected, so those tools would have no ribbon home. The contextual
 *   Modify tab itself is unchanged and still appears on selection/placement.
 * - `coordinate`, `clash` and `cost` ("X Dim") have no Revit counterpart.
 *   They are kept, unchanged in content, as clearly-marked product tabs
 *   AFTER Manage (`product: true` below) rather than deleted or force-fit
 *   under View/Manage/Analyze — the 10-group Clash Detective tab would
 *   swamp Analyze, and Coordinate's Measure tool is G2's to relocate.
 * - There is no Add-Ins tab: the plugin/marketplace entries live under
 *   Manage → Plugins / Marketplace, as before.
 *
 * G1a changes, relative to the pre-G1a order
 * (File, Architecture, Structure, Mechanical, Electrical, Insert, Annotate,
 * Analyze, Massing & Site, Coordinate, Clash Detective, Edit, View, Manage,
 * X Dim):
 * - `mechanical` + `electrical` merged into `systems`. Every tool survives:
 *   the Electrical tab's Containment/Power/Lighting/Equipment groups are
 *   folded into one "Electrical" group (tools in original order); the
 *   duplicate "Equip" button (same `equipment` tool, already in HVAC) was
 *   dropped, not the tool. Mechanical's old "Fire" label never rendered
 *   (no `sep()` before the "Systems" label overwrote it); Systems now
 *   separates every group with `sep()` so all labels render.
 * - New `collaborate` tab: "Live Sync" + "Worksets", moved verbatim from
 *   Manage. Share links do not exist on this base yet (unlanded
 *   differentiator branch `feat/share-live-model-link`); they join this
 *   tab when that branch lands.
 * - "MEP Delivery" workspace (`WORKSPACES` in ribbon.ts) now lands on
 *   `systems` instead of the removed `mechanical` id.
 */

export interface RibbonTabOrder {
  /** Stable tab id — the `data-tab` value and the `TABS` entry id. */
  id: string;
  /** Visible tab label. */
  label: string;
  /** Group labels in render order (`groupLabel(...)` sequence in TABS). */
  groups: readonly string[];
  /**
   * Placed after Manage as a documented deviation from the Revit order:
   * either no Revit counterpart at all (Coordinate / Clash Detective /
   * X Dim) or Revit has it contextual-only while this tab stays permanent
   * (Edit). Never true for a tab in the Revit-ordered run.
   */
  product?: true;
  /** Human-readable reason this tab deviates from the Revit order, if any. */
  deviation?: string;
}

export const RIBBON_TAB_ORDER: readonly RibbonTabOrder[] = [
  {
    id: "file",
    label: "File",
    groups: ["App", "New", "Open", "Export", "Doc", "AI"],
    deviation:
      "Revit has no File tab (application menu). Kept as the browser equivalent.",
  },
  {
    id: "architecture",
    label: "Architecture",
    groups: [
      "Build",
      "Openings",
      "Adaptive",
      "Datum",
      "Circulation",
      "Direct Modeling",
      "Sweeps",
      "Constraints",
      "Massing",
      "Properties",
    ],
  },
  {
    id: "structure",
    label: "Structure",
    groups: ["Framing", "Foundations", "Connections", "Truss Builder", "Reinforcement", "Properties"],
  },
  {
    id: "systems",
    label: "Systems",
    groups: [
      "HVAC",
      "Auto-Route",
      "Plumbing",
      "Fire",
      "Electrical",
      "Systems",
      "Display",
      "Engineering",
      "Properties",
    ],
  },
  {
    id: "insert",
    label: "Insert",
    groups: [
      "Link / Import",
      "Link CAD / BIM",
      "Fabrication",
      "Load from Library",
      "Placement",
      "Ext",
      "Analysis",
      "Views",
    ],
  },
  {
    id: "annotate",
    label: "Annotate",
    groups: ["Graphics", "Dimension", "Chain", "Keynotes", "Detail", "Text", "Legend"],
  },
  {
    id: "analyze",
    label: "Analyze",
    groups: [
      "Model Checker",
      "Health & QA",
      "Daylight",
      "Energy",
      "Loads",
      "Generative",
      "MEP Analysis",
      "AI",
      "Structural FEM",
      "Hydraulics",
    ],
  },
  {
    id: "massing-site",
    label: "Massing & Site",
    groups: ["Topo", "Property", "Site", "Massing"],
  },
  {
    id: "collaborate",
    label: "Collaborate",
    groups: ["Live Sync", "Worksets"],
  },
  {
    id: "view",
    label: "View",
    groups: [
      "Section",
      "Crop",
      "Crop View",
      "Selection",
      "Filters",
      "Schedules",
      "Select",
      "Graphics",
      "Presentation",
      "Create",
      "Schedules",
      "Sheets",
      "Orient",
      "Windows",
      "Bars",
      "Windows",
    ],
  },
  {
    id: "manage",
    label: "Manage",
    groups: [
      "Parameters",
      "View Tools",
      "Plugins",
      "Performance",
      "Analysis",
      "Marketplace",
      "Links",
      "Project",
      "Position",
      "Production",
      "Selection",
      "Reset",
      "Panels",
    ],
  },
  {
    id: "coordinate",
    label: "Coordinate",
    groups: ["Review", "Placement"],
    product: true,
    deviation: "No Revit counterpart; kept after Manage. Measure moves to the contextual Modify tab in G2.",
  },
  {
    id: "clash",
    label: "Clash Detective",
    groups: [
      "Clash Rules",
      "Tests",
      "Select",
      "Rules",
      "Run",
      "Review",
      "Status",
      "Isolate",
      "Report",
      "Coordinates",
    ],
    product: true,
    deviation: "No Revit counterpart; kept after Manage (too large to fold into Analyze).",
  },
  {
    id: "edit",
    label: "Edit",
    groups: [
      "Select",
      "Clipboard",
      "BIM Authoring",
      "Element",
      "Gizmo",
      "Solid Forms",
      "Modify Engine",
      "Group 1 Tools (v71)",
      "Snaps",
      "Focus",
    ],
    product: true,
    deviation:
      "Revit's Modify is contextual-only. Edit stays permanent: its Solid Forms / Modify Engine / Group 1 dialog launchers are selection-independent and would have no ribbon home otherwise.",
  },
  {
    id: "cost",
    label: "X Dim",
    groups: [
      "4D Simulation",
      "P6 Planning",
      "Assign to model",
      "5D Cost",
      "6D Carbon",
      "Schedules & BOQ",
      "Reports",
    ],
    product: true,
    deviation: "No Revit counterpart; kept after Manage.",
  },
] as const;

export const RIBBON_TAB_IDS: readonly string[] = RIBBON_TAB_ORDER.map((t) => t.id);

/** Tabs in the Revit-ordered run — everything up to and including Manage. */
export const RIBBON_REVIT_TAB_IDS: readonly string[] = RIBBON_TAB_ORDER.filter(
  (t) => !t.product,
).map((t) => t.id);

/** Deviation tabs kept after Manage (no Revit counterpart, or Edit's permanent placement). */
export const RIBBON_PRODUCT_TAB_IDS: readonly string[] = RIBBON_TAB_ORDER.filter(
  (t) => t.product,
).map((t) => t.id);
