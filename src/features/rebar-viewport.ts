/**
 * Rebar viewport integration — renders 3D rebar meshes inside host elements.
 *
 * When the user selects a beam or column and runs the "Generate Rebar"
 * command, this module:
 *   1. Extracts the host element's dimensions (width, depth, length) + position
 *   2. Creates a RebarHost from those dimensions
 *   3. Runs layoutRebar() to compute bar positions
 *   4. Runs generateRebarMesh() to produce triangle positions
 *   5. Converts to THREE.BufferGeometry + Mesh and adds to the scene
 *
 * The rebar group is stored in a Map keyed by host element ID so it can
 * be removed when the host is deleted or the rebar is regenerated.
 */

import * as THREE from "three";
import { ctx } from "../core/context";
import { layoutRebar } from "../modules/rebar/layout";
import { generateRebarMesh } from "../modules/rebar/geometry";
import { generateBBS, bbsToCSV, bbsToText } from "../modules/rebar/schedule";
import type { RebarHost, RebarLayoutConfig, RebarLayout } from "../modules/rebar/types";

type Any = Record<string, any>;

/** Track rebar groups by host element ID for cleanup. */
const rebarGroups = new Map<string, THREE.Group>();

/** Track rebar layouts by host element ID for BBS export. */
const rebarLayouts = new Map<string, RebarLayout>();

/**
 * Extract a RebarHost from an authored beam or column element.
 *
 * Beam: start/end define the run direction; width/thickness define the
 *   cross-section; height is used as the depth (vertical dimension).
 * Column: point defines the base; thickness/depth define the cross-section;
 *   height is the column height.
 */
function extractHostFromElement(el: Any): RebarHost | null {
  const p = el.params || {};
  const props = el.properties || {};
  const type = String(el.type ?? "");

  if (type === "beam" && p.start && p.end) {
    const dx = p.end[0] - p.start[0];
    const dz = p.end[1] - p.start[1];
    const L = Math.hypot(dx, dz);
    if (L < 0.1) return null;
    const dir = { x: dx / L, y: 0, z: dz / L };
    return {
      type: "beam",
      width: Number(p.thickness ?? 0.25),
      depth: Number(p.height ?? 0.5),
      length: L,
      thickness: 0,
      origin: { x: p.start[0], y: Number(p.elevation ?? 0), z: p.start[1] },
      direction: dir,
      cover: Number(props.rebarCoverExterior ?? "40") / 1000, // mm → m
    };
  }

  if (type === "column" && p.point) {
    return {
      type: "column",
      width: Number(p.thickness ?? 0.3),
      depth: Number(p.depth ?? p.thickness ?? 0.3),
      length: Number(p.height ?? 3.0),
      thickness: 0,
      origin: { x: p.point[0], y: Number(p.elevation ?? 0), z: p.point[1] },
      direction: { x: 0, y: 1, z: 0 },
      cover: Number(props.rebarCoverExterior ?? "40") / 1000,
    };
  }

  if (type === "footing" && p.point) {
    return {
      type: "footing",
      width: Number(p.thickness ?? 0.5),
      depth: Number(p.depth ?? p.thickness ?? 0.5),
      length: Number(p.height ?? 0.3),
      thickness: 0,
      origin: { x: p.point[0], y: Number(p.elevation ?? 0), z: p.point[1] },
      direction: { x: 0, y: 1, z: 0 },
      cover: Number(props.rebarCoverExterior ?? "50") / 1000,
    };
  }

  return null;
}

/**
 * Generate rebar for the currently selected element and render it in the
 * viewport. Returns the number of bars generated, or 0 on failure.
 */
export function generateRebarForSelection(): number {
  const auth = (ctx.features as any)?.authoring ?? (window as any).__obsAuthoring;
  if (!auth) {
    console.warn("[rebar-viewport] authoring service not available");
    return 0;
  }

  const selectedIds: string[] = auth.getSelectedIds?.() ?? [];
  if (!selectedIds.length) {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "Select a beam or column first, then run Generate Rebar.", kind: "warn" },
    }));
    return 0;
  }

  let totalBars = 0;
  for (const id of selectedIds) {
    const el = auth.getElementById?.(id);
    if (!el) continue;

    const host = extractHostFromElement(el);
    if (!host) {
      window.dispatchEvent(new CustomEvent("obs-toast", {
        detail: { message: `${el.name || el.type}: not a beam/column/footing — skipping.`, kind: "info" },
      }));
      continue;
    }

    // Remove existing rebar for this host.
    removeRebarForHost(id);

    // Layout + generate mesh.
    const cfg: Partial<RebarLayoutConfig> = {
      host,
      mainBarCountBottom: host.type === "column" ? 4 : 2,
      mainBarCountTop: host.type === "column" ? 0 : 2,
      stirrupSpacing: 0.15,
    };

    let layout;
    try {
      layout = layoutRebar(cfg);
    } catch (e) {
      console.warn(`[rebar-viewport] layout failed for ${id}:`, e);
      continue;
    }

    if (!layout.bars.length) continue;

    const mesh = generateRebarMesh(layout.bars, 8, "#6b7280");
    if (!mesh.positions.length) continue;

    // Convert to THREE.BufferGeometry.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshLambertMaterial({
      color: new THREE.Color("#6b7280"),
      metalness: 0.8,
      roughness: 0.3,
    } as any);

    const group = new THREE.Group();
    group.name = `rebar:${id}`;
    group.userData.isRebar = true;
    group.userData.hostElementId = id;

    const meshObj = new THREE.Mesh(geo, mat);
    meshObj.userData.isRebar = true;
    meshObj.userData.hostElementId = id;
    group.add(meshObj);

    // Add to scene.
    try {
      ctx.world?.scene?.three?.add(group);
    } catch (e) {
      console.warn("[rebar-viewport] could not add to scene:", e);
      continue;
    }

    rebarGroups.set(id, group);
    rebarLayouts.set(id, layout);
    totalBars += layout.bars.length;

    console.log(
      `[rebar-viewport] ${el.name || el.type} (${id}): ${layout.bars.length} bars, ` +
      `${layout.totalMass.toFixed(2)} kg, ${(layout.steelRatio * 100).toFixed(2)}% steel ratio`,
    );
  }

  if (totalBars > 0) {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: {
        message: `Rebar generated: ${totalBars} bar(s) across ${selectedIds.length} element(s).`,
        kind: "success",
      },
    }));
  }

  return totalBars;
}

