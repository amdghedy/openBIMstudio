/**
 * Annotation store - persistence, selection, and change events.
 */

import type { Dimension, Tag, TextNote } from "./annotations";
import {
  getDimensions, getTags, getNotes,
  setDimensions, setTags, setNotes,
  removeDimension, removeTag,
} from "./annotations";
import { listViews } from "./store";

const STORAGE_KEY = "obs.views.annotations.v1";

export type AnnotationKind = "dimension" | "tag" | "note";

export interface AnnotationRef {
  kind: AnnotationKind;
  id: string;
  viewId: string;
}

export interface SerializedAnnotations {
  dimensions: Dimension[];
  tags: Tag[];
  notes: TextNote[];
  updatedAt: number;
}

let selection: AnnotationRef | null = null;
const listeners = new Set<() => void>();
let booted = false;

function emit(): void {
  for (const cb of listeners) {
    try { cb(); } catch { /* */ }
  }
}

export function onAnnotationChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSelection(): AnnotationRef | null { return selection; }

export function setSelection(ref: AnnotationRef | null): void {
  const wasSame =
    (ref === null && selection === null) ||
    (ref !== null && selection !== null &&
      ref.kind === selection.kind && ref.id === selection.id);
  if (wasSame) return;
  selection = ref;
  emit();
}

export function clearSelection(): void {
  if (selection) { selection = null; emit(); }
}

export function serializeAll(): SerializedAnnotations {
  const dimensions: Dimension[] = [];
  const tags: Tag[] = [];
  const notes: TextNote[] = [];
  for (const v of listViews()) {
    for (const d of getDimensions(v.id)) dimensions.push(d);
    for (const t of getTags(v.id)) tags.push(t);
    for (const n of getNotes(v.id)) notes.push(n);
  }
  return { dimensions, tags, notes, updatedAt: Date.now() };
}

export function deserializeAll(data: SerializedAnnotations | null | undefined): void {
  for (const v of listViews()) {
    setDimensions(v.id, []);
    setTags(v.id, []);
    setNotes(v.id, []);
  }
  if (!data) { emit(); return; }

  const dims = new Map<string, Dimension[]>();
  const tags = new Map<string, Tag[]>();
  const notes = new Map<string, TextNote[]>();

  for (const d of data.dimensions ?? []) {
    const arr = dims.get(d.viewId) ?? [];
    arr.push(d);
    dims.set(d.viewId, arr);
  }
  for (const t of data.tags ?? []) {
    const arr = tags.get(t.viewId) ?? [];
    arr.push(t);
    tags.set(t.viewId, arr);
  }
  for (const n of data.notes ?? []) {
    const arr = notes.get(n.viewId) ?? [];
    arr.push(n);
    notes.set(n.viewId, arr);
  }

  for (const [viewId, arr] of dims) setDimensions(viewId, arr);
  for (const [viewId, arr] of tags) setTags(viewId, arr);
  for (const [viewId, arr] of notes) setNotes(viewId, arr);

  emit();
}

export function saveToLocalStorage(): void {
  try {
    const data = serializeAll();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (err) {
    console.warn("[annotation-store] save failed", err);
  }
}

export function loadFromLocalStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as SerializedAnnotations;
    deserializeAll(parsed);
  } catch (err) {
    console.warn("[annotation-store] load failed", err);
  }
}

export function deleteAnnotation(ref: AnnotationRef): boolean {
  switch (ref.kind) {
    case "dimension":
      removeDimension(ref.viewId, ref.id);
      break;
    case "tag":
      removeTag(ref.viewId, ref.id);
      break;
    case "note":
      removeNoteById(ref.viewId, ref.id);
      break;
  }
  if (selection && selection.kind === ref.kind && selection.id === ref.id) {
    selection = null;
  }
  saveToLocalStorage();
  emit();
  return true;
}

function removeNoteById(viewId: string, id: string): void {
  const arr = getNotes(viewId).filter((n) => n.id !== id);
  setNotes(viewId, arr);
}

export function bootAnnotationStore(): void {
  if (booted) return;
  booted = true;
  loadFromLocalStorage();
  onAnnotationChange(() => saveToLocalStorage());
  console.log("[annotation-store] ready");
}