/**
 * Project Browser tree model — Revit 2D environment audit gap G11.
 *
 * Pure, DOM-free model for the Project Browser hierarchy, so node tests can
 * execute it directly (compiled with tsc) instead of asserting on DOM.
 *
 * Revit order (audit §2 G11; stable facts: Views first, Sheets before
 * Schedules, Groups before Links):
 *   Views, Sheets, Schedules/Quantities, Families, Groups, Models & Links,
 *   4D Phases.
 *
 * The Views node is subgrouped by view kind (Floor Plans / Ceiling Plans /
 * Elevations / Sections / 3D Views / Detail Views / Drafting Views /
 * Legends), mirroring Revit's browser. A kind subgroup is rendered only
 * when it has something in it: a stored view of that kind, or — for
 * Floor Plans and 3D Views — the app's built-in quick entry (the plan-view
 * panel / the default 3D view). No empty groups are created for view kinds
 * the engine cannot produce: a kind with no stored views and no built-in
 * entry simply has no subgroup. Saved views get their own subgroup.
 *
 * Families lists family definitions with their types as children, plus a
 * Materials subgroup (materials are still listed, as before).
 */

export type ProjectBrowserNodeKind =
  | "root"
  | "views"
  | "view-group"
  | "view-3d"
  | "view-plan"
  | "view-def"
  | "view-saved"
  | "schedules"
  | "schedule"
  | "sheets"
  | "sheet"
  | "families"
  | "family"
  | "family-type"
  | "materials"
  | "material"
  | "links"
  | "link"
  | "groups"
  | "group"
  | "phases"
  | "phase";

export interface ProjectBrowserNode {
  id: string;
  kind: ProjectBrowserNodeKind;
  label: string;
  icon: string;
  count?: number;
  children?: ProjectBrowserNode[];
  meta?: Record<string, unknown>;
}

/** Everything buildTree() needs, gathered by the DOM layer. */
export interface ProjectBrowserTreeInput {
  links: { id: string; label: string }[];
  savedViews: { id: string; name: string }[];
  sheets: { id: string; number: string; name: string }[];
  materials: { id: string; name: string }[];
  families: { id: string; name: string; builtIn?: boolean; types: { id: string; name: string }[] }[];
  groups: { id: string; name: string }[];
  phases: { id: string; name: string; elementCount: number }[];
  /** Stored views from the views module (ViewDef kind + name). */
  views: { id: string; kind: string; name: string }[];
}

/** Root node ids in Revit order. */
export const PROJECT_BROWSER_ROOT_ORDER: readonly string[] = [
  "views",
  "sheets",
  "schedules",
  "families",
  "groups",
  "links",
  "phases",
];

/**
 * View-kind subgroups in Revit browser order. `quickEntry` is the built-in
 * leaf that keeps the subgroup non-empty even with no stored views of that
 * kind (the plan-view panel for Floor Plans, the default 3D view for
 * 3D Views); kinds without one render only when a stored view exists.
 */
export const VIEW_KIND_GROUPS: readonly {
  kind: string;
  label: string;
  icon: string;
  quickEntry?: { id: string; kind: ProjectBrowserNodeKind; label: string; icon: string };
}[] = [
  {
    kind: "plan",
    label: "Floor Plans",
    icon: "📐",
    quickEntry: { id: "view-plan", kind: "view-plan", label: "Floor Plan", icon: "📐" },
  },
  { kind: "rcp", label: "Ceiling Plans", icon: "🔲" },
  { kind: "elevation", label: "Elevations", icon: "🏔" },
  { kind: "section", label: "Sections", icon: "✂️" },
  {
    kind: "3d",
    label: "3D Views",
    icon: "🧊",
    quickEntry: { id: "view-3d", kind: "view-3d", label: "3D View", icon: "🔲" },
  },
  { kind: "detail", label: "Detail Views", icon: "🔍" },
  { kind: "drafting", label: "Drafting Views", icon: "✏️" },
  { kind: "legend", label: "Legends", icon: "📜" },
];

const MAX_MATERIALS = 40;

function viewDefNode(v: { id: string; name: string }): ProjectBrowserNode {
  return {
    id: `viewdef-${v.id}`,
    kind: "view-def",
    label: v.name,
    icon: "👁",
    meta: { viewId: v.id },
  };
}

