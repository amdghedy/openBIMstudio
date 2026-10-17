/**
 * Parametric families boot - upgrades the live FamilyService to the full
 * parametric engine and seeds a sample BIM-style parametric door.
 *
 * Safe to call after setupFamilies() (main.ts already does that).
 * Idempotent.
 */

import { ctx } from "../../core/context";
import { familyStore } from "./store";
import { createParametricFamilyService } from "./registry-parametric";
import { createParametricDoorFamily } from "./sample-parametric-door";
import { PARAMETRIC_DOOR_CONSTRAINTS } from "./sample-parametric-door";
import { register } from "../../core/services";

type Any = Record<string, any>;

let upgraded = false;

export function setupParametricFamilies(): void {
  if (upgraded) return;
  upgraded = true;

  try {
    // Ensure store is booted (no-op if main already called setupFamilies)
    try {
      if (!(familyStore as Any).booted && typeof (familyStore as Any).boot === "function") {
        (familyStore as Any).boot([]);
      }
    } catch { /* */ }

    const svc = createParametricFamilyService();

    // Seed parametric door if missing
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
    if (doorId) {
      svc.setConstraints(doorId, PARAMETRIC_DOOR_CONSTRAINTS);
    }

    register("family", svc);
    (ctx.features as Any).family = svc;
    (window as Any).__obsFamily = svc;
    (window as Any).__obsFamilyParametric = svc;

    const list = svc.list();
    console.log(
      `[parametric-families] upgraded service - ${list.length} families, parametric build active`,
    );
  } catch (e) {
    console.warn("[parametric-families] upgrade failed (base family service remains)", e);
  }
}
