/**
 * Built-in schedule templates — v3.
 *
 * Adds international variations:
 *   • NRM 2 (UK)               — tpl-boq-nrm
 *   • DIN 276 (Germany)        — tpl-boq-din276
 *   • MasterFormat (US)        — tpl-boq-masterformat
 *   • GB/T 51269 (China)       — tpl-boq-gbt
 *   • JIS (Japan)              — tpl-boq-jis
 *   • IS 1200 (India)          — tpl-boq-is1200
 *   • AS 1181 (Australia)      — tpl-boq-as1181
 */
import type { ScheduleDefinition, GroupLevel, ConditionalRule } from "./schedule-types";
import { getColumnTemplate } from "./schedule-builder";
import { notify } from "../../core/notify";
import { services } from "../../core/services";

const C = (key: string, overrides: Record<string, any> = {}) => {
  const tpl = getColumnTemplate(key);
  if (!tpl) {
    return {
      key,
      header: key.charAt(0).toUpperCase() + key.slice(1),
      format: "text" as const,
      ...overrides,
    };
  }
  return { ...tpl, ...overrides };
};

const G = (key: string, subtotal = true): GroupLevel => ({ key, subtotal });

const RULE = {
  fireRed: (): ConditionalRule => ({
    id: "fire-60",
    column: "fireRating",
    op: "contains",
    value: "60",
    bg: "rgba(239,68,68,.15)",
    fg: "#fca5a5",
  }),
  highCost: (): ConditionalRule => ({
    id: "cost-top",
    column: "lineCost",
    op: "gt",
    value: 5000,
    bg: "rgba(245,158,11,.15)",
    fg: "#fbbf24",
    wholeRow: true,
  }),
};

const T = (
  id: string,
  name: string,
  category: string | null,
  columns: any[],
  grouping: GroupLevel[],
  sortBy: string,
  extra: Partial<ScheduleDefinition> = {},
): ScheduleDefinition => ({
  id,
  templateId: id,
  name,
  category,
  levelName: null,
  columns,
  grouping,
  sortBy,
  showTotals: true,
  useLiveQuantities: true,
  useCostData: true,
  updatedAt: Date.now(),
  ...extra,
});

/* ═════════════════════════════════════════════════════════════════════════
   Templates
   ═════════════════════════════════════════════════════════════════════════ */
