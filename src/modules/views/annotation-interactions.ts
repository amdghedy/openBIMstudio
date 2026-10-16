/**
 * Interactive layer for annotations.
 */

import { getElements } from "../../features/authoring";
import {
  getDimensions, getTags, getNotes, updateDimension, updateTag, updateNote,
  setDimensions, setTags, setNotes,
} from "./annotations";
import {
  getSelection, setSelection, clearSelection, deleteAnnotation,
  type AnnotationRef,
} from "./annotation-store";
import { resolveDimension } from "./dimension-engine";
import { resolveTag } from "./tag-engine";
import type { ViewDef } from "./types";
import type { SceneEntity } from "./scene";
import { history } from "../../features/history";

const HIT_TOLERANCE_PX = 8;
const DRAG_THRESHOLD_PX = 4;

interface ResolvedEntity {
  ref: AnnotationRef;
  entities: SceneEntity[];
}

function aabbOfEntities(entities: SceneEntity[]): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  let any = false;
  const consider = (x: number, z: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    any = true;
  };
  for (const e of entities) {
    if (e.kind === "line") { consider(e.x1, e.z1); consider(e.x2, e.z2); }
    else if (e.kind === "polyline") { for (const [x, z] of e.points) consider(x, z); }
    else if (e.kind === "arc") { consider(e.cx - e.r, e.cz - e.r); consider(e.cx + e.r, e.cz + e.r); }
    else if (e.kind === "circle") { consider(e.cx - e.r, e.cz - e.r); consider(e.cx + e.r, e.cz + e.r); }
    else if (e.kind === "text" || e.kind === "symbol") { consider(e.x, e.z); }
  }
  return any ? { minX, minZ, maxX, maxZ } : null;
}

function resolveAll(view: ViewDef): ResolvedEntity[] {
  const elements = getElements();
  const out: ResolvedEntity[] = [];
  for (const d of getDimensions(view.id)) {
    const r = resolveDimension(d, elements, view.scale);
    if (r.valid) out.push({ ref: { kind: "dimension", id: d.id, viewId: view.id }, entities: r.entities });
  }
  for (const t of getTags(view.id)) {
    const r = resolveTag(t, elements, view.scale);
    if (r.valid) out.push({ ref: { kind: "tag", id: t.id, viewId: view.id }, entities: r.entities });
  }
  for (const n of getNotes(view.id)) {
    out.push({
      ref: { kind: "note", id: n.id, viewId: view.id },
      entities: [{
        kind: "text", x: n.x, z: n.z, text: n.text,
        anchor: n.anchor, sizePt: n.sizePt, rotation: n.rotation, color: n.color,
      }],
    });
  }
  return out;
}

function hitTest(view: ViewDef, worldX: number, worldZ: number, tolerance: number): AnnotationRef | null {
  const resolved = resolveAll(view);
  let best: { ref: AnnotationRef; dist: number } | null = null;
  for (const r of resolved) {
    const bb = aabbOfEntities(r.entities);
    if (!bb) continue;
    if (worldX < bb.minX - tolerance || worldX > bb.maxX + tolerance) continue;
    if (worldZ < bb.minZ - tolerance || worldZ > bb.maxZ + tolerance) continue;
    const cx = (bb.minX + bb.maxX) / 2;
    const cz = (bb.minZ + bb.maxZ) / 2;
    const d = Math.hypot(worldX - cx, worldZ - cz);
    if (!best || d < best.dist) best = { ref: r.ref, dist: d };
  }
  return best ? best.ref : null;
}

function svgPointToWorld(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; z: number; worldTol: number } | null {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  if (!rect.width || !rect.height || !vb.width) return null;
  const px = ((clientX - rect.left) / rect.width) * vb.width + vb.x;
  const py = ((clientY - rect.top) / rect.height) * vb.height + vb.y;
  const worldTol = (vb.width / rect.width) * HIT_TOLERANCE_PX;
  return { x: px, z: -py, worldTol };
}

let ctxMenu: HTMLDivElement | null = null;
function ensureCtxMenu(): HTMLDivElement {
  if (ctxMenu) return ctxMenu;
  ctxMenu = document.createElement("div");
  ctxMenu.style.cssText =
    "position:fixed;z-index:9700;display:none;min-width:180px;" +
    "background:#1c1e28;color:#e8eaf0;border:1px solid #2a2e3a;" +
    "border-radius:6px;box-shadow:0 12px 30px rgba(0,0,0,.55);" +
    "font:12px system-ui,sans-serif;padding:4px 0";
  ctxMenu.onmousedown = (e) => e.stopPropagation();
  document.body.appendChild(ctxMenu);
  return ctxMenu;
}

function closeCtxMenu(): void {
  if (ctxMenu) ctxMenu.style.display = "none";
}

