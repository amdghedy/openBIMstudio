/** Cost state: items, assignments, computations. Persisted via projects module. */
import { ctx } from "../../core/context";
import { emptyCostData, type CostAssignment, type CostData, type CostItem, type CostUnit, type TakeoffRow } from "./types";

let data: CostData = emptyCostData();
const listeners = new Set<() => void>();

export function onCostChanged(cb: () => void) { listeners.add(cb); }
function notify() { for (const cb of listeners) { try { cb(); } catch { /* */ } } }
function touch() { data.updatedAt = Date.now(); notify(); }

export function getCostData(): CostData { return data; }
export function setCostData(d: CostData | undefined | null) { data = d && typeof d === "object" ? d : emptyCostData(); data.assignments ??= {}; data.items ??= []; notify(); }

// ── Cost items CRUD ──
export function getItems(): CostItem[] { return data.items; }

export function addCostItem(patch: Partial<CostItem> = {}): CostItem {
  const item: CostItem = {
    id: (crypto as any).randomUUID?.() ?? `ci-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    code: patch.code ?? `C-${String(data.items.length + 1).padStart(3, "0")}`,
    name: patch.name ?? "New cost item",
    unit: (patch.unit ?? "m3") as CostUnit,
    rate: patch.rate ?? 0,
    category: patch.category ?? "General",
  };
  data.items.push(item);
  touch();
  return item;
}

export function updateCostItem(id: string, patch: Partial<CostItem>) {
  const it = data.items.find((i) => i.id === id);
  if (!it) return;
  Object.assign(it, patch);
  touch();
}

export function deleteCostItem(id: string) {
  data.items = data.items.filter((i) => i.id !== id);
  for (const [k, a] of Object.entries(data.assignments)) {
    if (a.costItemId === id) data.assignments[k].costItemId = null;
  }
  touch();
}

// ── Assignments ──
export function getAssignment(rowKey: string): CostAssignment {
  return data.assignments[rowKey] ?? { rowKey, costItemId: null, qtyOverride: null };
}
export function setAssignment(rowKey: string, costItemId: string | null) {
  const a = getAssignment(rowKey);
  a.costItemId = costItemId;
  data.assignments[rowKey] = a;
  touch();
}
export function setQtyOverride(rowKey: string, qty: number | null) {
  const a = getAssignment(rowKey);
  a.qtyOverride = qty;
  data.assignments[rowKey] = a;
  touch();
}

// ── Computation ──
export function qtyForUnit(row: TakeoffRow, unit: CostUnit): number {
  switch (unit) {
    case "pcs": return row.count;
    case "m": return row.length;
    case "m2": return row.area;
    case "m3": return row.volume;
  }
  return 0;
}

export function computeLine(row: TakeoffRow): { qty: number; rate: number; lineCost: number; item: CostItem | null } {
  const a = getAssignment(row.key);
  const item = a.costItemId ? data.items.find((i) => i.id === a.costItemId) ?? null : null;
  if (!item) return { qty: 0, rate: 0, lineCost: 0, item: null };
  const qty = a.qtyOverride != null && Number.isFinite(a.qtyOverride) ? a.qtyOverride : qtyForUnit(row, item.unit);
  const lineCost = qty * (item.rate || 0);
  return { qty, rate: item.rate || 0, lineCost, item };
}

export interface Totals {
  grand: number;
  byCategory: { name: string; total: number }[];
  byItem: { item: CostItem; total: number }[];
  assignedRows: number;
  totalRows: number;
}

export function computeTotals(rows: TakeoffRow[]): Totals {
  const grand = { v: 0 };
  const byCat = new Map<string, number>();
  const byItem = new Map<string, number>();
  let assignedRows = 0;
  for (const row of rows) {
    const { lineCost, item } = computeLine(row);
    if (!item) continue;
    assignedRows++;
    grand.v += lineCost;
    byCat.set(item.category || "General", (byCat.get(item.category || "General") ?? 0) + lineCost);
    byItem.set(item.id, (byItem.get(item.id) ?? 0) + lineCost);
  }
  return {
    grand: grand.v,
    byCategory: [...byCat.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total),
    byItem: [...byItem.entries()].map(([id, total]) => ({ item: data.items.find((i) => i.id === id)!, total })).filter((x) => x.item).sort((a, b) => b.total - a.total),
    assignedRows,
    totalRows: rows.length,
  };
}

// ── Setup ──
export function setupCost() {
  ctx.features.cost = {
    getCostData, setCostData, getItems, addCostItem, updateCostItem, deleteCostItem,
    getAssignment, setAssignment, setQtyOverride, computeLine, computeTotals, onCostChanged,
  };
}