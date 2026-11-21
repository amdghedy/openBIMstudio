/**
 * Local-first registry of reusable family parameters.
 *
 * Two serialisations are supported:
 * - JSON (`export` / `import`): the manager's native snapshot.
 * - Revit shared-parameter text (`.txt`, `exportText` / `importText`):
 *   the tab-separated format Revit reads and writes —
 *   `#` comment, `*META`, `*GROUP`, `*PARAM` sections, `PARAM` rows
 *   of GUID, NAME, DATACATEGORY, DATATYPE, GROUP, VISIBLE,
 *   DESCRIPTION, USERMODIFIABLE, HIDEWHENNOVALUE. The `.txt` format
 *   does not record instance/type binding, so imported parameters
 *   default to instance (`isInstance: true`); it also has no default
 *   value column. DATACATEGORY is authoritative for the type;
 *   DATATYPE must be a known token and is written out identical.
 */
export type SharedParameterType =
  | "number" | "string" | "boolean" | "length" | "area"
  | "integer" | "volume" | "angle" | "material";

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
  /** Revit `.txt` VISIBLE flag (default true when absent). */
  visible?: boolean;
  /** Revit `.txt` USERMODIFIABLE flag (default true when absent). */
  userModifiable?: boolean;
  /** Revit `.txt` HIDEWHENNOVALUE flag (default false when absent). */
  hideWhenNoValue?: boolean;
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
  /** Serialise all definitions as a Revit shared-parameter `.txt` file. */
  exportText(): string;
  /** Import definitions from a Revit shared-parameter `.txt` file. */
  importText(source: string): SharedParameter[];
}

const STORAGE_KEY = "openbimstudio.shared-parameters";

/**
 * Bounds for a shared-parameter import (issue #90). The import() entry point
 * currently has no file-input caller in src/ (definitions are created and
 * edited through the families panel); the caps apply if one is ever wired
 * up, so an imported file cannot grow the parameter registry without bound.
 */
export const SHARED_PARAMETERS_MAX_BYTES = 1 * 1024 * 1024;
export const SHARED_PARAMETERS_MAX_COUNT = 10_000;
const PARAMETER_TYPES = new Set<SharedParameterType>([
  "number", "string", "boolean", "length", "area",
  "integer", "volume", "angle", "material",
]);

/** Revit `.txt` DATACATEGORY / DATATYPE token -> manager type. */
const REVIT_TYPE_MAP: Record<string, SharedParameterType> = {
  TEXT: "string",
  INTEGER: "integer",
  NUMBER: "number",
  LENGTH: "length",
  AREA: "area",
  VOLUME: "volume",
  ANGLE: "angle",
  YESNO: "boolean",
  MATERIAL: "material",
};

/** Manager type -> Revit `.txt` DATACATEGORY / DATATYPE token. */
const REVIT_TYPE_REVERSE: Record<SharedParameterType, string> = {
  string: "TEXT",
  integer: "INTEGER",
  number: "NUMBER",
  length: "LENGTH",
  area: "AREA",
  volume: "VOLUME",
  angle: "ANGLE",
  boolean: "YESNO",
  material: "MATERIAL",
};

const GUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

/**
 * Parse a Revit shared-parameter `.txt` file into definitions.
 * Throws with a line number on malformed input; duplicate GUIDs or
 * names inside one file are malformed (merging against EXISTING
 * definitions is the manager's `importText`, which follows the same
 * rules as `import`: existing GUIDs are updated, duplicate names with
 * different GUIDs are skipped).
 */
