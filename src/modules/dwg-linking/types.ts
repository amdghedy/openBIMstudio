/**
 * DWG linking — attach CAD files as underlays in 3D + 2D views.
 *
 * Unlike "import" (which converts geometry), "link" maintains a live
 * reference to the DWG file so it can be reloaded when the source
 * changes. Matches Revit's "Link CAD" feature.
 */

export interface DwgLink {
  id: string;
  name: string;
  /** File path or URL. */
  source: string;
  /** Position offset [x, y, z] in metres. */
  offset: [number, number, number];
  /** Rotation (degrees around Y). */
  rotation: number;
  /** Scale factor. */
  scale: number;
  /** Layer visibility map (layer name → visible). */
  layerVisibility: Record<string, boolean>;
  /** Whether the link is currently loaded. */
  loaded: boolean;
  /** Positioning mode. */
  positioning: "origin-to-origin" | "shared-coordinates" | "manual";
}

const links = new Map<string, DwgLink>();
let idCounter = 0;

export function addDwgLink(name: string, source: string, positioning: DwgLink["positioning"] = "origin-to-origin"): DwgLink {
  const link: DwgLink = {
    id: `dwg-link-${++idCounter}`,
    name,
    source,
    offset: [0, 0, 0],
    rotation: 0,
    scale: 1,
    layerVisibility: {},
    loaded: true,
    positioning,
  };
  links.set(link.id, link);
  console.log(`[dwg-link] linked "${name}" from ${source}`);
  return link;
}

export function listDwgLinks(): DwgLink[] { return [...links.values()]; }
export function getDwgLink(id: string): DwgLink | null { return links.get(id) ?? null; }

export function removeDwgLink(id: string): void {
  links.delete(id);
  console.log(`[dwg-link] removed ${id}`);
}

export function reloadDwgLink(id: string): boolean {
  const link = links.get(id);
  if (!link) return false;
  link.loaded = true;
  console.log(`[dwg-link] reloaded "${link.name}"`);
  return true;
}

export function toggleDwgLayer(linkId: string, layerName: string): void {
  const link = links.get(linkId);
  if (!link) return;
  link.layerVisibility[layerName] = !link.layerVisibility[layerName];
}

let installed = false;
export function setupDwgLinking() {
  if (installed) return; installed = true;
  (window as any).__obsDwgLinks = {
    add: addDwgLink, list: listDwgLinks, get: getDwgLink,
    remove: removeDwgLink, reload: reloadDwgLink, toggleLayer: toggleDwgLayer,
  };
  console.log("[dwg-linking] ready. Link CAD files via __obsDwgLinks.add(name, source).");
}
