/**
 * Contextual Modify tab model — Revit 2D environment audit gap G2.
 *
 * Pure, DOM-free module: the single source of truth for what the
 * contextual `Modify | …` tab contains for a given selection.
 * `src/shell/ribbon.ts` renders this model (`selectionItems` /
 * `linkedSelectionItems`); `tests/modify-tab-completion.test.cjs` pins it.
 *
 * Revit reference (audit §2 G2, [MEP-2013]): the Modify tab panels are
 * Select, Properties, View, Measure, Geometry, Clipboard, Create, Modify,
 * Tag, Placement Tools; Filter sits in the Select panel; any selectable
 * element (including linked) gets a Modify tab.
 *
 * Documented deviations from Revit (deliberate, not oversights):
 * - Panel order keeps the existing openBIMstudio order (Select, Properties,
 *   Clipboard, Modify, Geometry, Constraints, Create, View, Measure) so
 *   this branch does not reorder panels users already know; Measure is
 *   appended as the last panel instead of slotted into Revit's position.
 *   Reordering the panels to Revit's order is G1/G6 territory.
 * - No Tag / Placement Tools panels: tagging is a separate Annotate-tab
 *   tool here and there is no placement-tools panel to mirror.
 * - Modify transforms on linked (IFC/FRAG) elements are OUT OF REACH
 *   without an edit path: a linked selection gets a view-only Modify tab
 *   (View / Visibility / Isolate + Make Editable) with the transform
 *   buttons present-but-disabled and the reason shown, never faked as
 *   working. See LINKED_NOT_EDITABLE_REASON.
 * - "Select Previous" restores a single stored snapshot (one slot, not a
 *   history stack): restoring swaps current ↔ previous, so pressing it
 *   twice returns to the starting selection. Revit's Ctrl+Left binding is
 *   NOT registered here: Ctrl+Arrow keys are owned by the arrow-key nudge
 *   handler (`src/features/authoring.ts`, no ctrlKey guard), so the key is
 *   contested and the binding decision belongs to the G8 keyboard worker.
 *   The command + ribbon button ship now; the binding is G8's follow-up.
 */

export type ModifyTabSourceKind = "native" | "fragment" | "linked";

export interface ModifyTabElement {
  readonly id: string;
  /** Element type for authored elements ("wall", "column", …); IFC class
   *  ("IfcWall", …) for linked/fragment elements. */
  readonly category: string;
  readonly sourceKind: ModifyTabSourceKind;
}

export interface ModifyTabButton {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  /** Shown as the button tooltip / reason line when disabled. */
  readonly reason?: string;
}

export interface ModifyTabPanel {
  readonly label: string;
  readonly buttons: readonly ModifyTabButton[];
}

export type ModifyTabKind = "authored" | "linked" | "mixed";

export interface ModifyTabModel {
  readonly kind: ModifyTabKind;
  /** Full tab label, e.g. "Modify | Walls" / "Modify | Linked Selection". */
  readonly title: string;
  readonly panels: readonly ModifyTabPanel[];
  /** Explanatory line rendered under the strip (linked / mixed only). */
  readonly note?: string;
  readonly authoredCount: number;
  readonly linkedCount: number;
}

/** Reason shown (button tooltip + strip note) when a linked element cannot
 *  be transformed. */
export const LINKED_NOT_EDITABLE_REASON =
  "Linked elements are not editable — transforms are disabled. Use Make Editable to create an editable native twin.";

const btn = (id: string, label: string, enabled = true, reason?: string): ModifyTabButton =>
  reason !== undefined ? { id, label, enabled, reason } : { id, label, enabled };

/** Plural tab-label names for authored element types. Mirrors
 *  `selectionCategory` in `src/features/modify-options.ts` (kept here so
 *  this module stays dependency-free for the node test). */
const CATEGORY_PLURALS: Record<string, string> = {
  wall: "Walls", "curtain-wall": "Curtain Walls", beam: "Beams", strip: "Wall Foundations",
  duct: "Ducts", pipe: "Pipes", "cable-tray": "Cable Trays", conduit: "Conduits",
  column: "Columns", slab: "Floors", footing: "Isolated Foundations", brace: "Braces",
  door: "Doors", window: "Windows", truss: "Trusses", stairs: "Stairs",
  railing: "Railings", ramp: "Ramps", equipment: "Components",
};

/** Display name for a selection category: plural for known authored types,
 *  the raw IFC class for linked categories, Title-case + "s" otherwise. */
export function categoryLabel(category: string): string {
  const known = CATEGORY_PLURALS[category];
  if (known) return known;
  if (/^ifc/i.test(category)) return category;
  const titled = category.charAt(0).toUpperCase() + category.slice(1);
  return titled.endsWith("s") ? titled : `${titled}s`;
}

