/** Plugin marketplace registry — discover + install community plugins. */
export interface MarketplaceEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  version: string;
  /** Download URL (or relative path to /plugins/<id>/). */
  downloadUrl: string;
  /** Downloads count. */
  downloads: number;
  /** Rating (0-5). */
  rating: number;
  /** Tags. */
  tags: string[];
}

/** Built-in marketplace entries (curated). */
export const MARKETPLACE: MarketplaceEntry[] = [
  { id: "ifc-validator", name: "IFC Validator", author: "Core Team", description: "Validate IFC models for missing GlobalIds, duplicates, unit inconsistencies.", version: "1.0.0", downloadUrl: "/plugins/ifc-validator/index.js", downloads: 1240, rating: 4.5, tags: ["ifc", "validation"] },
  { id: "csv-takeoff", name: "CSV Quantity Take-Off", author: "Core Team", description: "Export element quantities grouped by IFC class to CSV.", version: "1.0.0", downloadUrl: "/plugins/csv-takeoff/index.js", downloads: 980, rating: 4.2, tags: ["quantity", "export"] },
  { id: "family-from-csv", name: "Family Generator from CSV", author: "Core Team", description: "Generate parametric families from CSV type catalogs.", version: "1.0.0", downloadUrl: "/plugins/family-from-csv/index.js", downloads: 650, rating: 4.0, tags: ["family", "parametric"] },
  { id: "clash-rule-pack", name: "Custom Clash Rules", author: "Core Team", description: "MEP-structure clearance, access zones, duplicate detection.", version: "1.0.0", downloadUrl: "/plugins/clash-rule-pack/index.js", downloads: 870, rating: 4.3, tags: ["clash", "coordination"] },
  { id: "element-counter", name: "Element Counter", author: "Core Team", description: "Live panel showing element counts by category.", version: "1.0.0", downloadUrl: "/plugins/element-counter/index.js", downloads: 520, rating: 3.8, tags: ["panel", "stats"] },
];

export function listMarketplace(): MarketplaceEntry[] {
  return [...MARKETPLACE].sort((a, b) => b.downloads - a.downloads);
}
export function searchMarketplace(query: string): MarketplaceEntry[] {
  const q = query.toLowerCase();
  return MARKETPLACE.filter(e =>
    e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) ||
    e.tags.some(t => t.includes(q)),
  );
}

/** Install a plugin from the marketplace (triggers plugin load). */
export async function installPlugin(id: string): Promise<boolean> {
  try {
    const { loadPlugin } = await import("../../plugins/loader");
    return await loadPlugin(id);
  } catch { return false; }
}

let installed = false;
export function setupPluginMarketplace() {
  if (installed) return; installed = true;
  (window as any).__obsMarketplace = { list: listMarketplace, search: searchMarketplace, install: installPlugin };
  console.log("[plugin-marketplace] ready. Browse via __obsMarketplace.list() or install via __obsMarketplace.install(id).");
}