/** Remove rebar meshes for a specific host element. */
export function removeRebarForHost(hostId: string): void {
  const group = rebarGroups.get(hostId);
  if (!group) return;
  try {
    group.traverse((obj: any) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
        else obj.material.dispose();
      }
    });
    ctx.world?.scene?.three?.remove(group);
  } catch { /* */ }
  rebarGroups.delete(hostId);
  rebarLayouts.delete(hostId);
}

/** Remove all rebar meshes from the scene. */
export function clearAllRebar(): void {
  for (const id of rebarGroups.keys()) {
    removeRebarForHost(id);
  }
  console.log("[rebar-viewport] cleared all rebar meshes");
}

/** List host element IDs that currently have rebar. */
export function listRebarHosts(): string[] {
  return [...rebarGroups.keys()];
}

/** Check if rebar has been generated for a host. */
export function hasRebar(hostId: string): boolean {
  return rebarGroups.has(hostId);
}

/**
 * Export a Bar Bending Schedule (BBS) for all elements with rebar.
 * Downloads a CSV file matching the standard BBS format.
 */
export function exportBBS(): void {
  if (rebarLayouts.size === 0) {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "No rebar generated yet. Select a beam/column → Generate Rebar first.", kind: "warn" },
    }));
    return;
  }

  const csvParts: string[] = [];
  let totalBars = 0;
  let totalMass = 0;

  for (const [hostId, layout] of rebarLayouts.entries()) {
    const auth = (ctx.features as any)?.authoring ?? (window as any).__obsAuthoring;
    const el = auth?.getElementById?.(hostId);
    const name = el?.name ?? hostId;
    const bbs = generateBBS(layout, name);
    csvParts.push(bbsToCSV(bbs));
    csvParts.push(""); // blank line between elements
    totalBars += bbs.totalBars;
    totalMass += bbs.totalMass;
  }

  const csv = csvParts.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bar-bending-schedule-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: {
      message: `BBS exported: ${rebarLayouts.size} element(s), ${totalBars} bars, ${totalMass.toFixed(2)} kg total.`,
      kind: "success",
    },
  }));

  // Also print text table to console for quick review.
  for (const [hostId, layout] of rebarLayouts.entries()) {
    const auth = (ctx.features as any)?.authoring ?? (window as any).__obsAuthoring;
    const el = auth?.getElementById?.(hostId);
    const name = el?.name ?? hostId;
    const bbs = generateBBS(layout, name);
    console.log(bbsToText(bbs));
  }
}

/**
 * Register the "Generate Rebar" command. Called from critical-gaps-boot.
 */
export function setupRebarViewport(): void {
  // Register the commands via the command palette / UI items register.
  try {
    const w = window as any;
    if (w.__obsPlugins) {
      w.__obsPlugins.set("command:rebar:generate", {
        id: "rebar.generate",
        label: "Generate Rebar (Selection)",
        hint: "Generate 3D rebar inside the selected beam/column/footing",
        run: () => { generateRebarForSelection(); },
      });
      w.__obsPlugins.set("command:rebar:bbs", {
        id: "rebar.export-bbs",
        label: "Export Bar Bending Schedule (CSV)",
        hint: "Export rebar schedule for all elements with generated rebar",
        run: () => { exportBBS(); },
      });
    }
  } catch { /* */ }

  // Also expose as global for console access.
  (window as any).__obsRebarViewport = {
    generate: generateRebarForSelection,
    remove: removeRebarForHost,
    clear: clearAllRebar,
    list: listRebarHosts,
    has: hasRebar,
    exportBBS: exportBBS,
  };

  console.log("[rebar-viewport] ready. Select a beam/column → Generate Rebar. Then Export BBS for schedule.");
}
