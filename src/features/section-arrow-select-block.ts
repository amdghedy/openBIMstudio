/**
 * While section cut arrow is hovered/dragged, suppress click-to-select
 * and LMB window/crossing select.
 */
import { ctx } from "../core/context";
import { whenNavigationBlocked } from "./navigation";

type Any = Record<string, any>;

let installed = false;

function locked(): boolean {
  return !!(window as Any).__OBS_SECTION_ARROW_LOCK || !!(window as Any).__OBS_SECTION_ARROW_HOVER;
}

export function setupSectionArrowSelectBlock(): void {
  if (installed) return;
  installed = true;

  try {
    whenNavigationBlocked(() => locked());
  } catch {
    /* */
  }

  // Capture on viewport: kill LMB select / box-select while locked
  const host = () => (ctx as Any).rightHost as HTMLElement | undefined;

  const stopIfLocked = (e: Event) => {
    if (!locked()) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  const attach = () => {
    const h = host();
    if (!h) {
      window.setTimeout(attach, 500);
      return;
    }
    // Bubble-block: selection often listens on host
    h.addEventListener("click", stopIfLocked, true);
    h.addEventListener("dblclick", (e) => {
      // Allow section dblclick only when section enabled AND not on arrow
      if (locked()) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
  };
  attach();

  console.log("[section-arrow-select-block] select/window-select blocked while arrow active");
}