function mkCtxRow(label: string, onClick: () => void, danger = false): HTMLElement {
  const row = document.createElement("div");
  row.textContent = label;
  row.style.cssText =
    "padding:6px 14px;cursor:pointer;font-size:12px;" +
    (danger ? "color:#fca5a5;" : "");
  row.onmouseenter = () => { row.style.background = "rgba(56,189,248,.14)"; };
  row.onmouseleave = () => { row.style.background = "transparent"; };
  row.onclick = (ev) => { ev.stopPropagation(); closeCtxMenu(); onClick(); };
  return row;
}

function openCtxMenu(ref: AnnotationRef, clientX: number, clientY: number, onRerender: () => void): void {
  const menu = ensureCtxMenu();
  menu.innerHTML = "";
  menu.appendChild(mkCtxRow("Delete", () => {
    deleteAnnotation(ref);
    onRerender();
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "Annotation deleted", kind: "info" },
    }));
  }, true));
  if (ref.kind === "tag") {
    menu.appendChild(mkCtxRow("Rotate 90", () => {
      const arr = getTags(ref.viewId);
      const tag = arr.find((t) => t.id === ref.id);
      if (tag) {
        const next = ((tag.rotation + 90) % 360) as 0 | 90 | 180 | 270;
        updateTag(ref.viewId, ref.id, { rotation: next });
        onRerender();
      }
    }));
    menu.appendChild(mkCtxRow("Toggle leader", () => {
      const arr = getTags(ref.viewId);
      const tag = arr.find((t) => t.id === ref.id);
      if (tag) {
        updateTag(ref.viewId, ref.id, { leader: !tag.leader });
        onRerender();
      }
    }));
  }
  if (ref.kind === "dimension") {
    menu.appendChild(mkCtxRow("Reset offset (400 mm)", () => {
      updateDimension(ref.viewId, ref.id, { offsetMm: 400 });
      onRerender();
    }));
  }
  menu.style.left = clientX + "px";
  menu.style.top = clientY + "px";
  menu.style.display = "block";
  const close = (ev: MouseEvent) => {
    if (ctxMenu && !ctxMenu.contains(ev.target as Node)) {
      closeCtxMenu();
      document.removeEventListener("mousedown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close, true), 0);
}

let keyHandlerInstalled = false;
function installKeyHandler(onRerender: () => void): void {
  if (keyHandlerInstalled) return;
  keyHandlerInstalled = true;
  window.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const ref = getSelection();
    if (!ref) return;
    e.preventDefault();
    const snapshot = captureForUndo(ref);
    deleteAnnotation(ref);
    onRerender();
    history.push({
      label: "Delete annotation",
      apply: () => { deleteAnnotation(ref); onRerender(); },
      revert: () => { restoreFromUndo(ref, snapshot); onRerender(); },
    });
  });
}

function captureForUndo(ref: AnnotationRef): any {
  if (ref.kind === "dimension") {
    const d = getDimensions(ref.viewId).find((x) => x.id === ref.id);
    return d ? JSON.parse(JSON.stringify(d)) : null;
  }
  if (ref.kind === "tag") {
    const t = getTags(ref.viewId).find((x) => x.id === ref.id);
    return t ? JSON.parse(JSON.stringify(t)) : null;
  }
  const n = getNotes(ref.viewId).find((x) => x.id === ref.id);
  return n ? JSON.parse(JSON.stringify(n)) : null;
}

function restoreFromUndo(ref: AnnotationRef, snap: any): void {
  if (!snap) return;
  if (ref.kind === "dimension") {
    const arr = getDimensions(ref.viewId).slice();
    if (!arr.some((d) => d.id === snap.id)) arr.push(snap);
    setDimensions(ref.viewId, arr);
  } else if (ref.kind === "tag") {
    const arr = getTags(ref.viewId).slice();
    if (!arr.some((t) => t.id === snap.id)) arr.push(snap);
    setTags(ref.viewId, arr);
  } else if (ref.kind === "note") {
    const arr = getNotes(ref.viewId).slice();
    if (!arr.some((n) => n.id === snap.id)) arr.push(snap);
    setNotes(ref.viewId, arr);
  }
}

export interface InteractionOptions {
  svg: SVGSVGElement;
  view: ViewDef;
  onRerender: () => void;
}