/**
 * Normalise a category for comparison — same rule as
 * `normalizeSelectionCategory` in `src/features/selection.ts`: lowercase,
 * drop a leading "ifc", drop non-alphanumerics. Lets a Filter choice of
 * "Walls" match authored type "wall" and IFC class "IfcWall" alike.
 */
export function normalizeCategory(value: string): string {
  return value.trim().toLowerCase().replace(/^ifc/, "").replace(/[^a-z0-9]/g, "");
}

/** Categories present in a selection, with counts, most-common first. */
export function selectionCategories(
  elements: readonly ModifyTabElement[],
): Array<{ category: string; count: number }> {
  const counts = new Map<string, number>();
  for (const el of elements) counts.set(el.category, (counts.get(el.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || categoryLabel(a.category).localeCompare(categoryLabel(b.category)));
}

/**
 * Keep only the elements whose category is in `categories` (normalised
 * comparison). An empty `categories` list keeps nothing — the caller
 * (Filter dialog) toasts that the selection was emptied.
 */
export function filterElementsByCategories(
  elements: readonly ModifyTabElement[],
  categories: readonly string[],
): ModifyTabElement[] {
  const wanted = new Set(categories.map(normalizeCategory));
  return elements.filter((el) => wanted.has(normalizeCategory(el.category)));
}

/**
 * Fragment-side Filter: keep the local ids whose category (from the
 * model's `getItemsOfCategories` map) is in `categories`. Ids with no
 * known category are dropped — a category index that cannot be read must
 * not silently keep elements the user filtered out.
 */
export function filterFragmentIdsByCategories(
  categoryById: ReadonlyMap<number, string>,
  ids: Iterable<number>,
  categories: readonly string[],
): number[] {
  const wanted = new Set(categories.map(normalizeCategory));
  const kept: number[] = [];
  for (const id of ids) {
    const category = categoryById.get(id);
    if (category !== undefined && wanted.has(normalizeCategory(category))) kept.push(id);
  }
  return kept;
}

function isLinked(el: ModifyTabElement): boolean {
  return el.sourceKind === "fragment" || el.sourceKind === "linked";
}

const TRANSFORM_BUTTONS: Array<{ id: string; label: string }> = [
  { id: "move", label: "Move" },
  { id: "copy-move", label: "Copy Move" },
  { id: "rotate", label: "Rotate" },
  { id: "mirror", label: "Mirror" },
  { id: "array", label: "Array" },
  { id: "offset", label: "Offset" },
  { id: "scale", label: "Scale" },
  { id: "delete", label: "Delete" },
];

function authoredPanels(elements: readonly ModifyTabElement[]): ModifyTabPanel[] {
  const types = new Set(elements.filter((e) => !isLinked(e)).map((e) => e.category));
  const geometryButtons: ModifyTabButton[] = [
    btn("trim-extend", "Trim/Extend"),
    btn("split-mid", "Split at Midpoint"),
    btn("flip", "Flip"),
  ];
  if (types.has("wall") || types.has("curtain-wall")) geometryButtons.push(btn("join-walls", "Join Walls"));
  if (types.has("duct") || types.has("pipe") || types.has("cable-tray") || types.has("conduit")) {
    geometryButtons.push(btn("branch-network", "Branch / Network"));
  }
  return [
    {
      label: "Select",
      buttons: [
        btn("modify", "Modify"),
        btn("select-similar", "Select Similar"),
        btn("select-all", "Select All"),
        btn("clear", "Clear"),
        btn("filter", "Filter"),
        btn("select-previous", "Select Previous"),
      ],
    },
    {
      label: "Properties",
      buttons: [btn("properties", "Properties"), btn("type-properties", "Type Properties")],
    },
    {
      label: "Clipboard",
      buttons: [btn("copy", "Copy"), btn("paste", "Paste")],
    },
    {
      label: "Modify",
      buttons: [
        btn("move", "Move"),
        btn("copy-move", "Copy Move"),
        btn("rotate", "Rotate"),
        btn("mirror", "Mirror"),
        btn("array", "Array"),
        btn("offset", "Offset"),
        btn("scale", "Scale"),
        btn("align-h", "Align H"),
        btn("align-v", "Align V"),
        btn("delete", "Delete"),
      ],
    },
    { label: "Geometry", buttons: geometryButtons },
    {
      label: "Constraints",
      buttons: [btn("pin", "Pin"), btn("unpin", "Unpin")],
    },
    {
      label: "Create",
      buttons: [btn("create-similar", "Create Similar"), btn("match-props", "Match Properties")],
    },
    {
      label: "View",
      buttons: [
        btn("isolate", "Isolate"),
        btn("hide", "Hide"),
        btn("reveal", "Reveal"),
        btn("zoom", "Zoom"),
      ],
    },
    {
      label: "Measure",
      buttons: [btn("measure", "Measure"), btn("clear-measurements", "Clear Meas.")],
    },
  ];
}

function linkedPanels(): ModifyTabPanel[] {
  return [
    {
      label: "View",
      buttons: [
        btn("isolate", "Isolate"),
        btn("hide", "Hide"),
        btn("reveal", "Reveal"),
        btn("zoom", "Zoom"),
      ],
    },
    {
      label: "Linked",
      buttons: [btn("make-editable", "Make Editable")],
    },
    {
      label: "Modify",
      buttons: TRANSFORM_BUTTONS.map((t) => btn(t.id, t.label, false, LINKED_NOT_EDITABLE_REASON)),
    },
  ];
}

/**
 * Build the contextual Modify tab model for a selection.
 *
 * - Authored only → the full tab (Select + Filter + Select Previous,
 *   Properties, Clipboard, Modify, Geometry, Constraints, Create, View,
 *   Measure).
 * - Linked/fragment only → the view-only honest subset: View, Make
 *   Editable, and the transform buttons present-but-disabled with the
 *   reason.
 * - Mixed → the full authored tab (transforms apply to the authored
 *   elements; the registry already rejects linked elements per command),
 *   plus a note counting the linked elements the transforms skip.
 */
export function buildModifyTabModel(elements: readonly ModifyTabElement[]): ModifyTabModel {
  const authored = elements.filter((e) => !isLinked(e));
  const linked = elements.filter(isLinked);
  const authoredCount = authored.length;
  const linkedCount = linked.length;

  if (authoredCount === 0 && linkedCount > 0) {
    return {
      kind: "linked",
      title: "Modify | Linked Selection",
      panels: linkedPanels(),
      note: LINKED_NOT_EDITABLE_REASON,
      authoredCount,
      linkedCount,
    };
  }

  const authoredTypes = [...new Set(authored.map((e) => e.category))];
  const title =
    authoredTypes.length === 1
      ? `Modify | ${categoryLabel(authoredTypes[0])}`
      : "Modify | Multi-Select";
  const model: ModifyTabModel =
    linkedCount > 0
      ? {
          kind: "mixed",
          title,
          panels: authoredPanels(elements),
          note:
            `${linkedCount} linked element${linkedCount === 1 ? "" : "s"} also selected — ` +
            "transforms apply to the authored elements only.",
          authoredCount,
          linkedCount,
        }
      : { kind: "authored", title, panels: authoredPanels(elements), authoredCount, linkedCount };
  return model;
}

// ── Select Previous ──────────────────────────────────────────────────────

/** A selection snapshot: authored element ids + linked/fragment ids per model. */
export interface SelectionSnapshotData {
  readonly authoredIds: readonly string[];
  readonly linked: Readonly<Record<string, readonly number[]>>;
}

function normalizeSnapshot(snap: SelectionSnapshotData): SelectionSnapshotData {
  const authoredIds = [...new Set(snap.authoredIds)].sort();
  const linked: Record<string, number[]> = {};
  for (const [modelId, ids] of Object.entries(snap.linked ?? {})) {
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    if (sorted.length) linked[modelId] = sorted;
  }
  return { authoredIds, linked };
}

export function selectionSnapshotsEqual(a: SelectionSnapshotData, b: SelectionSnapshotData): boolean {
  const na = normalizeSnapshot(a);
  const nb = normalizeSnapshot(b);
  if (na.authoredIds.length !== nb.authoredIds.length) return false;
  if (!na.authoredIds.every((id, i) => id === nb.authoredIds[i])) return false;
  const ka = Object.keys(na.linked).sort();
  const kb = Object.keys(nb.linked).sort();
  if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
  return ka.every((k) => {
    const x = na.linked[k];
    const y = nb.linked[k];
    return x.length === y.length && x.every((id, i) => id === y[i]);
  });
}

/**
 * Single-slot previous-selection store. `noteCurrent` shifts the previous
 * slot only when the snapshot actually changed, so spurious callers (tool
 * changes, edits that re-emit the selection event) never clobber the
 * stored previous selection. Restoring swaps current ↔ previous.
 */
export class PreviousSelectionStore {
  private current: SelectionSnapshotData | null = null;
  private prev: SelectionSnapshotData | null = null;

  noteCurrent(snap: SelectionSnapshotData): void {
    const next = normalizeSnapshot(snap);
    if (this.current && selectionSnapshotsEqual(this.current, next)) return;
    this.prev = this.current;
    this.current = next;
  }

  get currentSnapshot(): SelectionSnapshotData | null {
    return this.current;
  }

  get previousSnapshot(): SelectionSnapshotData | null {
    return this.prev;
  }

  get hasPrevious(): boolean {
    return this.prev !== null;
  }

  reset(): void {
    this.current = null;
    this.prev = null;
  }
}