export const BUILT_IN_TEMPLATES: ScheduleDefinition[] = [
  // ── Architectural ─────────────────────────────────────────────────
  T("tpl-door", "Door Schedule", "IFCDOOR",
    [C("mark"), C("type"), C("level"), C("width"), C("height"), C("fireRating"), C("panel"), C("costItem"), C("lineCost")],
    [G("level")], "mark",
    { description: "All doors with size, fire rating, panel type, and cost.",
      conditionalFormatting: [RULE.fireRed(), RULE.highCost()] }),

  T("tpl-window", "Window Schedule", "IFCWINDOW",
    [C("mark"), C("type"), C("level"), C("width"), C("height"), C("glazing"), C("costItem"), C("lineCost")],
    [G("level")], "mark",
    { description: "Windows with dimensions, glazing, and cost." }),

  T("tpl-room", "Room Schedule", "IFCSPACE",
    [C("mark", { key: "number", header: "Number" }), C("name"), C("level"), C("area"), C("volume")],
    [G("level")], "name",
    { description: "Spaces with area and volume." }),

  T("tpl-wall", "Wall Schedule", "IFCWALL",
    [C("type"), C("level"), C("length"), C("thickness"), C("height"), C("area"), C("volume"),
      C("netArea", { header: "Net area", format: "formula", unit: "m²", width: 100,
        formula: "[Area] * 0.85", help: "Gross area × 85% allowance" }),
      C("costItem"), C("lineCost")],
    [G("level"), G("type")], "type",
    { description: "Walls with length, area, volume, and cost.",
      conditionalFormatting: [RULE.highCost()] }),

  T("tpl-slab", "Slab Schedule", "IFCSLAB",
    [C("type"), C("level"), C("area"), C("thickness"), C("volume"), C("material"), C("costItem"), C("lineCost")],
    [G("level"), G("type")], "type",
    { description: "Slabs with area, thickness, and volume." }),

  // ── Structural ────────────────────────────────────────────────────
  T("tpl-beam", "Beam Schedule", "IFCBEAM",
    [C("type"), C("level"), C("length"), C("width"), C("height"), C("volume"), C("material"), C("costItem"), C("lineCost")],
    [G("level"), G("type")], "type",
    { description: "Beams with section, length, and weight." }),

  T("tpl-column", "Column Schedule", "IFCCOLUMN",
    [C("type"), C("level"), C("width"), C("depth"), C("height"), C("volume"), C("material"), C("costItem"), C("lineCost")],
    [G("level"), G("type")], "type",
    { description: "Columns with section, height, and volume." }),

  T("tpl-footing", "Footing Schedule", "IFCFOOTING",
    [C("type"), C("level"), C("width"), C("depth"), C("height"), C("volume"), C("material"), C("costItem"), C("lineCost")],
    [G("level"), G("type")], "type",
    { description: "Footings with size, volume, and cost." }),

  // ── MEP ───────────────────────────────────────────────────────────
  T("tpl-mep", "MEP Schedule", null,
    [C("systemType"), C("category"), C("type"), C("length"), C("width"), C("height"), C("count")],
    [G("systemType"), G("category")], "systemType",
    { description: "Ducts, pipes, cable trays, conduits with linear quantities." }),

  T("tpl-duct", "Duct Schedule", "IFCDUCTSEGMENT",
    [C("systemType"), C("type"), C("level"), C("length"), C("width"), C("height"), C("costItem"), C("lineCost")],
    [G("systemType"), G("level")], "systemType",
    { description: "Duct segments by system and level." }),

  T("tpl-pipe", "Pipe Schedule", "IFCPIPESEGMENT",
    [C("systemType"), C("type"), C("level"), C("length"), C("thickness"), C("material"), C("costItem"), C("lineCost")],
    [G("systemType"), G("level")], "systemType",
    { description: "Pipe segments by system and level." }),

  T("tpl-electrical", "Electrical Schedule", "IFCCABLECARRIERSEGMENT",
    [C("systemType"), C("type"), C("level"), C("length"), C("width"), C("costItem"), C("lineCost")],
    [G("systemType"), G("level")], "systemType",
    { description: "Cable trays, conduits, and electrical containment." }),

  // ── Material takeoff ──────────────────────────────────────────────
  T("tpl-material", "Material Takeoff", null,
    [C("material"), C("category"), C("count"), C("length"), C("area"), C("volume"),
      C("mass", { header: "Est. mass", format: "formula", unit: "t", width: 100,
        formula: "[Volume] * 2.4", help: "Volume × 2.4 t/m³" })],
    [G("material"), G("category")], "material",
    { description: "Aggregate quantities by material and category." }),

  // ── Cost / BOQ ────────────────────────────────────────────────────
  T("tpl-cost-summary", "Cost Summary", null,
    [C("costItem"), C("category"), C("count"), C("unitRate"), C("lineCost")],
    [G("category")], "category",
    { description: "Roll-up of cost items across all categories.",
      useLiveQuantities: false, conditionalFormatting: [RULE.highCost()] }),

  T("tpl-boq-nrm", "BOQ · NRM 2 (UK)", null,
    [C("costItem"), C("category"), C("count"), C("unitRate"), C("lineCost"),
      C("percentOfTotal", { header: "% of total", format: "percent", width: 90,
        formula: "IF(SUM([Total]) > 0, [Total] / SUM([Total]) * 100, 0)" })],
    [G("category")], "category",
    { description: "UK NRM 2-style BOQ grouped by cost category.",
      useLiveQuantities: false }),

  T("tpl-boq-din276", "BOQ · DIN 276 (DE)", null,
    [C("costItem", { header: "Kostengruppe" }), C("category"), C("count"),
      C("unitRate", { header: "EP", unit: "€" }),
      C("lineCost", { header: "GP", unit: "€" })],
    [G("category")], "category",
    { description: "German DIN 276-style cost groups with EP / GP columns.",
      useLiveQuantities: false }),

  T("tpl-boq-masterformat", "BOQ · MasterFormat (US)", null,
    [C("costItem", { header: "Section" }), C("category"), C("count"),
      C("unitRate", { unit: "$" }), C("lineCost", { unit: "$" })],
    [G("category")], "category",
    { description: "US MasterFormat 16-division cost summary.",
      useLiveQuantities: false }),

  T("tpl-boq-gbt", "BOQ · GB/T 51269 (CN)", null,
    [C("costItem", { header: "编码" }), C("category", { header: "类别" }),
      C("count", { header: "数量" }),
      C("unitRate", { header: "单价", unit: "¥" }),
      C("lineCost", { header: "合价", unit: "¥" })],
    [G("category")], "category",
    { description: "Chinese GB/T 51269 cost classification.",
      useLiveQuantities: false }),

  T("tpl-boq-jis", "BOQ · JIS (JP)", null,
    [C("costItem", { header: "科目" }), C("category", { header: "分類" }),
      C("count", { header: "数量" }),
      C("unitRate", { header: "単価", unit: "¥" }),
      C("lineCost", { header: "金額", unit: "¥" })],
    [G("category")], "category",
    { description: "Japanese JIS cost classification.",
      useLiveQuantities: false }),

  T("tpl-boq-is1200", "BOQ · IS 1200 (IN)", null,
    [C("costItem", { header: "Item" }), C("category"), C("count"),
      C("unitRate", { header: "Rate", unit: "₹" }),
      C("lineCost", { header: "Amount", unit: "₹" })],
    [G("category")], "category",
    { description: "Indian IS 1200 measurement standard.",
      useLiveQuantities: false }),

  T("tpl-boq-as1181", "BOQ · AS 1181 (AU)", null,
    [C("costItem"), C("category"), C("count"),
      C("unitRate", { unit: "A$" }), C("lineCost", { unit: "A$" })],
    [G("category")], "category",
    { description: "Australian AS 1181 measurement standard.",
      useLiveQuantities: false }),

  // ── 4D / Scheduling ───────────────────────────────────────────────
  T("tpl-4d-activity", "4D Activity Schedule", null,
    [C("systemType"), C("category"), C("count"), C("volume"),
      C("activity", { header: "Activity", hidden: true }),
      C("startDate", { header: "Start", format: "date", width: 100, hidden: true }),
      C("endDate", { header: "End", format: "date", width: 100, hidden: true })],
    [G("systemType")], "systemType",
    { description: "Elements grouped by system, ready for time assignment." }),

  // ── Quality ───────────────────────────────────────────────────────
  T("tpl-ids-compliance", "IDS Compliance Schedule", null,
    [C("category"), C("count"),
      C("hasName", { header: "Has Name", format: "formula", width: 90,
        formula: "IF(ISEMPTY([Name]), 0, 1)" }),
      C("hasType", { header: "Has Type", format: "formula", width: 90,
        formula: "IF(ISEMPTY([Type]), 0, 1)" }),
      C("complianceRate", { header: "Compliant %", format: "formula", unit: "%", width: 100,
        formula: "IF([Qty] > 0, ([Has Name] + [Has Type]) / ([Qty] * 2) * 100, 0)" })],
    [G("category")], "category",
    { description: "Element counts with property completeness checks.",
      useLiveQuantities: false, useCostData: false }),

  T("tpl-model-health", "Model Health Schedule", null,
    [C("category"), C("count"),
      C("hasVolume", { header: "Has volume", format: "formula", width: 100,
        formula: "IF([Volume] > 0, 1, 0)" }),
      C("hasArea", { header: "Has area", format: "formula", width: 100,
        formula: "IF([Area] > 0, 1, 0)" }),
      C("healthPct", { header: "Health %", format: "formula", unit: "%", width: 100,
        formula: "IF([Qty] > 0, ([Has volume] + [Has area]) / ([Qty] * 2) * 100, 0)" })],
    [G("category")], "category",
    { description: "Model quality check — which categories have quantities.",
      useLiveQuantities: true, useCostData: false }),
];