export function attachAnnotationInteractions(opts: InteractionOptions): void {
  const { svg, view, onRerender } = opts;
  installKeyHandler(onRerender);

  let candidate: { ref: AnnotationRef; startX: number; startY: number } | null = null;
  let dragging = false;
  let startOffsets: { dimOffset?: number; tagOffX?: number; tagOffZ?: number; noteX?: number; noteZ?: number } = {};

  svg.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    const p = svgPointToWorld(svg, ev.clientX, ev.clientY);
    if (!p) return;
    const ref = hitTest(view, p.x, p.z, p.worldTol);
    if (!ref) return;
    ev.stopPropagation();
    candidate = { ref, startX: ev.clientX, startY: ev.clientY };
    if (ref.kind === "dimension") {
      const d = getDimensions(ref.viewId).find((x) => x.id === ref.id);
      if (d) startOffsets = { dimOffset: d.offsetMm };
    } else if (ref.kind === "tag") {
      const t = getTags(ref.viewId).find((x) => x.id === ref.id);
      if (t) startOffsets = { tagOffX: t.offsetMm[0], tagOffZ: t.offsetMm[1] };
    } else if (ref.kind === "note") {
      const n = getNotes(ref.viewId).find((x) => x.id === ref.id);
      if (n) startOffsets = { noteX: n.x, noteZ: n.z };
    }
  }, true);

  const onMove = (ev: MouseEvent) => {
    if (!candidate) return;
    const dx = ev.clientX - candidate.startX;
    const dy = ev.clientY - candidate.startY;
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    dragging = true;
    const p = svgPointToWorld(svg, ev.clientX, ev.clientY);
    if (!p) return;
    const vb = svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    const worldPerPx = vb.width / Math.max(1, rect.width);
    const dxWorld = dx * worldPerPx;
    const dyWorld = dy * worldPerPx;
    const ref = candidate.ref;
    if (ref.kind === "dimension" && startOffsets.dimOffset != null) {
      const newOffset = startOffsets.dimOffset + (dyWorld * 1000 / view.scale);
      updateDimension(ref.viewId, ref.id, { offsetMm: Math.max(-2000, Math.min(2000, newOffset)) });
      onRerender();
    } else if (ref.kind === "tag" && startOffsets.tagOffX != null && startOffsets.tagOffZ != null) {
      const worldToPaper = 1000 / view.scale;
      const newX = startOffsets.tagOffX + dxWorld * worldToPaper;
      const newZ = startOffsets.tagOffZ - dyWorld * worldToPaper;
      updateTag(ref.viewId, ref.id, { offsetMm: [newX, newZ] });
      onRerender();
    } else if (ref.kind === "note" && startOffsets.noteX != null && startOffsets.noteZ != null) {
      const newX = startOffsets.noteX + dxWorld;
      const newZ = startOffsets.noteZ - dyWorld;
      updateNote(ref.viewId, ref.id, { x: newX, z: newZ });
      onRerender();
    }
  };

  const onUp = (ev: MouseEvent) => {
    if (!candidate) return;
    const ref = candidate.ref;
    if (!dragging) {
      setSelection(ref);
    } else {
      const before = { ...startOffsets };
      let after: any = {};
      if (ref.kind === "dimension") {
        const d = getDimensions(ref.viewId).find((x) => x.id === ref.id);
        if (d) after = { dimOffset: d.offsetMm };
      } else if (ref.kind === "tag") {
        const t = getTags(ref.viewId).find((x) => x.id === ref.id);
        if (t) after = { tagOffX: t.offsetMm[0], tagOffZ: t.offsetMm[1] };
      } else if (ref.kind === "note") {
        const n = getNotes(ref.viewId).find((x) => x.id === ref.id);
        if (n) after = { noteX: n.x, noteZ: n.z };
      }
      history.push({
        label: "Move annotation",
        apply: () => {
          if (ref.kind === "dimension" && after.dimOffset != null) updateDimension(ref.viewId, ref.id, { offsetMm: after.dimOffset });
          else if (ref.kind === "tag" && after.tagOffX != null && after.tagOffZ != null) updateTag(ref.viewId, ref.id, { offsetMm: [after.tagOffX, after.tagOffZ] });
          else if (ref.kind === "note" && after.noteX != null) updateNote(ref.viewId, ref.id, { x: after.noteX, z: after.noteZ });
          onRerender();
        },
        revert: () => {
          if (ref.kind === "dimension" && before.dimOffset != null) updateDimension(ref.viewId, ref.id, { offsetMm: before.dimOffset });
          else if (ref.kind === "tag" && before.tagOffX != null && before.tagOffZ != null) updateTag(ref.viewId, ref.id, { offsetMm: [before.tagOffX, before.tagOffZ] });
          else if (ref.kind === "note" && before.noteX != null) updateNote(ref.viewId, ref.id, { x: before.noteX, z: before.noteZ });
          onRerender();
        },
      });
    }
    candidate = null;
    dragging = false;
    startOffsets = {};
    ev.stopPropagation();
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  svg.addEventListener("contextmenu", (ev) => {
    const p = svgPointToWorld(svg, ev.clientX, ev.clientY);
    if (!p) return;
    const ref = hitTest(view, p.x, p.z, p.worldTol);
    if (!ref) { closeCtxMenu(); return; }
    ev.preventDefault();
    ev.stopPropagation();
    setSelection(ref);
    openCtxMenu(ref, ev.clientX, ev.clientY, onRerender);
  }, true);

  svg.addEventListener("click", (ev) => {
    if (candidate || dragging) return;
    const p = svgPointToWorld(svg, ev.clientX, ev.clientY);
    if (!p) return;
    const ref = hitTest(view, p.x, p.z, p.worldTol);
    if (!ref) clearSelection();
  }, true);
}