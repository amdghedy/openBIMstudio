/**
 * Properties panel service — multi-select, *VARIES*, type/instance
 */
import type {
  IPropertiesPanelService,
  PropertiesSnapshot,
  PropertyDescriptor,
  PropertyValue,
} from "./types";

let _instance: PropertiesPanelService | null = null;

const DEFAULT_GROUPS = ["Identity", "Dimensions", "Constraints", "Materials", "Phasing", "Other"];

export class PropertiesPanelService implements IPropertiesPanelService {
  private descriptors = new Map<string, PropertyDescriptor[]>();
  private getElement: ((id: string) => Record<string, unknown> | null | undefined) | null = null;
  private getCategory: ((id: string) => string) | null = null;

  setElementAccessors(
    getElement: (id: string) => Record<string, unknown> | null | undefined,
    getCategory: (id: string) => string
  ): void {
    this.getElement = getElement;
    this.getCategory = getCategory;
  }

  registerDescriptor(desc: PropertyDescriptor): void {
    const list = this.descriptors.get("*") ?? [];
    list.push(desc);
    list.sort((a, b) => a.order - b.order);
    this.descriptors.set("*", list);
  }

  getDescriptors(category: string): PropertyDescriptor[] {
    return this.descriptors.get(category) ?? this.descriptors.get("*") ?? [];
  }

  getSnapshot(elementIds: string[]): PropertiesSnapshot {
    const ids = elementIds.filter(Boolean);
    const categories = new Set<string>();
    const typeNames = new Set<string>();
    const valuesByKey = new Map<string, { values: unknown[]; ids: string[] }>();

    for (const id of ids) {
      const cat = this.getCategory?.(id) ?? "Unknown";
      categories.add(cat);
      const el = this.getElement?.(id);
      if (!el) continue;
      if (typeof el["typeName"] === "string") typeNames.add(el["typeName"] as string);
      for (const [k, v] of Object.entries(el)) {
        if (k.startsWith("_")) continue;
        const bucket = valuesByKey.get(k) ?? { values: [], ids: [] };
        bucket.values.push(v);
        bucket.ids.push(id);
        valuesByKey.set(k, bucket);
      }
    }

    const props: PropertyValue[] = [];
    for (const [key, bucket] of valuesByKey) {
      const first = bucket.values[0];
      const isMixed = bucket.values.some((v) => !Object.is(v, first));
      props.push({
        key,
        value: isMixed ? undefined : first,
        displayValue: isMixed ? "*VARIES*" : formatValue(first),
        isMixed,
        isCalculated: false,
        sourceElementIds: bucket.ids,
      });
    }

    const groups = DEFAULT_GROUPS.map((name) => ({
      name,
      properties: props.filter((p) => guessGroup(p.key) === name),
    })).filter((g) => g.properties.length > 0);

    const assigned = new Set(groups.flatMap((g) => g.properties.map((p) => p.key)));
    const other = props.filter((p) => !assigned.has(p.key));
    if (other.length) groups.push({ name: "Other", properties: other });

    return {
      elementIds: ids,
      categories: [...categories],
      typeName: typeNames.size === 1 ? [...typeNames][0] : null,
      isMulti: ids.length > 1,
      groups,
      timestamp: Date.now(),
    };
  }

  setValue(elementIds: string[], key: string, value: unknown): boolean {
    if (!this.getElement) return false;
    let ok = false;
    for (const id of elementIds) {
      const el = this.getElement(id);
      if (!el) continue;
      el[key] = value;
      ok = true;
    }
    return ok;
  }

  refresh(): void {
    /* consumers re-call getSnapshot */
  }
}

function formatValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

function guessGroup(key: string): string {
  const k = key.toLowerCase();
  if (/name|id|mark|comment|type/.test(k)) return "Identity";
  if (/width|height|length|thickness|area|volume|radius|offset|depth/.test(k)) return "Dimensions";
  if (/level|host|constraint|base|top/.test(k)) return "Constraints";
  if (/material|finish|paint/.test(k)) return "Materials";
  if (/phase|created|demolish/.test(k)) return "Phasing";
  return "Other";
}

export function getPropertiesPanelService(): PropertiesPanelService {
  if (!_instance) _instance = new PropertiesPanelService();
  return _instance;
}

export type { IPropertiesPanelService, PropertiesSnapshot, PropertyValue };