export function buildProjectBrowserTree(input: ProjectBrowserTreeInput): ProjectBrowserNode[] {
  const byKind = new Map<string, { id: string; name: string }[]>();
  for (const v of input.views) {
    const list = byKind.get(v.kind) ?? [];
    list.push({ id: v.id, name: v.name });
    byKind.set(v.kind, list);
  }

  // ── Views: subgrouped by kind ──────────────────────────────────────────
  const viewGroups: ProjectBrowserNode[] = [];
  for (const g of VIEW_KIND_GROUPS) {
    const stored = byKind.get(g.kind) ?? [];
    const children: ProjectBrowserNode[] = [];
    if (g.quickEntry) children.push({ ...g.quickEntry });
    for (const v of stored) children.push(viewDefNode(v));
    // No empty groups: render only when the subgroup has something in it.
    if (!children.length) continue;
    viewGroups.push({
      id: `views-${g.kind}`,
      kind: "view-group",
      label: g.label,
      icon: g.icon,
      count: children.length,
      children,
    });
  }
  // Saved views live under their own subgroup, after the kind groups.
  if (input.savedViews.length) {
    viewGroups.push({
      id: "views-saved",
      kind: "view-group",
      label: "Saved Views",
      icon: "📷",
      count: input.savedViews.length,
      children: input.savedViews.map((v) => ({
        id: `view-${v.id}`,
        kind: "view-saved" as const,
        label: v.name,
        icon: "📷",
        meta: { viewId: v.id },
      })),
    });
  }

  // ── Sheets ──────────────────────────────────────────────────────────────
  const sheetNodes: ProjectBrowserNode[] = input.sheets.map((s) => ({
    id: `sheet-${s.id}`,
    kind: "sheet" as const,
    label: `${s.number} — ${s.name}`,
    icon: "📄",
    meta: { sheetId: s.id },
  }));

  // ── Schedules/Quantities (schedule-kind stored views belong here, Revit-style) ──
  const scheduleNodes: ProjectBrowserNode[] = [
    { id: "sch-open", kind: "schedule", label: "Open Schedules panel", icon: "📋" },
    { id: "sch-cost", kind: "schedule", label: "Cost / QTO", icon: "💰" },
    ...(byKind.get("schedule") ?? []).map((v) => ({
      ...viewDefNode(v),
      icon: "📊",
    })),
  ];

  // ── Families: family types + materials ──────────────────────────────────
  const familyNodes: ProjectBrowserNode[] = input.families.map((f) => ({
    id: `fam-${f.id}`,
    kind: "family" as const,
    label: f.name,
    icon: "🏠",
    count: f.types.length,
    // The right-click menu needs this: the family store refuses to remove
    // built-ins, so Delete is shown disabled for them (G11 menu model).
    meta: { builtIn: f.builtIn === true },
    children: f.types.map((t) => ({
      id: `famtype-${f.id}-${t.id}`,
      kind: "family-type" as const,
      label: t.name,
      icon: "🔹",
      meta: { familyId: f.id, typeId: t.id },
    })),
  }));
  const materialNodes: ProjectBrowserNode[] = input.materials.slice(0, MAX_MATERIALS).map((m) => ({
    id: `mat-${m.id}`,
    kind: "material" as const,
    label: m.name,
    icon: "🧱",
    meta: { materialId: m.id },
  }));
  const familyChildren: ProjectBrowserNode[] = [
    ...familyNodes,
    {
      id: "families-materials",
      kind: "materials",
      label: "Materials",
      icon: "🧱",
      count: materialNodes.length,
      children: materialNodes,
    },
  ];

  // ── Groups / Models & Links / 4D Phases ─────────────────────────────────
  const groupNodes: ProjectBrowserNode[] = input.groups.map((s) => ({
    id: `grp-${s.id}`,
    kind: "group" as const,
    label: s.name,
    icon: "🧩",
    meta: { setId: s.id },
  }));
  const linkNodes: ProjectBrowserNode[] = input.links.map((l) => ({
    id: `link-${l.id}`,
    kind: "link" as const,
    label: l.label,
    icon: "📦",
    meta: { modelId: l.id },
  }));
  const phaseNodes: ProjectBrowserNode[] = input.phases.map((p) => ({
    id: `phase-${p.id}`,
    kind: "phase" as const,
    label: p.name,
    icon: "⏱",
    count: p.elementCount,
    meta: { phaseId: p.id },
  }));

  return [
    {
      id: "views",
      kind: "views",
      label: "Views (all)",
      icon: "🗂",
      children: viewGroups,
    },
    {
      id: "sheets",
      kind: "sheets",
      label: "Sheets (all)",
      icon: "📑",
      count: sheetNodes.length,
      children: sheetNodes.length
        ? sheetNodes
        : [{ id: "sheet-empty", kind: "sheet", label: "(no sheets — create default set)", icon: "＋" }],
    },
    {
      id: "schedules",
      kind: "schedules",
      label: "Schedules/Quantities (all)",
      icon: "📊",
      children: scheduleNodes,
    },
    {
      id: "families",
      kind: "families",
      label: "Families",
      icon: "🏗",
      count: input.families.length + input.materials.length,
      children: familyChildren,
    },
    {
      id: "groups",
      kind: "groups",
      label: "Groups",
      icon: "📁",
      count: groupNodes.length,
      children: groupNodes.length
        ? groupNodes
        : [{ id: "grp-empty", kind: "group", label: "(save a selection set first)", icon: "＋" }],
    },
    {
      id: "links",
      kind: "links",
      label: "Models & Links",
      icon: "🔗",
      count: linkNodes.length,
      children: linkNodes.length
        ? linkNodes
        : [{ id: "link-empty", kind: "link", label: "(no models — Insert → Link IFC)", icon: "＋" }],
    },
    {
      id: "phases",
      kind: "phases",
      label: "4D Phases",
      icon: "📅",
      count: phaseNodes.length,
      children: phaseNodes.length
        ? phaseNodes
        : [{ id: "phase-empty", kind: "phase", label: "(create default phases)", icon: "＋" }],
    },
  ];
}

/**
 * Filter the tree by node name, as-you-type. Case-insensitive substring.
 * A node is kept when its own label matches (with its whole subtree) or
 * when any descendant matches (ancestors kept, children pruned to matches).
 * An empty query returns the tree unchanged.
 */
export function filterProjectBrowserTree(
  nodes: ProjectBrowserNode[],
  query: string,
): ProjectBrowserNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const out: ProjectBrowserNode[] = [];
  for (const n of nodes) {
    if (n.label.toLowerCase().includes(q)) {
      out.push(n);
      continue;
    }
    if (n.children?.length) {
      const kids = filterProjectBrowserTree(n.children, q);
      if (kids.length) out.push({ ...n, children: kids });
    }
  }
  return out;
}
