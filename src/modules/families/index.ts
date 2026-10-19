// openbim-step1:family-foundation
// Family system foundation - public entry point.
//
// Importing this module installs the family service in the typed service
// registry and mounts it on ctx.features.family. Call setupFamilies()
// once during boot; it is idempotent.

import { ctx } from "../../core/context";
import { register } from "../../core/services";
import { familyStore } from "./store";
import { createFamilyService } from "./registry";
import { createBuiltInFamilies } from "./builtin-families";
import { loadSeedFamilyCatalogTracked } from "./library-loader";
import type { FamilyService } from "./types";

export * from "./types";
export { familyStore } from "./store";
export {
  buildParametricGeometry,
  registerCustomBuilder,
  resolveNumber,
  resolveTransform,
} from "./parametric-geometry";
export {
  createFamilyService,
  buildFamilyPreview,
} from "./registry";
export { createBuiltInFamilies } from "./builtin-families";

let installed = false;

export function setupFamilies(): FamilyService {
  if (installed) {
    return (ctx.features as any).family as FamilyService;
  }
  installed = true;

  // Seed built-ins on first boot, then load any persisted user families.
  const builtins = createBuiltInFamilies();
  familyStore.boot(builtins);

  const svc = createFamilyService();

  register("family", svc);
  (ctx.features as any).family = svc;
  try { (window as any).__obsFamily = svc; } catch { /* */ }

  // Diagnostics.
  const list = svc.list();
  console.log(
    "[families] ready. " + list.length + " family definition(s), " +
    list.reduce((n, f) => n + f.types.length, 0) + " type(s)."
  );

  // Async-load the larger seed catalog from public/families/*.json.
  // This is non-blocking: builtins are available immediately, and the
  // family browser will receive a change event when the catalog finishes.
  // On fetch failure (offline, 404) the app stays usable with the builtins.
  loadSeedFamilyCatalogTracked().then((added) => {
    if (added > 0) {
      const after = svc.list();
      console.log(
        "[families:library] catalog loaded. Now " + after.length +
        " family definition(s), " + after.reduce((n, f) => n + f.types.length, 0) +
        " type(s).",
      );
    }
  }).catch((e) => {
    console.warn("[families:library] catalog load failed:", e);
  });

  return svc;
}

/** True after setupFamilies() has run. */
export function isFamilySystemReady(): boolean {
  return installed;
}
