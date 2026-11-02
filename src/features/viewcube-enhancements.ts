/**
 * Revit-style ViewCube interaction and appearance preferences.
 *
 * Adds direct pointer-driven orbit to the existing NavigationController.
 * It deliberately reuses the live camera adapter; it does not create a
 * second camera, controls instance, or animation loop.
 */
import type { NavigationController } from "../modules/navigation";

type CubePosition = "top-right" | "top-left" | "bottom-right" | "bottom-left";
interface CubePrefs { scale: number; opacity: number; position: CubePosition; }

const PREF_KEY = "obs.navigation.viewcube.appearance.v1";
const DEFAULT_PREFS: CubePrefs = { scale: 1, opacity: 1, position: "top-right" };

function readPrefs(): CubePrefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const value = JSON.parse(raw) as Partial<CubePrefs>;
    const position = ["top-right", "top-left", "bottom-right", "bottom-left"].includes(String(value.position))
      ? value.position as CubePosition : DEFAULT_PREFS.position;
    return {
      scale: Number.isFinite(value.scale) ? Math.min(1.35, Math.max(0.75, Number(value.scale))) : 1,
      opacity: Number.isFinite(value.opacity) ? Math.min(1, Math.max(0.35, Number(value.opacity))) : 1,
      position,
    };
  } catch { return { ...DEFAULT_PREFS }; }
}

function persist(prefs: CubePrefs): void {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* storage may be disabled */ }
}

function applyPrefs(container: HTMLElement, svg: SVGSVGElement, prefs: CubePrefs): void {
  const inset = "14px";
  container.style.top = prefs.position.startsWith("top") ? inset : "auto";
  container.style.bottom = prefs.position.startsWith("bottom") ? inset : "auto";
  container.style.left = prefs.position.endsWith("left") ? inset : "auto";
  container.style.right = prefs.position.endsWith("right") ? inset : "auto";
  svg.style.transformOrigin = "center center";
  svg.style.transform = `scale(${prefs.scale})`;
  svg.style.opacity = String(prefs.opacity);
  container.dataset.viewcubePosition = prefs.position;
}

function buttonStyle(): string {
  return "border:1px solid #3a4352;border-radius:5px;background:#202938;color:#e2e8f0;" +
    "padding:5px 8px;font:600 11px system-ui;cursor:pointer";
}

/**
 * Wire freehand drag and a compact options panel onto the existing widget.
 * The drag starts only on cube geometry, not on the Home/menu controls.
 */
