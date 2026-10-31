// Aggregator for features added after v1.
// Import and call setupExtras() from the app boot file.
import { setupSectionBox } from "./section-box";
import { setupRevisionCloud } from "./revision-cloud";
import { setupDraftingBridge } from "./drafting-bridge";
import { setupMepJointHealer } from "./mep-joint-healer";

let installed = false;

export function setupExtras(): void {
  if (installed) return;
  installed = true;
  setupSectionBox();
  setupRevisionCloud();
  setupDraftingBridge();
  setupMepJointHealer();
  console.log("[extras] all post-v1 features wired");
}