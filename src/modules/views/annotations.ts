/**
 * Annotation types â€” dimensions and tags that live in a VIEW, not in the
 * element model. Every annotation references the element(s) it describes
 * through the Reference system so it follows element motion.
 */

import type { Reference } from "./references";

export type DimensionKind =
  | "aligned" | "linear" | "angular" | "radial" | "diameter" | "arc"
  | "spot-elevation" | "spot-coordinate";

export interface DimensionStyle {
  id: string;
  name: string;
  unit: "mm" | "cm" | "m";
  precision: number;
  textSizePt: number;
  color: string;
  tick: "diagonal" | "dot" | "arrow";
}

export const DEFAULT_DIM_STYLES: DimensionStyle[] = [
  { id: "aligned-mm", name: "Aligned 2.5 mm", unit: "mm", precision: 0, textSizePt: 2.5, color: "#1d4ed8", tick: "diagonal" },
  { id: "eng-mm", name: "Engineering 3 mm", unit: "mm", precision: 0, textSizePt: 3, color: "#1e40af", tick: "diagonal" },
  { id: "decimal-m", name: "Decimal meters", unit: "m", precision: 3, textSizePt: 2.5, color: "#1d4ed8", tick: "arrow" },
];

export interface Dimension {
  id: string;
  viewId: string;
  kind: DimensionKind;
  styleId: string;
  ref1: Reference;
  ref2?: Reference;
  vertexRef?: Reference;
  offsetMm: number;
  override?: string;
  label?: string;
  createdAt: number;
}

export type TagKind = "category" | "material" | "room" | "custom";

export interface Tag {
  id: string;
  viewId: string;
  ref: Reference;
  kind: TagKind;
  field?: string;
  offsetMm: [number, number];
  leader: boolean;
  leaderShape: "straight" | "curved" | "none";
  rotation: 0 | 90 | 180 | 270;
  override?: string;
  createdAt: number;
}

export interface TextNote {
  id: string;
  viewId: string;
  x: number;
  z: number;
  text: string;
  sizePt: number;
  color: string;
  rotation: number;
  anchor: "start" | "middle" | "end";
}

const dimensionsByView = new Map<string, Dimension[]>();
const tagsByView = new Map<string, Tag[]>();
const notesByView = new Map<string, TextNote[]>();

export function getDimensions(viewId: string): Dimension[] { return dimensionsByView.get(viewId) ?? []; }

export function setDimensions(viewId: string, arr: Dimension[]): void {
  if (arr.length) dimensionsByView.set(viewId, arr.slice());
  else dimensionsByView.delete(viewId);
}

export function updateDimension(viewId: string, id: string, patch: Partial<Dimension>): boolean {
  const arr = dimensionsByView.get(viewId);
  if (!arr) return false;
  const i = arr.findIndex((d) => d.id === id);
  if (i < 0) return false;
  arr[i] = { ...arr[i], ...patch };
  return true;
}
export function addDimension(d: Dimension): Dimension {
  const arr = dimensionsByView.get(d.viewId) ?? [];
  arr.push(d);
  dimensionsByView.set(d.viewId, arr);
  return d;
}
export function removeDimension(viewId: string, id: string): void {
  const arr = dimensionsByView.get(viewId);
  if (!arr) return;
  dimensionsByView.set(viewId, arr.filter((d) => d.id !== id));
}

export function getTags(viewId: string): Tag[] { return tagsByView.get(viewId) ?? []; }

export function setTags(viewId: string, arr: Tag[]): void {
  if (arr.length) tagsByView.set(viewId, arr.slice());
  else tagsByView.delete(viewId);
}

export function updateTag(viewId: string, id: string, patch: Partial<Tag>): boolean {
  const arr = tagsByView.get(viewId);
  if (!arr) return false;
  const i = arr.findIndex((t) => t.id === id);
  if (i < 0) return false;
  arr[i] = { ...arr[i], ...patch };
  return true;
}
export function addTag(t: Tag): Tag {
  const arr = tagsByView.get(t.viewId) ?? [];
  arr.push(t);
  tagsByView.set(t.viewId, arr);
  return t;
}
export function removeTag(viewId: string, id: string): void {
  const arr = tagsByView.get(viewId);
  if (!arr) return;
  tagsByView.set(viewId, arr.filter((t) => t.id !== id));
}

export function getNotes(viewId: string): TextNote[] { return notesByView.get(viewId) ?? []; }

export function setNotes(viewId: string, arr: TextNote[]): void {
  if (arr.length) notesByView.set(viewId, arr.slice());
  else notesByView.delete(viewId);
}

export function updateNote(viewId: string, id: string, patch: Partial<TextNote>): boolean {
  const arr = notesByView.get(viewId);
  if (!arr) return false;
  const i = arr.findIndex((n) => n.id === id);
  if (i < 0) return false;
  arr[i] = { ...arr[i], ...patch };
  return true;
}
export function addNote(n: TextNote): TextNote {
  const arr = notesByView.get(n.viewId) ?? [];
  arr.push(n);
  notesByView.set(n.viewId, arr);
  return n;
}