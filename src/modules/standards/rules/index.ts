/**
 * Standards rule engine -- public barrel.
 *
 * Importing this module gives you:
 *   * Every built-in RulePack (US / UK / DE / CN fire & accessibility,
 *     plus structural QA and model-quality packs).
 *   * A list of every pack, ready to feed to the runner.
 *   * The registry helpers, re-exported from ./registry.
 *
 * IMPORTANT -- this barrel used to keep its OWN Map<string, RulePack>(),
 * parallel to the one in ./registry.ts. standards-panel.ts populated that
 * private Map while engine.ts read from ./registry's Map, so runRules()
 * always saw zero packs and reported "No rules selected". There is now
 * exactly ONE registry, owned by ./registry.ts and re-exported here.
 *
 * To add your own packs, either edit BUILT_IN_PACKS below or call
 * registerPack() from ./registry at boot.
 */
import type { RulePack } from "../types";
import { registerPack, getPack } from "./registry";
import {
  fireEgressPackUS,
  fireEgressPackUK,
  fireEgressPackDE,
  fireEgressPackCN,
} from "./packs/fire-egress";
import {
  accessibilityPackUS,
  accessibilityPackUK,
  accessibilityPackDE,
  accessibilityPackCN,
} from "./packs/accessibility";
import { structuralPack } from "./packs/structural";
import { qaPack } from "./packs/qa";

/* -------------------------------------------------------------------------
   Built-in packs
   ------------------------------------------------------------------------- */
export const BUILT_IN_PACKS: RulePack[] = [
  fireEgressPackUS,
  fireEgressPackUK,
  fireEgressPackDE,
  fireEgressPackCN,
  accessibilityPackUS,
  accessibilityPackUK,
  accessibilityPackDE,
  accessibilityPackCN,
  structuralPack,
  qaPack,
];

/**
 * Register every built-in pack with the shared registry.
 * Idempotent: already-present packs are skipped silently.
 */
export function registerStandardPacks(): void {
  for (const pack of BUILT_IN_PACKS) {
    if (!getPack(pack.id)) registerPack(pack);
  }
}

/* -------------------------------------------------------------------------
   Re-exports
   ------------------------------------------------------------------------- */
export * from "../types";
export * from "../framework";
export * from "./registry";

export {
  fireEgressPackUS,
  fireEgressPackUK,
  fireEgressPackDE,
  fireEgressPackCN,
} from "./packs/fire-egress";

export {
  accessibilityPackUS,
  accessibilityPackUK,
  accessibilityPackDE,
  accessibilityPackCN,
} from "./packs/accessibility";

export { structuralPack } from "./packs/structural";
export { qaPack } from "./packs/qa";