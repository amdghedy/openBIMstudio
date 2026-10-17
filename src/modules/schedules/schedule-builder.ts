/**
 * Programmatic schedule builder.
 *
 * Turns a concise spec — { name, category, columns, grouping } — into a
 * full ScheduleDefinition. This is what the AI calls when it wants to
 * create a schedule. It resolves column keys against the standard set of
 * column templates and applies sensible defaults from the catalog.
 */
import {
  findCategory,
  CATEGORY_CATALOG,
  type CategoryEntry,
} from "./schedule-catalog";
import { saveSchedule, type StoredSchedule } from "./schedule-store";
import type {
  ScheduleColumn,
  ScheduleDefinition,
  GroupLevel,
  ConditionalRule,
  SortKey,
} from "./schedule-types";

/* ═════════════════════════════════════════════════════════════════════════
   Standard column shapes
   ═════════════════════════════════════════════════════════════════════════ */
const COLUMN_TEMPLATES: Record<string, ScheduleColumn> = {
  mark: { key: "mark", header: "Mark", format: "text", width: 90 },
  name: { key: "name", header: "Name", format: "text", width: 200 },
  type: { key: "type", header: "Type", format: "text", width: 140 },
  level: { key: "level", header: "Level", format: "text", width: 110 },
  category: { key: "category", header: "Category", format: "text", width: 140 },
  width: { key: "width", header: "Width", format: "length", unit: "m", width: 75 },
  height: { key: "height", header: "Height", format: "length", unit: "m", width: 75 },
  depth: { key: "depth", header: "Depth", format: "length", unit: "m", width: 75 },
  thickness: { key: "thickness", header: "Thickness", format: "length", unit: "m", width: 85 },
  length: { key: "length", header: "Length", format: "length", unit: "m", width: 85 },
  area: { key: "area", header: "Area", format: "area", unit: "m²", width: 90 },
  volume: { key: "volume", header: "Volume", format: "volume", unit: "m³", width: 90 },
  elevation: { key: "elevation", header: "Elevation", format: "length", unit: "m", width: 90 },
  count: { key: "count", header: "Qty", format: "count", width: 65 },
  material: { key: "material", header: "Material", format: "text", width: 140 },
  fireRating: { key: "fireRating", header: "Fire rating", format: "text", width: 90 },
  panel: { key: "panel", header: "Panel", format: "text", width: 100 },
  glazing: { key: "glazing", header: "Glazing", format: "text", width: 100 },
  systemType: { key: "systemType", header: "System", format: "text", width: 120 },
  costItem: { key: "costItem", header: "Cost item", format: "text", width: 160 },
  unitRate: { key: "unitRate", header: "Rate", format: "currency", unit: "$", width: 90 },
  lineCost: { key: "lineCost", header: "Total", format: "currency", unit: "$", width: 110 },
};

export function getColumnTemplate(key: string): ScheduleColumn | null {
  return COLUMN_TEMPLATES[key] ? { ...COLUMN_TEMPLATES[key] } : null;
}

export function listColumnTemplates(): ScheduleColumn[] {
  return Object.values(COLUMN_TEMPLATES).map((c) => ({ ...c }));
}

/* ═════════════════════════════════════════════════════════════════════════
   Spec → definition
   ═════════════════════════════════════════════════════════════════════════ */
export interface ScheduleSpec {
  name: string;
  /** Single category (IFC name) or null for multi-category. */
  category?: string | null;
  /** For multi-category schedules — list of IFC categories to include. */
  categories?: string[];
  /** Column keys in order. If omitted, uses the catalog default for the category. */
  columns?: string[];
  /** Extra column objects appended after the keys. */
  extraColumns?: ScheduleColumn[];
  /** Grouping column keys, top to bottom. */
  grouping?: string[];
  sortBy?: string;
  sortKeys?: SortKey[];
  filters?: ConditionalRule[];
  /** Whether to compute live quantities for each row. */
  useLiveQuantities?: boolean;
  /** Whether to compute cost columns for each row. */
  useCostData?: boolean;
  showTotals?: boolean;
  description?: string;
}

export function buildSchedule(spec: ScheduleSpec): ScheduleDefinition {
  const cat: CategoryEntry | undefined = spec.category
    ? findCategory(spec.category)
    : undefined;

  // Resolve columns — explicit > catalog default > generic fallback
  const columnKeys =
    spec.columns && spec.columns.length
      ? spec.columns
      : cat?.defaultColumns ?? ["type", "level", "count"];

  const columns: ScheduleColumn[] = [];
  for (const key of columnKeys) {
    const tpl = getColumnTemplate(key);
    if (tpl) columns.push(tpl);
    else
      columns.push({
        key,
        header: key.charAt(0).toUpperCase() + key.slice(1),
        format: "text",
        width: 120,
      });
  }
  if (spec.extraColumns) columns.push(...spec.extraColumns);

  // Grouping — explicit > catalog default
  const groupingKeys = spec.grouping ?? cat?.defaultGrouping ?? [];
  const grouping: GroupLevel[] = groupingKeys.map((key) => ({
    key,
    subtotal: true,
  }));

  // Sort — explicit > catalog default
  const sortBy = spec.sortBy ?? cat?.defaultSort ?? "type";

  return {
    id: `sch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: spec.name,
    description: spec.description ?? `Schedule for ${cat?.label ?? spec.category ?? "all categories"}`,
    category: spec.category ?? null,
    levelName: null,
    columns,
    grouping: grouping.length ? grouping : undefined,
    sortBy,
    sortKeys: spec.sortKeys,
    conditionalFormatting: spec.filters,
    useLiveQuantities: spec.useLiveQuantities ?? true,
    useCostData: spec.useCostData ?? true,
    showTotals: spec.showTotals ?? true,
    updatedAt: Date.now(),
  };
}

/** Build and persist in one call. */
export function buildAndSaveSchedule(spec: ScheduleSpec): StoredSchedule {
  const def = buildSchedule(spec);
  return saveSchedule(def);
}

/* ═════════════════════════════════════════════════════════════════════════
   AI-friendly helpers
   ═════════════════════════════════════════════════════════════════════════ */
export function availableColumnKeys(): string[] {
  return Object.keys(COLUMN_TEMPLATES);
}

export function availableCategories(): { ifc: string; label: string; discipline: string }[] {
  return CATEGORY_CATALOG.map((c) => ({
    ifc: c.ifc,
    label: c.label,
    discipline: c.discipline,
  }));
}