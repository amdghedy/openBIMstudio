/**
 * Provider registration entry point.
 * Each provider ships two pieces: the method implementation (CdeProvider)
 * and the descriptive metadata (CdeProviderMeta).
 */
import { registerCdeProvider } from "../registry";
import { accProvider } from "./acc";
import { daluxProvider } from "./dalux";
import { sharepointProvider } from "./sharepoint";
import { accMeta, daluxMeta, sharepointMeta } from "./meta";

export { accMeta, daluxMeta, sharepointMeta } from "./meta";

export function registerCdeProviders(): void {
  registerCdeProvider(accProvider, accMeta);
  registerCdeProvider(daluxProvider, daluxMeta);
  registerCdeProvider(sharepointProvider, sharepointMeta);
}