export function parseSharedParameterText(source: string): SharedParameter[] {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("Shared parameter text is empty or not a string.");
  }
  const groups = new Map<number, string>();
  const parameters: SharedParameter[] = [];
  const seenGuids = new Set<string>();
  const seenNames = new Set<string>();
  let section: "meta" | "group" | "param" | null = null;
  const lines = source.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const cells = raw.split("\t");
    const head = cells[0]?.trim();
    if (head === "*META") { section = "meta"; continue; }
    if (head === "*GROUP") { section = "group"; continue; }
    if (head === "*PARAM") { section = "param"; continue; }
    if (head === "META") {
      if (section !== "meta") throw new Error(`Line ${lineNo}: META row outside the *META section.`);
      continue;
    }
    if (head === "GROUP") {
      if (section !== "group") throw new Error(`Line ${lineNo}: GROUP row outside the *GROUP section.`);
      const id = Number(cells[1]);
      const name = cells[2]?.trim();
      if (!Number.isInteger(id) || id <= 0) throw new Error(`Line ${lineNo}: GROUP id must be a positive integer, got "${cells[1] ?? ""}".`);
      if (!name) throw new Error(`Line ${lineNo}: GROUP row is missing a name.`);
      if (groups.has(id)) throw new Error(`Line ${lineNo}: duplicate GROUP id ${id}.`);
      groups.set(id, name);
      continue;
    }
    if (head === "PARAM") {
      if (section !== "param") throw new Error(`Line ${lineNo}: PARAM row outside the *PARAM section.`);
      if (cells.length < 6) {
        throw new Error(`Line ${lineNo}: PARAM row has ${cells.length - 1} field(s); expected at least GUID, NAME, DATACATEGORY, DATATYPE and GROUP.`);
      }
      const [, guidRaw, nameRaw, categoryRaw, datatypeRaw, groupRaw, visibleRaw, descriptionRaw, modifiableRaw, hideRaw] = cells;
      const guid = guidRaw?.trim().replace(/^\{|\}$/g, "").toLowerCase();
      if (!guid || !GUID_RE.test(guidRaw?.trim() ?? "")) {
        throw new Error(`Line ${lineNo}: PARAM GUID "${guidRaw ?? ""}" is not a valid GUID.`);
      }
      const name = nameRaw?.trim();
      if (!name) throw new Error(`Line ${lineNo}: PARAM row is missing a name.`);
      const category = categoryRaw?.trim().toUpperCase();
      const type = category ? REVIT_TYPE_MAP[category] : undefined;
      if (!type) throw new Error(`Line ${lineNo}: unknown DATACATEGORY "${categoryRaw ?? ""}".`);
      const datatype = datatypeRaw?.trim().toUpperCase();
      if (!datatype || !(datatype in REVIT_TYPE_MAP)) {
        throw new Error(`Line ${lineNo}: unknown DATATYPE "${datatypeRaw ?? ""}".`);
      }
      const groupId = Number(groupRaw);
      const group = groups.get(groupId);
      if (!group) throw new Error(`Line ${lineNo}: PARAM references unknown GROUP id "${groupRaw ?? ""}".`);
      const flag = (rawFlag: string | undefined, field: string, fallback: boolean): boolean => {
        if (rawFlag === undefined || rawFlag.trim() === "") return fallback;
        if (rawFlag.trim() === "1") return true;
        if (rawFlag.trim() === "0") return false;
        throw new Error(`Line ${lineNo}: ${field} must be 0 or 1, got "${rawFlag}".`);
      };
      if (seenGuids.has(guid)) throw new Error(`Line ${lineNo}: duplicate GUID ${guid}.`);
      if (seenNames.has(name.toLowerCase())) throw new Error(`Line ${lineNo}: duplicate parameter name "${name}".`);
      seenGuids.add(guid);
      seenNames.add(name.toLowerCase());
      parameters.push({
        guid,
        name,
        group,
        type,
        ...(descriptionRaw?.trim() ? { description: descriptionRaw.trim() } : {}),
        defaultValue: undefined,
        isInstance: true,
        visible: flag(visibleRaw, "VISIBLE", true),
        userModifiable: flag(modifiableRaw, "USERMODIFIABLE", true),
        hideWhenNoValue: flag(hideRaw, "HIDEWHENNOVALUE", false),
      });
      continue;
    }
    throw new Error(`Line ${lineNo}: unexpected content "${raw.trim().slice(0, 40)}".`);
  }
  if (!groups.size && !parameters.length) {
    throw new Error("Shared parameter text contains no GROUP or PARAM rows.");
  }
  return parameters;
}

