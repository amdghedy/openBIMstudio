/**
 * CAD layer manager — AutoCAD parity gap A16.
 *
 * AutoCAD behaviour: the Layer Properties Manager renames and deletes
 * layers, toggles plotting, edits transparency, makes a layer current by
 * clicking it, and saves named layer states with the FULL property set
 * (on/off, frozen, locked, colour, linetype, lineweight, transparency,
 * plot, current layer) — persisted with the drawing.
 *
 * This module is the pure, DOM-free core of that behaviour, in the same
 * shape as the A15 snap-override module: the live wiring lives in
 * `src/features/cad-viewer.ts` (manager overlay, sidebar, Properties
 * palette, LAYREN / LAYERSTATE commands, session persistence), while
 * every rule that can be decided without the app lives here and is
 * unit-testable without booting it.
 *
 * Honest scope:
 * - Rename refuses layer "0" (AutoCAD forbids renaming it) and refuses
 *   names with DXF-forbidden characters (`<> / \ " : ; ? * | = ,`), empty
 *   names, and names that already exist (case-insensitive — DXF layer
 *   names are case-insensitive, and the existing LAYDEL / LAYMRG paths
 *   already compare that way).
 * - Delete refuses layer "0" and the current layer (AutoCAD refuses
 *   both), and deletes the layer AND every entity on it — the LAYDEL
 *   semantics the app already has. The manager UI confirms first when
 *   entities exist; this module does not prompt.
 * - Layer states capture the full property set per layer plus the
 *   current layer. States are persisted with the drawing through the
 *   app's per-drawing session store (DrawingSession.layerStates);
 *   writing them into the DXF file itself would need real
 *   AcDbLayerStateManager objects in the OBJECTS section — a writer
 *   feature, not smuggled in here.
 * - Per-viewport freeze is OUT of scope (needs the A8 viewport model).
 */
import type { DxfDocument, DxfEntity, DxfLayer } from "../drawings/dxf-types";

/** The full per-layer property set a layer state captures. */
export interface LayerStateProps {
  off: boolean;
  frozen: boolean;
  locked: boolean;
  color: number;
  rgb?: number;
  lineType?: string;
  lineweight?: number;
  transparency?: number;
  /** false = does not plot; true/undefined = plots. */
  plot?: boolean;
}

/** One named layer state: the full property set per layer, plus the current layer. */
export interface LayerStateSnapshot {
  name: string;
  current: string;
  layers: Record<string, LayerStateProps>;
}

export type RenameResult = { ok: true; current: string } | { ok: false; reason: string };
export type DeleteResult = { ok: true; deleted: DxfEntity[] } | { ok: false; reason: string };
export type ApplyResult = {
  applied: string[];
  missing: string[];
  current: string;
  off: string[];
  frozen: string[];
};

