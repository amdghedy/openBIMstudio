/**
 * Local-first registry of reusable family parameters.
 */
export type SharedParameterType = "number" | "string" | "boolean" | "length" | "area";

export interface SharedParameter {
  /** Stable RFC4122 version 4 identifier. */
  guid: string;
  /** Parameter name, unique without regard to case. */
  name: string;
  /** UI grouping for this parameter. */
  group: string;
  /** Value interpretation used by family editors. */
  type: SharedParameterType;
  /** Optional explanatory text. */
  description?: string;
  /** Initial value; JSON-compatible values are recommended for persistence. */
  defaultValue: unknown;
  /** True for per-instance values, false for type-level values. */
  isInstance: boolean;
}

export interface SharedParameterManagerService {
  create(input: Omit<SharedParameter, "guid"> & { guid?: string }): SharedParameter;
  get(guid: string): SharedParameter | null;
  findByName(name: string): SharedParameter | null;
  list(): SharedParameter[];
  listByGroup(group: string): SharedParameter[];
  delete(guid: string): boolean;
  export(): string;
  import(source: string | unknown): SharedParameter[];
}

const STORAGE_KEY = "openbimstudio.shared-parameters";
const PARAMETER_TYPES = new Set<SharedParameterType>([
  "number", "string", "boolean", "length", "area",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isParameterType(value: unknown): value is SharedParameterType {
  return typeof value === "string" && PARAMETER_TYPES.has(value as SharedParameterType);
}

/**
 * Manages shared parameter definitions, persisting changes in localStorage.
 * Storage failures are logged and handled gracefully so callers can still use
 * the manager in memory-restricted or non-browser environments.
 */
export class SharedParameterManager implements SharedParameterManagerService {
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;

  /**
   * Construct the manager. Supplying storage is useful for tests and embedding;
   * omitted storage uses `window.localStorage` when it is available.
   */
  constructor(storage?: Pick<Storage, "getItem" | "setItem"> | null) {
    if (storage !== undefined) {
      this.storage = storage;
      return;
    }
    try {
      this.storage = typeof window !== "undefined" ? window.localStorage : null;
    } catch (error) {
      console.warn("[shared-parameters] localStorage is unavailable:", error);
      this.storage = null;
    }
  }

  /** Generates a random UUID using the standard RFC4122 v4 bit layout. */
  private generateGuid(): string {
    const bytes = new Uint8Array(16);
    try {
      globalThis.crypto?.getRandomValues(bytes);
    } catch (error) {
      console.warn("[shared-parameters] secure random source unavailable:", error);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** Reads and validates the stored definitions; corrupt data is ignored safely. */
  private readAll(): SharedParameter[] {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item: unknown) => this.normalize(item)).filter(
        (item): item is SharedParameter => item !== null,
      );
    } catch (error) {
      console.warn("[shared-parameters] unable to read stored parameters:", error);
      return [];
    }
  }

  /** Writes definitions, logging quota/security failures instead of crashing. */
  private writeAll(parameters: SharedParameter[]): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(parameters));
    } catch (error) {
      console.warn("[shared-parameters] unable to persist parameters:", error);
    }
  }

  private normalize(value: unknown): SharedParameter | null {
    if (!isRecord(value)) return null;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!name) return null;
    return {
      guid: typeof value.guid === "string" && value.guid.trim() ? value.guid : this.generateGuid(),
      name,
      group: typeof value.group === "string" && value.group.trim() ? value.group.trim() : "General",
      type: isParameterType(value.type) ? value.type : "string",
      ...(typeof value.description === "string" && value.description.trim()
        ? { description: value.description.trim() }
        : {}),
      defaultValue: value.defaultValue,
      isInstance: typeof value.isInstance === "boolean" ? value.isInstance : true,
    };
  }

  /** Creates and persists a definition, rejecting duplicate names and GUIDs. */
  create(input: Omit<SharedParameter, "guid"> & { guid?: string }): SharedParameter {
    const name = input.name.trim();
    if (!name) throw new Error("Shared parameter name is required.");
    if (!isParameterType(input.type)) throw new Error(`Unsupported parameter type: ${String(input.type)}.`);
    const parameters = this.readAll();
    if (parameters.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A shared parameter named "${name}" already exists.`);
    }
    const guid = input.guid?.trim() || this.generateGuid();
    if (parameters.some((item) => item.guid === guid)) {
      throw new Error(`A shared parameter with GUID "${guid}" already exists.`);
    }
    const parameter: SharedParameter = {
      guid,
      name,
      group: input.group.trim() || "General",
      type: input.type,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      defaultValue: input.defaultValue,
      isInstance: input.isInstance,
    };
    parameters.push(parameter);
    this.writeAll(parameters);
    return parameter;
  }

  /** Returns a parameter by exact GUID, or null when it is not found. */
  get(guid: string): SharedParameter | null {
    return this.readAll().find((parameter) => parameter.guid === guid) ?? null;
  }

  /** Finds a parameter by name, ignoring letter case. */
  findByName(name: string): SharedParameter | null {
    const normalized = name.trim().toLocaleLowerCase();
    return normalized
      ? this.readAll().find((parameter) => parameter.name.toLocaleLowerCase() === normalized) ?? null
      : null;
  }

  /** Returns a snapshot of every stored parameter. */
  list(): SharedParameter[] {
    return this.readAll();
  }

  /** Returns a snapshot of parameters in the named group, case-insensitively. */
  listByGroup(group: string): SharedParameter[] {
    const normalized = group.trim().toLocaleLowerCase();
    return normalized
      ? this.readAll().filter((parameter) => parameter.group.toLocaleLowerCase() === normalized)
      : [];
  }

  /** Removes a parameter by GUID; returns false when no such definition exists. */
  delete(guid: string): boolean {
    const parameters = this.readAll();
    const remaining = parameters.filter((parameter) => parameter.guid !== guid);
    if (remaining.length === parameters.length) return false;
    this.writeAll(remaining);
    return true;
  }

  /** Returns a portable JSON snapshot suitable for download or transfer. */
  export(): string {
    return JSON.stringify(this.list(), null, 2);
  }

  /**
   * Imports parameter definitions from JSON text or an array of objects.
   * Existing GUIDs are updated; duplicate names with different GUIDs are skipped.
   */
  import(source: string | unknown): SharedParameter[] {
    let decoded: unknown = source;
    if (typeof source === "string") {
      try {
        decoded = JSON.parse(source) as unknown;
      } catch (error) {
        throw new Error(`Shared parameter import is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!Array.isArray(decoded)) throw new Error("Shared parameter import must be a JSON array.");
    const current = this.readAll();
    const byGuid = new Map(current.map((parameter) => [parameter.guid, parameter]));
    for (const raw of decoded as unknown[]) {
      const parameter = this.normalize(raw);
      if (!parameter) continue;
      const duplicateName = [...byGuid.values()].some(
        (existing) => existing.guid !== parameter.guid && existing.name.toLowerCase() === parameter.name.toLowerCase(),
      );
      if (!duplicateName) byGuid.set(parameter.guid, parameter);
    }
    const result = [...byGuid.values()];
    this.writeAll(result);
    return result;
  }
}

export const sharedParameterManager = new SharedParameterManager();

// Augment the registry contract while keeping the core registry implementation unchanged.
import type { ServiceMap } from "../../core/services";
declare module "../../core/services" {
  interface ServiceMap {
    sharedParameters: SharedParameterManagerService;
  }
}
void ({} as ServiceMap);
