// Convert 2D drafting overlay entities into project annotations and push
// them onto the active sheet. Also provides the screen->world conversion
// used by the drafting overlay and by every click-to-world tool.
import * as THREE from "three";
import { ctx } from "../core/context";

interface ScreenPt { x: number; y: number; }
interface WorldPt  { x: number; y: number; z: number; }

function toast(msg: string, kind: "info" | "success" | "warn"): void {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: msg, kind: kind } }));
  } catch (e) { /* ignore */ }
}

function getHost(): HTMLElement | null {
  const cont: any = ctx as any;
  return (cont.rightHost as HTMLElement) ||
    document.getElementById("viewport") ||
    (document.querySelector(".obs-viewport") as HTMLElement | null);
}

/**
 * Convert a screen-space point into a world position on the ground plane.
 * This is the anchor used by the 2D drafting overlay and every click-based
 * drafting tool. Tested by verify-input-focus.mjs as "converts screen->world".
 */
export function screenToWorldXZ(p: ScreenPt): WorldPt | null {
  const cont: any = ctx as any;
  const host = getHost();
  const cam = cont.world?.camera?.three as THREE.Camera | undefined;
  if (!host || !cam) return null;

  const rect = host.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;

  const ndcX = ((p.x - rect.left) / rect.width) * 2 - 1;
  const ndcY = -(((p.y - rect.top) / rect.height) * 2 - 1);

  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);

  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  if (ray.ray.intersectPlane(plane, hit)) {
    return { x: hit.x, y: hit.y, z: hit.z };
  }
  return null;
}

export async function exportDraftingToAnnotations(): Promise<number> {
  const d: any = (window as any).__obsDrafting2D;
  if (!d || !d.getEntities) { toast("No 2D drafting overlay active.", "warn"); return 0; }
  const entities = d.getEntities() || [];
  if (!entities.length) { toast("Drafting overlay is empty.", "warn"); return 0; }

  const projects: any = (ctx.features as any).projects;
  const doc = projects && projects.getCurrentProject ? projects.getCurrentProject() : null;
  if (!doc) { toast("No project open.", "warn"); return 0; }

  doc.annotations = doc.annotations || [];
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    doc.annotations.push({
      id: "ann-" + e.id,
      kind: e.kind,
      a: e.a,
      b: e.b,
      r: e.r,
      text: e.text,
      color: e.color,
      strokeWidth: e.strokeWidth,
      source: "drafting2d",
      createdAt: Date.now(),
    });
  }
  try { projects.markDirty && projects.markDirty(); } catch (e) { /* ignore */ }
  try { projects.saveProject && await projects.saveProject(); } catch (e) { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent("obs:annotations-changed")); } catch (e) { /* ignore */ }
  return entities.length;
}

export async function attachDraftingToCurrentSheet(): Promise<boolean> {
  const d: any = (window as any).__obsDrafting2D;
  const entities = (d && d.getEntities) ? d.getEntities() : [];
  if (!entities.length) { toast("Nothing to attach - drafting overlay is empty.", "warn"); return false; }

  const sheets: any = (ctx.features as any).sheetsPanel;
  if (!sheets) { toast("Sheets panel is not loaded.", "warn"); return false; }
  if (typeof sheets.addToCurrentSheet !== "function") {
    toast("Sheets panel does not support drafting attachment yet.", "warn");
    return false;
  }
  try {
    sheets.addToCurrentSheet(entities);
    toast("Drafting attached to current sheet.", "success");
    return true;
  } catch (err) {
    console.warn("[drafting-bridge] attach failed", err);
    return false;
  }
}

export function setupDraftingBridge(): void {
  (window as any).__obsDraftingBridge = {
    exportDraftingToAnnotations: exportDraftingToAnnotations,
    attachDraftingToCurrentSheet: attachDraftingToCurrentSheet,
    screenToWorldXZ: screenToWorldXZ,
  };
  console.log("[drafting-bridge] ready");
}