export function installViewCubeEnhancements(
  container: HTMLDivElement,
  svg: SVGSVGElement,
  controller: NavigationController,
): void {
  let prefs = readPrefs();
  applyPrefs(container, svg, prefs);

  let pointerId: number | null = null;
  let lastX = 0, lastY = 0, downX = 0, downY = 0, moved = false;
  const threshold = 3;
  svg.addEventListener("pointerdown", (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    const target = event.target as Element | null;
    if (!target || !target.closest("polygon,circle")) return;
    pointerId = event.pointerId;
    lastX = downX = event.clientX;
    lastY = downY = event.clientY;
    moved = false;
    try { svg.setPointerCapture(pointerId); } catch { /* browser fallback */ }
  });

  svg.addEventListener("pointermove", (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (!moved && Math.hypot(event.clientX - downX, event.clientY - downY) < threshold) return;
    moved = true;
    event.preventDefault();
    // Direct camera updates (zero-duration) make the cube track the pointer
    // without repeatedly queuing eased transitions.
    controller.rotateByImmediate(-dx * 0.72, dy * 0.72);
  });

  const finishDrag = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    const didMove = moved;
    pointerId = null;
    moved = false;
    try { svg.releasePointerCapture(event.pointerId); } catch { /* */ }
    if (didMove) {
      // Suppress the synthetic click generated at the end of a drag.
      const suppress = (click: Event) => {
        click.preventDefault();
        click.stopImmediatePropagation();
        svg.removeEventListener("click", suppress, true);
      };
      svg.addEventListener("click", suppress, true);
    }
  };
  svg.addEventListener("pointerup", finishDrag);
  svg.addEventListener("pointercancel", finishDrag);
  svg.addEventListener("lostpointercapture", finishDrag as EventListener);

  const tools = document.createElement("div");
  tools.style.cssText = "display:flex;justify-content:flex-end;gap:5px;margin-top:2px;pointer-events:auto";
  const optionsButton = document.createElement("button");
  optionsButton.type = "button";
  optionsButton.textContent = "ViewCube options";
  optionsButton.title = "Configure ViewCube size, opacity and position";
  optionsButton.setAttribute("aria-expanded", "false");
  optionsButton.style.cssText = buttonStyle();
  tools.appendChild(optionsButton);

  const panel = document.createElement("div");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "ViewCube options");
  panel.style.cssText = "position:absolute;right:0;top:100%;margin-top:6px;width:218px;" +
    "padding:11px;display:flex;flex-direction:column;gap:9px;background:rgba(20,24,33,.97);" +
    "border:1px solid #3a4352;border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.42);" +
    "color:#e2e8f0;font:11px system-ui;pointer-events:auto;z-index:5";
  const addRange = (labelText: string, min: number, max: number, step: number, value: number,
    onInput: (value: number) => void) => {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
    const caption = document.createElement("span");
    caption.textContent = labelText;
    const input = document.createElement("input");
    input.type = "range"; input.min = String(min); input.max = String(max);
    input.step = String(step); input.value = String(value);
    input.addEventListener("input", () => onInput(Number(input.value)));
    wrap.append(caption, input); panel.appendChild(wrap);
  };
  const addSelect = (labelText: string, values: Array<[string, string]>, selected: string,
    onChange: (value: string) => void) => {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
    const caption = document.createElement("span"); caption.textContent = labelText;
    const select = document.createElement("select");
    select.style.cssText = "background:#111827;color:#e2e8f0;border:1px solid #3a4352;border-radius:4px;padding:5px";
    for (const [value, text] of values) {
      const option = document.createElement("option"); option.value = value;
      option.textContent = text; select.appendChild(option);
    }
    select.value = selected;
    select.addEventListener("change", () => onChange(select.value));
    wrap.append(caption, select); panel.appendChild(wrap);
  };

  addRange("Cube size", 0.75, 1.35, 0.05, prefs.scale, value => {
    prefs.scale = value; applyPrefs(container, svg, prefs); persist(prefs);
  });
  addRange("Widget opacity", 0.35, 1, 0.05, prefs.opacity, value => {
    prefs.opacity = value; applyPrefs(container, svg, prefs); persist(prefs);
  });
  addSelect("Screen position", [
    ["top-right", "Top right"], ["top-left", "Top left"],
    ["bottom-right", "Bottom right"], ["bottom-left", "Bottom left"],
  ], prefs.position, value => {
    prefs.position = value as CubePosition; applyPrefs(container, svg, prefs); persist(prefs);
    panel.style.right = prefs.position.endsWith("right") ? "0" : "auto";
    panel.style.left = prefs.position.endsWith("left") ? "0" : "auto";
    panel.style.top = prefs.position.startsWith("top") ? "100%" : "auto";
    panel.style.bottom = prefs.position.startsWith("bottom") ? "100%" : "auto";
  });
  const reset = document.createElement("button");
  reset.type = "button"; reset.textContent = "Restore defaults";
  reset.style.cssText = buttonStyle();
  reset.addEventListener("click", () => {
    prefs = { ...DEFAULT_PREFS }; persist(prefs); applyPrefs(container, svg, prefs);
    panel.querySelectorAll("input").forEach((input, index) => {
      (input as HTMLInputElement).value = String(index === 0 ? prefs.scale : prefs.opacity);
    });
    const select = panel.querySelector("select") as HTMLSelectElement | null;
    if (select) select.value = prefs.position;
  });
  panel.appendChild(reset);
  optionsButton.addEventListener("click", event => {
    event.stopPropagation();
    panel.hidden = !panel.hidden;
    optionsButton.setAttribute("aria-expanded", String(!panel.hidden));
  });
  panel.addEventListener("pointerdown", event => event.stopPropagation());
  tools.appendChild(panel);
  container.appendChild(tools);
}
