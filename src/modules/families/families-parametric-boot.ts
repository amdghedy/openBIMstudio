import { ctx } from "../../core/context";
import { familyStore } from "./store";
import { createParametricFamilyService } from "./registry-parametric";
import { createParametricDoorFamily } from "./sample-parametric-door";
import { PARAMETRIC_DOOR_CONSTRAINTS } from "./sample-parametric-door";
import { register } from "../../core/services";
import { sharedParameterManager } from "./shared-parameters";
import { typeCatalogService } from "./type-catalog";
import { familyHostingService } from "./family-hosting";
import { setupFamilyBridge } from "./family-bridge-boot";

type Any = Record<string, any>;

let upgraded = false;

export function setupParametricFamilies(): void {
  if (upgraded) return;
  upgraded = true;

  try {
    try {
      if (!(familyStore as Any).booted && typeof (familyStore as Any).boot === "function") {
        (familyStore as Any).boot([]);
      }
    } catch { /* */ }

    const svc = createParametricFamilyService();
    const door = createParametricDoorFamily();
    const existing = familyStore.list().find(
      (f) => f.name === door.name || (f.name.includes("Parametric") && f.category === "door"),
    );
    let doorId = existing?.id ?? null;
    if (!existing) {
      try {
        const { id: _id, schemaVersion: _sv, builtIn: _bi, ...rest } = door as Any;
        const created = familyStore.create(rest as any);
        doorId = created.id;
      } catch (e) {
        console.warn("[parametric-families] seed door skipped", e);
      }
    }
    if (doorId) svc.setConstraints(doorId, PARAMETRIC_DOOR_CONSTRAINTS);

    register("family", svc);
    register("sharedParameters", sharedParameterManager);
    register("typeCatalog", typeCatalogService);
    register("familyHosting", familyHostingService);
    (ctx.features as Any).family = svc;
    (ctx.features as Any).familyHosting = familyHostingService;
    (window as Any).__obsFamily = svc;
    (window as Any).__obsFamilyParametric = svc;

    // Bridge the TS service with the legacy Family Creator
    // (public/js/obs-family-editor.js): editor saves land in this
    // store, and service families appear in the editor's library.
    // A bridge failure must never break the family service boot.
    try {
      setupFamilyBridge();
    } catch (e) {
      console.warn("[parametric-families] family bridge failed to start", e);
    }

    void import("../../features/family-catalog-controls")
      .then((module) => module.setupFamilyCatalogControls())
      .catch((error: unknown) => console.warn("[family-catalog] UI setup failed:", error));

    const list = svc.list();
    console.log(`[parametric-families] upgraded service - ${list.length} families, parametric build active`);
  } catch (e) {
    console.warn("[parametric-families] upgrade failed (base family service remains)", e);
  }
}