/** Characters AutoCAD forbids in a layer name (DXF layer-name rules). */
export const LAYER_NAME_FORBIDDEN = /[<>/"\\:;?*|=,]/;
const MAX_LAYER_NAME = 255;

const eq = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

function layerNames(doc: DxfDocument): string[] {
  return doc.layers.map((l) => l.name);
}

function allEntityLists(doc: DxfDocument): DxfEntity[][] {
  const lists: DxfEntity[][] = [doc.entities];
  for (const layout of doc.layouts ?? []) lists.push(layout.entities);
  return lists;
}

/**
 * Validate a candidate layer name against the layers already in the
 * drawing. Returns an error message, or null when the name is usable.
 * `ignore` is a name that may stay (the layer being renamed itself).
 */
export function validateLayerName(
  rawName: string,
  existing: readonly string[],
  ignore?: string,
): string | null {
  const name = rawName.trim();
  if (!name) return "Layer name cannot be empty.";
  if (name.length > MAX_LAYER_NAME) return `Layer name cannot exceed ${MAX_LAYER_NAME} characters.`;
  if (LAYER_NAME_FORBIDDEN.test(name))
    return "Layer name cannot contain <> / \\ \" : ; ? * | = or ,";
  if (ignore !== undefined && eq(name, ignore)) return null;
  if (existing.some((n) => eq(n, name))) return `Layer "${name}" already exists.`;
  return null;
}

/** Does this layer plot? Undefined means "plots" (the DXF default). */
export function layerPlots(layer: DxfLayer | undefined): boolean {
  return layer?.plot !== false;
}

/**
 * Rename a layer everywhere it is referenced: the layer table, every
 * entity in model space and in every layout, the hidden (off) set, and
 * the current layer when it was the renamed one. Refuses layer "0"
 * and invalid / duplicate names — see validateLayerName.
 */
export function renameLayer(
  doc: DxfDocument,
  oldName: string,
  rawNewName: string,
  current: string,
  hidden: Set<string>,
): RenameResult {
  const layer = doc.layers.find((l) => eq(l.name, oldName));
  if (!layer) return { ok: false, reason: `Layer "${oldName}" not found.` };
  if (eq(oldName, "0")) return { ok: false, reason: "Layer \"0\" cannot be renamed." };
  const newName = rawNewName.trim();
  const bad = validateLayerName(newName, layerNames(doc), oldName);
  if (bad) return { ok: false, reason: bad };
  for (const list of allEntityLists(doc)) {
    for (const e of list) if (eq(e.layer, oldName)) e.layer = newName;
  }
  layer.name = newName;
  if (hidden.delete(oldName)) hidden.add(newName);
  return { ok: true, current: eq(current, oldName) ? newName : current };
}

/** Refusal reason when a layer cannot be deleted, or null when it can.
 * The manager UI checks this BEFORE asking for confirmation, so refusing
 * layer "0" or the current layer never prompts first. */
export function deleteGuard(doc: DxfDocument, name: string, current: string): string | null {
  const layer = doc.layers.find((l) => eq(l.name, name));
  if (!layer) return `Layer "${name}" not found.`;
  if (eq(name, "0")) return `Layer "0" cannot be deleted.`;
  if (eq(name, current)) return `Layer "${name}" is current — make another layer current first.`;
  return null;
}

/**
 * Delete a layer and every entity on it (LAYDEL semantics). Refuses
 * layer "0", the current layer, and unknown layers. The caller owns
 * the confirmation prompt and the undo action — `deleted` carries the
 * removed entities for it.
 */
export function deleteLayer(
  doc: DxfDocument,
  name: string,
  current: string,
): DeleteResult {
  const guard = deleteGuard(doc, name, current);
  if (guard) return { ok: false, reason: guard };
  const deleted: DxfEntity[] = [];
  for (const list of allEntityLists(doc)) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (eq(list[i].layer, name)) deleted.push(list.splice(i, 1)[0]);
    }
  }
  doc.layers = doc.layers.filter((l) => !eq(l.name, name));
  return { ok: true, deleted };
}

/** Set a layer's plot flag. Returns false when the layer does not exist. */
export function setLayerPlot(doc: DxfDocument, name: string, plot: boolean): boolean {
  const layer = doc.layers.find((l) => eq(l.name, name));
  if (!layer) return false;
  layer.plot = plot;
  return true;
}

/**
 * Set a layer's transparency in percent (0 = opaque, 90 = most
 * transparent — the DXF group 440 range). Returns false when the layer
 * does not exist or the value is out of range / not an integer.
 */
export function setLayerTransparency(doc: DxfDocument, name: string, pct: number): boolean {
  const layer = doc.layers.find((l) => eq(l.name, name));
  if (!layer) return false;
  if (!Number.isInteger(pct) || pct < 0 || pct > 90) return false;
  if (pct === 0) delete layer.transparency;
  else layer.transparency = pct;
  return true;
}

function propsOf(layer: DxfLayer): LayerStateProps {
  const p: LayerStateProps = {
    off: layer.off ?? false,
    frozen: layer.frozen ?? false,
    locked: layer.locked ?? false,
    color: layer.color ?? 7,
  };
  if (layer.rgb != null) p.rgb = layer.rgb;
  if (layer.lineType != null) p.lineType = layer.lineType;
  if (layer.lineweight != null) p.lineweight = layer.lineweight;
  if (layer.transparency != null) p.transparency = layer.transparency;
  if (layer.plot != null) p.plot = layer.plot;
  return p;
}

/** Capture the full property set of every layer, plus the current layer. */
export function captureLayerState(doc: DxfDocument, current: string): LayerStateSnapshot {
  const layers: Record<string, LayerStateProps> = {};
  for (const l of doc.layers) layers[l.name] = propsOf(l);
  return { name: "", current, layers };
}

