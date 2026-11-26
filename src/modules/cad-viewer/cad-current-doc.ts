// AutoCAD 2D parity A20 — the current CAD drawing, published by the
// viewer for the BIM-side panels (batch plotter, sheets panel).
//
// The CAD viewer owns the live `DxfDocument`; the BIM sheet system lives
// in a different feature module and must not reach into the viewer's
// closure. This tiny registry is the bridge: the viewer publishes the
// live document (by reference — layouts, entities and blocks are read
// live at plot time, so no snapshot can go stale) whenever the document
// is opened, created, or another tab becomes active, and the panels read
// it when they open. It carries no behaviour and migrates no data
// between the two sheet stores (A20 deliberately does not unify them —
// that is a user decision, recorded as a follow-up).
//
// The entry is the LAST-OPENED drawing, not only the visible one: the
// viewer shell (z-index 10050) sits above both panels, so the panels
// are used with the viewer closed, and the entry must survive the
// viewer closing — the document object and the model accessor stay
// valid after the tab is gone (the closure keeps them alive), and the
// entry is replaced as soon as another drawing opens. There is no
// explicit "clear": a drawing that was opened is the current drawing
// until another one replaces it.
import type { DxfDocument, DxfEntity } from "../drawings/dxf-types";

export interface CurrentCadDoc {
  /** Live document reference (layouts/entities/blocks read live). */
  doc: DxfDocument;
  /** Drawing/file name, for display only. */
  name: string;
  /**
   * Live model-space entities. The viewer's model list is rebound on
   * undo/erase (doc.entities goes stale — see cad-viewer saveDxf), so
   * it is read through this accessor at use time, never snapshotted.
   */
  getModel: () => DxfEntity[];
}

let current: CurrentCadDoc | null = null;

export function setCurrentCadDoc(doc: CurrentCadDoc | null): void {
  current = doc;
}

export function getCurrentCadDoc(): CurrentCadDoc | null {
  return current;
}
