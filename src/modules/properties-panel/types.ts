/** Properties panel — multi-select, *VARIES*, type/instance */

export type PropertyKind = "instance" | "type" | "calculated" | "readonly" | "formula";

export interface PropertyDescriptor {
  key: string;
  label: string;
  kind: PropertyKind;
  valueType: "number" | "string" | "boolean" | "enum" | "length" | "area" | "volume" | "angle";
  unit?: string;
  enumValues?: string[];
  formula?: string;
  group: string;
  order: number;
  visible: boolean;
  editable: boolean;
}

export interface PropertyValue {
  key: string;
  value: unknown;
  displayValue: string;
  isMixed: boolean;
  isCalculated: boolean;
  sourceElementIds: string[];
}

export interface PropertiesSnapshot {
  elementIds: string[];
  categories: string[];
  typeName: string | null;
  isMulti: boolean;
  groups: Array<{ name: string; properties: PropertyValue[] }>;
  timestamp: number;
}

export interface IPropertiesPanelService {
  getSnapshot(elementIds: string[]): PropertiesSnapshot;
  setValue(elementIds: string[], key: string, value: unknown): boolean;
  getDescriptors(category: string): PropertyDescriptor[];
  registerDescriptor(desc: PropertyDescriptor): void;
  refresh(): void;
  setElementAccessors(
    getElement: (id: string) => Record<string, unknown> | null | undefined,
    getCategory: (id: string) => string
  ): void;
}
