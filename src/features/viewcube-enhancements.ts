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
  svg.style.width = `${140 * prefs.scale}px`;
  svg.style.height = `${140 * prefs.scale}px`;
  svg.style.transform = "none";
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
  let captureTarget: SVGElement | null = null;
  let lastX = 0, lastY = 0, downX = 0, downY = 0, moved = false;
  const threshold = 3;
  svg.addEventListener("pointerdown", (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    const target = event.target as Element | null;
    const hitTarget = target?.closest("polygon,circle");
    if (!(hitTarget instanceof SVGElement)) return;
    pointerId = event.pointerId;
    captureTarget = hitTarget;
    lastX = downX = event.clientX;
    lastY = downY = event.clientY;
    moved = false;
    try { hitTarget.setPointerCapture(pointerId); } catch { /* browser fallback */ }
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
    try { captureTarget?.releasePointerCapture(event.pointerId); } catch { /* */ }
    captureTarget = null;
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
  tools.style.cssText = "position:absolute;top:0;right:0;display:flex;justify-content:flex-end;" +
    "gap:5px;pointer-events:none;opacity:0;transition:opacity 120ms ease;z-index:6";
  const optionsButton = document.createElement("button");
  optionsButton.type = "button";
  optionsButton.textContent = "⚙";
  optionsButton.title = "ViewCube options";
  optionsButton.setAttribute("aria-label", "Open ViewCube options");
  optionsButton.setAttribute("aria-expanded", "false");
  optionsButton.style.cssText = buttonStyle() +
    ";width:28px;height:28px;padding:0;font-size:15px;pointer-events:auto";
  tools.appendChild(optionsButton);

  const panel = document.createElement("div");
  panel.hidden = true;
  panel.style.display = "none";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "ViewCube options");
  panel.style.cssText += "position:absolute;right:0;top:100%;margin-top:6px;width:218px;" +
    "padding:11px;display:none;flex-direction:column;gap:9px;background:rgba(20,24,33,.97);" +
    "border:1px solid #3a4352;border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.42);" +
    "color:#e2e8f0;font:11px system-ui;pointer-events:auto;z-index:7";
  const panelHeader = document.createElement("div");
  panelHeader.style.cssText = "display:flex;align-items:center;justify-content:space-between;" +
    "font-weight:700;font-size:12px";
  const panelTitle = document.createElement("span");
  panelTitle.textContent = "ViewCube options";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = "Close ViewCube options";
  closeButton.setAttribute("aria-label", "Close ViewCube options");
  closeButton.style.cssText = buttonStyle() + ";padding:1px 7px;font-size:16px";
  panelHeader.append(panelTitle, closeButton);
  panel.appendChild(panelHeader);

  const setPanelOpen = (open: boolean) => {
    panel.hidden = !open;
    panel.style.display = open ? "flex" : "none";
    optionsButton.setAttribute("aria-expanded", String(open));
    optionsButton.setAttribute("aria-label", open ? "Close ViewCube options" : "Open ViewCube options");
    if (open) closeButton.focus();
  };
  const placePanel = () => {
    const left = prefs.position.endsWith("left");
    const bottom = prefs.position.startsWith("bottom");
    panel.style.right = left ? "auto" : "0";
    panel.style.left = left ? "0" : "auto";
    panel.style.top = bottom ? "auto" : "100%";
    panel.style.bottom = bottom ? "100%" : "auto";
    panel.style.marginTop = bottom ? "0" : "6px";
    panel.style.marginBottom = bottom ? "6px" : "0";
  };

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
    prefs.scale = value; applyPrefs(container, svg, prefs); persist(prefs); placePanel();
  });
  addRange("Widget opacity", 0.35, 1, 0.05, prefs.opacity, value => {
    prefs.opacity = value; applyPrefs(container, svg, prefs); persist(prefs);
  });
  addSelect("Screen position", [
    ["top-right", "Top right"], ["top-left", "Top left"],
    ["bottom-right", "Bottom right"], ["bottom-left", "Bottom left"],
  ], prefs.position, value => {
    prefs.position = value as CubePosition; applyPrefs(container, svg, prefs); persist(prefs);
    placePanel();
  });
  const reset = document.createElement("button");
  reset.type = "button"; reset.textContent = "Restore defaults";
  reset.style.cssText = buttonStyle();
  reset.addEventListener("click", () => {
    prefs = { ...DEFAULT_PREFS }; persist(prefs); applyPrefs(container, svg, prefs); placePanel();
    panel.querySelectorAll("input").forEach((input, index) => {
      (input as HTMLInputElement).value = String(index === 0 ? prefs.scale : prefs.opacity);
    });
    const select = panel.querySelector("select") as HTMLSelectElement | null;
    if (select) select.value = prefs.position;
  });
  panel.appendChild(reset);
  optionsButton.addEventListener("click", event => {
    event.stopPropagation();
    setPanelOpen(panel.hidden);
  });
  closeButton.addEventListener("click", () => {
    setPanelOpen(false);
    optionsButton.focus();
  });
  panel.addEventListener("pointerdown", event => event.stopPropagation());
  panel.addEventListener("click", event => event.stopPropagation());
  const revealTools = () => {
    tools.style.opacity = "1";
    tools.style.pointerEvents = "auto";
  };
  const concealTools = () => {
    if (!panel.hidden) return;
    tools.style.opacity = "0";
    tools.style.pointerEvents = "none";
  };
  container.addEventListener("pointerenter", revealTools);
  container.addEventListener("pointerleave", concealTools);
  container.addEventListener("focusin", revealTools);
  container.addEventListener("focusout", event => {
    if (!container.contains(event.relatedTarget as Node | null)) concealTools();
  });
  const closeOnOutside = (event: PointerEvent) => {
    if (!panel.hidden && !container.contains(event.target as Node)) {
      setPanelOpen(false);
      concealTools();
    }
  };
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !panel.hidden) {
      setPanelOpen(false);
      optionsButton.focus();
    }
  };
  document.addEventListener("pointerdown", closeOnOutside);
  container.addEventListener("keydown", closeOnEscape);
  placePanel();
  tools.appendChild(panel);
  container.appendChild(tools);
}