export const BUILT_IN_SCHEDULES = BUILT_IN_TEMPLATES;

export function getTemplate(id: string): ScheduleDefinition | undefined {
  return BUILT_IN_TEMPLATES.find((t) => t.id === id || t.templateId === id);
}

export function cloneTemplate(tpl: ScheduleDefinition): ScheduleDefinition {
  return {
    ...tpl,
    id: `sch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    columns: tpl.columns.map((c) => ({ ...c })),
    grouping: tpl.grouping?.map((g) => ({ ...g })),
    conditionalFormatting: tpl.conditionalFormatting?.map((r) => ({ ...r })),
    sortKeys: tpl.sortKeys?.map((s) => ({ ...s })),
    updatedAt: Date.now(),
  };
}

/* ── Command palette registration (Week 5) ───────────────────────────── */

let scheduleCommandsRegistered = false;

export function registerScheduleCommands(): void {
  if (scheduleCommandsRegistered) return;
  scheduleCommandsRegistered = true;

  void (async () => {
    let registerCommand: (cmd: {
      id: string;
      label: string;
      category?: string;
      hint?: string;
      run: () => void | Promise<void>;
    }) => void;
    try {
      const mod = await import("../../features/command-palette");
      registerCommand = mod.registerCommand;
    } catch {
      return;
    }

    for (const tpl of BUILT_IN_TEMPLATES) {
      registerCommand({
        id: `schedule.template.${tpl.id}`,
        label: `Schedule: ${tpl.name}`,
        category: "Schedules",
        hint: (tpl as any).description,
        run: async () => {
          services.tryUse("schedulesPanel")?.toggle();
          try {
            const genMod: any = await import("./schedule-generator");
            const run = await genMod.runSchedule(tpl);
            const dataRows = (run?.rows ?? []).filter((r: any) => !r.subtotal);
            notify("success", `${tpl.name}: ${dataRows.length} row(s)`);
          } catch (err) {
            notify("error", `Schedule failed: ${(err as Error).message}`);
          }
        },
      });
    }

    try {
      const store: any = await import("./schedule-store");
      const listFn = store.listSavedSchedules ?? store.listSchedules;
      if (typeof listFn !== "function") return;
      const saved = listFn() ?? [];
      for (const s of saved) {
        registerCommand({
          id: `schedule.saved.${s.id}`,
          label: `Saved schedule: ${s.name}`,
          category: "Schedules",
          hint: `${s.category ?? "All"}`,
          run: async () => {
            services.tryUse("schedulesPanel")?.toggle();
            try {
              const genMod: any = await import("./schedule-generator");
              const run = await genMod.runSchedule(s);
              notify("success", `${s.name}: ${(run?.rows ?? []).length} row(s)`);
            } catch (err) {
              notify("error", `Schedule failed: ${(err as Error).message}`);
            }
          },
        });
      }
    } catch {
      /* store optional */
    }
  })();
}