/** Serialise definitions as a Revit shared-parameter `.txt` file. */
export function serializeSharedParameterText(parameters: SharedParameter[]): string {
  const groupIds = new Map<string, number>();
  for (const p of parameters) {
    if (!groupIds.has(p.group)) groupIds.set(p.group, groupIds.size + 1);
  }
  const lines: string[] = [
    "# This is a Revit shared parameter file. Do not edit manually.",
    "*META\tVERSION\tMINVERSION",
    "META\t2\t1",
    "*GROUP\tID\tNAME",
    ...[...groupIds.entries()].map(([name, id]) => `GROUP\t${id}\t${name}`),
    "*PARAM\tGUID\tNAME\tDATACATEGORY\tDATATYPE\tGROUP\tVISIBLE\tDESCRIPTION\tUSERMODIFIABLE\tHIDEWHENNOVALUE",
    ...parameters.map((p) => [
      "PARAM",
      p.guid,
      p.name,
      REVIT_TYPE_REVERSE[p.type],
      REVIT_TYPE_REVERSE[p.type],
      String(groupIds.get(p.group) ?? 1),
      p.visible === false ? "0" : "1",
      p.description ?? "",
      p.userModifiable === false ? "0" : "1",
      p.hideWhenNoValue ? "1" : "0",
    ].join("\t")),
  ];
  return lines.join("\r\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isParameterType(value: unknown): value is SharedParameterType {
  return typeof value === "string" && PARAMETER_TYPES.has(value as SharedParameterType);
}

/**
 * Manages shared parameter definitions, persisting changes in localStorage.
 * An in-memory cache is the authoritative working set: writes update the
 * cache first (and persist to storage when available), so the manager keeps
 * working when storage is absent or a persist fails. With a working storage
 * handle, reads re-check storage first, so a fresh manager still reloads
 * previously persisted definitions and live managers sharing one handle
 * keep seeing each other's writes; only a corrupt or unreadable store falls
 * back to the cache. Storage failures are logged and handled gracefully so
 * callers can still use the manager in memory-restricted or non-browser
 * environments.
 */
export class SharedParameterManager implements SharedParameterManagerService {
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  /**
   * In-memory copy of the definitions. The manager used to be
   * storage-only: with a null storage handle every write was silently
   * dropped and every read returned empty, so `create` followed by
   * `findByName` failed. The cache is now the source of truth once
   * loaded; storage is write-through persistence plus the initial
   * load (a fresh manager instance still reloads from shared storage).
   */
  private cache: SharedParameter[] | null = null;
  /** True when the last persist failed, so stale storage cannot clobber cached writes. */
  private persistFailed = false;

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

  /** Shallow-copies definitions so callers cannot mutate the cached working set. */
  private snapshot(parameters: SharedParameter[]): SharedParameter[] {
    return parameters.map((parameter) => ({ ...parameter }));
  }

  /**
   * Reads and validates the stored definitions. A missing key is a valid
   * empty store; corrupt or unreadable data reports failure instead so the
   * caller can fall back to the cache rather than silently discarding it.
   */
  private readFromStorage(): { ok: true; parameters: SharedParameter[] } | { ok: false } {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return { ok: true, parameters: [] };
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { ok: false };
      return {
        ok: true,
        parameters: parsed
          .map((item: unknown) => this.normalize(item))
          .filter((item): item is SharedParameter => item !== null),
      };
    } catch (error) {
      console.warn("[shared-parameters] unable to read stored parameters:", error);
      return { ok: false };
    }
  }

  /**
   * Returns the working set. Without storage the cache is authoritative;
   * with storage the store is re-checked on every read (so a new manager
   * reloads persisted definitions) and the cache is only a fallback for a
   * corrupt or unreadable store, or while a failed persist is outstanding.
   */
  private readAll(): SharedParameter[] {
    if (this.storage === null || this.persistFailed) {
      if (this.cache === null) this.cache = [];
      return this.snapshot(this.cache);
    }
    const stored = this.readFromStorage();
    if (stored.ok) {
      this.cache = stored.parameters;
      return this.snapshot(this.cache);
    }
    if (this.cache === null) this.cache = [];
    return this.snapshot(this.cache);
  }

  /** Updates the cache, then writes definitions, logging quota/security failures instead of crashing. */
  private writeAll(parameters: SharedParameter[]): void {
    this.cache = this.snapshot(parameters);
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(parameters));
      this.persistFailed = false;
    } catch (error) {
      console.warn("[shared-parameters] unable to persist parameters:", error);
      this.persistFailed = true;
    }
  }

  private normalize(value: unknown): SharedParameter | null {
    if (!isRecord(value)) return null;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!name) return null;
    const flag = (key: string): boolean | undefined =>
      typeof value[key] === "boolean" ? (value[key] as boolean) : undefined;
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
      ...(flag("visible") !== undefined ? { visible: flag("visible") as boolean } : {}),
      ...(flag("userModifiable") !== undefined ? { userModifiable: flag("userModifiable") as boolean } : {}),
      ...(flag("hideWhenNoValue") !== undefined ? { hideWhenNoValue: flag("hideWhenNoValue") as boolean } : {}),
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
      ...(typeof input.visible === "boolean" ? { visible: input.visible } : {}),
      ...(typeof input.userModifiable === "boolean" ? { userModifiable: input.userModifiable } : {}),
      ...(typeof input.hideWhenNoValue === "boolean" ? { hideWhenNoValue: input.hideWhenNoValue } : {}),
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
      if (new TextEncoder().encode(source).byteLength > SHARED_PARAMETERS_MAX_BYTES) {
        throw new Error(`Shared parameter import exceeds the ${SHARED_PARAMETERS_MAX_BYTES / 1024 / 1024} MB limit.`);
      }
      try {
        decoded = JSON.parse(source) as unknown;
      } catch (error) {
        throw new Error(`Shared parameter import is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!Array.isArray(decoded)) throw new Error("Shared parameter import must be a JSON array.");
    if (decoded.length > SHARED_PARAMETERS_MAX_COUNT) {
      throw new Error(`Shared parameter import has more than ${SHARED_PARAMETERS_MAX_COUNT.toLocaleString()} parameters.`);
    }
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

  /** Returns a Revit shared-parameter `.txt` snapshot suitable for download. */
  exportText(): string {
    return serializeSharedParameterText(this.list());
  }

  /**
   * Imports parameter definitions from a Revit shared-parameter `.txt`
   * file. Same merge rules as `import`: existing GUIDs are updated;
   * duplicate names with different GUIDs are skipped.
   */
  importText(source: string): SharedParameter[] {
    const decoded = parseSharedParameterText(source);
    const current = this.readAll();
    const byGuid = new Map(current.map((parameter) => [parameter.guid, parameter]));
    for (const parameter of decoded) {
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