/**
 * Restore a captured state onto the layers that still exist. Layers
 * recorded in the state but missing from the drawing are reported, not
 * recreated — a state saved from another drawing must not invent
 * layers. Returns the off / frozen sets so the caller can sync its
 * visibility bookkeeping the same way the live restore does.
 */
export function applyLayerState(doc: DxfDocument, snap: LayerStateSnapshot): ApplyResult {
  const applied: string[] = [];
  const missing: string[] = [];
  const off: string[] = [];
  const frozen: string[] = [];
  for (const [name, p] of Object.entries(snap.layers)) {
    const layer = doc.layers.find((l) => eq(l.name, name));
    if (!layer) {
      missing.push(name);
      continue;
    }
    layer.off = p.off;
    layer.frozen = p.frozen;
    layer.locked = p.locked;
    layer.color = p.color;
    if (p.rgb != null) layer.rgb = p.rgb;
    else delete layer.rgb;
    if (p.lineType != null) layer.lineType = p.lineType;
    else delete layer.lineType;
    if (p.lineweight != null) layer.lineweight = p.lineweight;
    else delete layer.lineweight;
    if (p.transparency != null) layer.transparency = p.transparency;
    else delete layer.transparency;
    if (p.plot != null) layer.plot = p.plot;
    else delete layer.plot;
    applied.push(layer.name);
    if (p.off) off.push(layer.name);
    if (p.frozen) frozen.push(layer.name);
  }
  const current = doc.layers.some((l) => eq(l.name, snap.current)) ? snap.current : "";
  return { applied, missing, current, off, frozen };
}

/** Plain-object form of the states map, for JSON persistence. */
export function serializeLayerStates(
  states: ReadonlyMap<string, LayerStateSnapshot>,
): Record<string, LayerStateSnapshot> {
  const out: Record<string, LayerStateSnapshot> = {};
  for (const [k, v] of states) out[k] = v;
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function sanitizeProps(raw: unknown): LayerStateProps | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.off !== "boolean" || typeof raw.frozen !== "boolean" || typeof raw.locked !== "boolean") return null;
  if (typeof raw.color !== "number" || !Number.isFinite(raw.color)) return null;
  const p: LayerStateProps = { off: raw.off, frozen: raw.frozen, locked: raw.locked, color: Math.round(raw.color) };
  if (raw.rgb != null) {
    if (typeof raw.rgb !== "number" || !Number.isFinite(raw.rgb)) return null;
    p.rgb = Math.round(raw.rgb);
  }
  if (raw.lineType != null) {
    if (typeof raw.lineType !== "string") return null;
    p.lineType = raw.lineType;
  }
  if (raw.lineweight != null) {
    if (typeof raw.lineweight !== "number" || !Number.isFinite(raw.lineweight)) return null;
    p.lineweight = raw.lineweight;
  }
  if (raw.transparency != null) {
    if (typeof raw.transparency !== "number" || !Number.isInteger(raw.transparency) || raw.transparency < 0 || raw.transparency > 90) return null;
    p.transparency = raw.transparency;
  }
  if (raw.plot != null) {
    if (typeof raw.plot !== "boolean") return null;
    p.plot = raw.plot;
  }
  return p;
}

function sanitizeSnapshot(raw: unknown, name: string): LayerStateSnapshot | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.current !== "string") return null;
  if (!isRecord(raw.layers)) return null;
  const layers: Record<string, LayerStateProps> = {};
  for (const [lname, props] of Object.entries(raw.layers)) {
    if (!lname || lname.length > MAX_LAYER_NAME) return null;
    const p = sanitizeProps(props);
    if (!p) return null;
    layers[lname] = p;
  }
  return { name, current: raw.current, layers };
}

/**
 * Validate persisted layer states (localStorage, older app version,
 * hand-edited). A malformed state is dropped, never applied — a bad
 * value can only lose that one state, never break opening a drawing.
 */
export function sanitizeLayerStates(raw: unknown): Record<string, LayerStateSnapshot> {
  const out: Record<string, LayerStateSnapshot> = {};
  if (!isRecord(raw)) return out;
  for (const [name, snap] of Object.entries(raw)) {
    if (!name || name.length > MAX_LAYER_NAME) continue;
    const clean = sanitizeSnapshot(snap, name);
    if (clean) out[name] = clean;
  }
  return out;
}
