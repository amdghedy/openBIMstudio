/**
 * OpenBIMStudio Strengthening Package — Boot Wire (stub)
 *
 * Full module implementations live on branch `feat/strengthening-p0-p2-gap-closure`.
 * This stub keeps main typecheck/build green until those modules are merged.
 *
 * When modules are present, restore imports of:
 *   transaction, parametric-regen, properties-panel, joins-cleanup,
 *   lod-performance, view-templates, site-topo, detailing, validation
 */

export function bootStrengtheningModules(): void {
  if (typeof console !== "undefined") {
    console.info(
      "[Strengthening] stub boot — full modules not yet on this branch"
    );
  }
}

// Safe no-op when imported from main.ts
bootStrengtheningModules();
