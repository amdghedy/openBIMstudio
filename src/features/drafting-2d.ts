import { ctx } from "../core/context";

type Any = Record<string, any>;

type Pt = { x: number; y: number };

type Tool = "line" | "rect" | "circle" | "text" | null;

type EntityKind = "line" | "rect" | "circle" | "text";

export interface DraftEntity {
  id: string;
  kind: EntityKind;
  a: Pt;
  b?: Pt;
  r?: number;
  text?: string;
  color: string;
  strokeWidth: number;
}

const UI_SELECTOR =
  '.obs-adv-toolbar, button, input, select, textarea, [contenteditable="true"], .obs-ribbon, .obs-panel, .obs-property, .obs-dialog';

class Drafting2DLayer {
  private mounted = false;
  private host: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private layer: SVGGElement | null = null;
  private preview: SVGGElement | null = null;

  private entities: DraftEntity[] = [];
  private redoStack: DraftEntity[] = [];

  private tool: Tool = null;
  private start: Pt | null = null;
  private current: Pt | null = null;
  private dragging = false;
  private pointerId: number | null = null;

  mount(): void {
    if (this.mounted) {
      return;
    }

    this.mounted = true;

    const c = ctx as Any;

    this.host =
      (c.rightHost as HTMLElement) ||
      document.getElementById("viewport") ||
      (document.querySelector(".obs-viewport") as HTMLElement | null) ||
      document.body;

    if (!this.host) {
      return;
    }

    const hostStyle = getComputedStyle(this.host);

    if (hostStyle.position === "static") {
      this.host.style.position = "relative";
    }

    const ns = "http://www.w3.org/2000/svg";

    this.svg = document.createElementNS(ns, "svg") as SVGSVGElement;
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");

    this.svg.style.cssText =
      "position:absolute;left:0;top:0;right:0;bottom:0;" +
      "pointer-events:none;z-index:9999;";

    this.layer = document.createElementNS(ns, "g") as SVGGElement;
    this.preview = document.createElementNS(ns, "g") as SVGGElement;

    this.svg.appendChild(this.layer);
    this.svg.appendChild(this.preview);
    this.host.appendChild(this.svg);

    window.addEventListener("pointerdown", this.onDown, true);
    window.addEventListener("pointermove", this.onMove, true);
    window.addEventListener("pointerup", this.onUp, true);
    window.addEventListener("pointercancel", this.onCancel, true);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("contextmenu", this.onContextMenu, true);
  }

  setTool(tool: Tool): void {
    this.cancelDrag();
    this.tool = tool;

    if (this.host) {
      this.host.style.cursor = tool ? "crosshair" : "";
    }

    this.emitToolChanged();
  }

  getTool(): Tool {
    return this.tool;
  }

  getEntities(): DraftEntity[] {
    return this.entities.map((e) => ({ ...e }));
  }

  loadEntities(list: DraftEntity[]): void {
    this.entities = Array.isArray(list) ? list.map((e) => ({ ...e })) : [];
    this.redoStack = [];
    this.render();
  }

  clear(): void {
    this.entities = [];
    this.redoStack = [];
    this.render();
  }

  undo(): boolean {
    const last = this.entities.pop();

    if (!last) {
      return false;
    }

    this.redoStack.push(last);
    this.render();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();

    if (!next) {
      return false;
    }

    this.entities.push(next);
    this.render();
    return true;
  }

  getCount(): number {
    return this.entities.length;
  }

  exportSVG(): string {
    return this.svg ? new XMLSerializer().serializeToString(this.svg) : "";
  }

  private emitToolChanged(): void {
    try {
      window.dispatchEvent(
        new CustomEvent("obs:draft-tool-changed", {
          detail: { tool: this.tool },
        }),
      );
    } catch {
      // ignore
    }
  }

  private isDraftTarget(target: EventTarget | null): boolean {
    if (!this.host || !(target instanceof Node)) {
      return false;
    }

    if (!this.host.contains(target)) {
      return false;
    }

    const el = target as Any;

    if (typeof el.closest === "function" && el.closest(UI_SELECTOR)) {
      return false;
    }

    return true;
  }

  private pointFromEvent(e: PointerEvent): Pt {
    if (!this.host) {
      return { x: 0, y: 0 };
    }

    const rect = this.host.getBoundingClientRect();

    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  private cancelDrag(): void {
    this.dragging = false;
    this.start = null;
    this.current = null;
    this.pointerId = null;
    this.clearPreview();
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.tool || e.button !== 0) {
      return;
    }

    if (!this.isDraftTarget(e.target)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    this.dragging = true;
    this.pointerId = e.pointerId;
    this.start = this.pointFromEvent(e);
    this.current = this.start;

    try {
      const target = e.target as Any;
      target.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    this.drawPreview();
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging || this.pointerId !== e.pointerId) {
      return;
    }

    if (this.tool) {
      e.preventDefault();
      e.stopPropagation();
    }

    this.current = this.pointFromEvent(e);
    this.drawPreview();
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.dragging || e.button !== 0 || this.pointerId !== e.pointerId) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    try {
      const target = e.target as Any;
      target.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    const a = this.start;
    const b = this.current;

    this.cancelDrag();

    if (!a || !b) {
      return;
    }

    if (this.tool === "text") {
      const text = window.prompt("Draft text:");

      if (text) {
        this.add({ kind: "text", a, text });
      }

      return;
    }

    if (this.tool === "line") {
      if (Math.hypot(b.x - a.x, b.y - a.y) > 2) {
        this.add({ kind: "line", a, b });
      }

      return;
    }

    if (this.tool === "rect") {
      if (Math.abs(b.x - a.x) > 2 && Math.abs(b.y - a.y) > 2) {
        this.add({ kind: "rect", a, b });
      }

      return;
    }

    if (this.tool === "circle") {
      const r = Math.hypot(b.x - a.x, b.y - a.y);

      if (r > 2) {
        this.add({ kind: "circle", a, r });
      }
    }
  };

  private onCancel = (_e: PointerEvent): void => {
    this.cancelDrag();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.tool) {
      return;
    }

    const target = e.target as Any;

    if (
      target &&
      typeof target.closest === "function" &&
      target.closest('input, textarea, select, [contenteditable="true"]')
    ) {
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.setTool(null);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      this.cancelDrag();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.stopPropagation();
      this.undo();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      e.stopPropagation();
      this.redo();
    }
  };

  private onContextMenu = (e: MouseEvent): void => {
    if (!this.tool) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    this.cancelDrag();
  };

  private add(init: Omit<DraftEntity, "id" | "color" | "strokeWidth">): void {
    this.redoStack = [];

    this.entities.push({
      id: `d2d-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      color: "#2563eb",
      strokeWidth: 2,
      ...init,
    });

    this.render();
  }

  private clearPreview(): void {
    if (!this.preview) {
      return;
    }

    while (this.preview.firstChild) {
      this.preview.removeChild(this.preview.firstChild);
    }
  }

  private drawPreview(): void {
    if (!this.preview || !this.start || !this.current || !this.tool) {
      return;
    }

    this.clearPreview();

    const ns = "http://www.w3.org/2000/svg";
    const a = this.start;
    const b = this.current;

    if (this.tool === "line") {
      const el = document.createElementNS(ns, "line") as SVGLineElement;

      el.setAttribute("x1", String(a.x));
      el.setAttribute("y1", String(a.y));
      el.setAttribute("x2", String(b.x));
      el.setAttribute("y2", String(b.y));
      el.setAttribute("stroke", "#2563eb");
      el.setAttribute("stroke-width", "2");
      el.setAttribute("stroke-dasharray", "6 4");

      this.preview.appendChild(el);
    } else if (this.tool === "rect") {
      const el = document.createElementNS(ns, "rect") as SVGRectElement;

      el.setAttribute("x", String(Math.min(a.x, b.x)));
      el.setAttribute("y", String(Math.min(a.y, b.y)));
      el.setAttribute("width", String(Math.abs(b.x - a.x)));
      el.setAttribute("height", String(Math.abs(b.y - a.y)));
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "#2563eb");
      el.setAttribute("stroke-width", "2");
      el.setAttribute("stroke-dasharray", "6 4");

      this.preview.appendChild(el);
    } else if (this.tool === "circle") {
      const el = document.createElementNS(ns, "circle") as SVGCircleElement;

      el.setAttribute("cx", String(a.x));
      el.setAttribute("cy", String(a.y));
      el.setAttribute("r", String(Math.hypot(b.x - a.x, b.y - a.y)));
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "#2563eb");
      el.setAttribute("stroke-width", "2");
      el.setAttribute("stroke-dasharray", "6 4");

      this.preview.appendChild(el);
    }
  }

  private render(): void {
    if (!this.layer) {
      return;
    }

    while (this.layer.firstChild) {
      this.layer.removeChild(this.layer.firstChild);
    }

    const ns = "http://www.w3.org/2000/svg";

    for (const ent of this.entities) {
      if (ent.kind === "line" && ent.b) {
        const el = document.createElementNS(ns, "line") as SVGLineElement;

        el.setAttribute("x1", String(ent.a.x));
        el.setAttribute("y1", String(ent.a.y));
        el.setAttribute("x2", String(ent.b.x));
        el.setAttribute("y2", String(ent.b.y));
        el.setAttribute("stroke", ent.color);
        el.setAttribute("stroke-width", String(ent.strokeWidth));
        el.setAttribute("stroke-linecap", "round");

        this.layer.appendChild(el);
      } else if (ent.kind === "rect" && ent.b) {
        const el = document.createElementNS(ns, "rect") as SVGRectElement;

        el.setAttribute("x", String(Math.min(ent.a.x, ent.b.x)));
        el.setAttribute("y", String(Math.min(ent.a.y, ent.b.y)));
        el.setAttribute("width", String(Math.abs(ent.b.x - ent.a.x)));
        el.setAttribute("height", String(Math.abs(ent.b.y - ent.a.y)));
        el.setAttribute("fill", "none");
        el.setAttribute("stroke", ent.color);
        el.setAttribute("stroke-width", String(ent.strokeWidth));

        this.layer.appendChild(el);
      } else if (ent.kind === "circle") {
        const el = document.createElementNS(ns, "circle") as SVGCircleElement;

        el.setAttribute("cx", String(ent.a.x));
        el.setAttribute("cy", String(ent.a.y));
        el.setAttribute("r", String(ent.r ?? 0));
        el.setAttribute("fill", "none");
        el.setAttribute("stroke", ent.color);
        el.setAttribute("stroke-width", String(ent.strokeWidth));

        this.layer.appendChild(el);
      } else if (ent.kind === "text") {
        const el = document.createElementNS(ns, "text") as SVGTextElement;

        el.setAttribute("x", String(ent.a.x));
        el.setAttribute("y", String(ent.a.y));
        el.setAttribute("fill", ent.color);
        el.setAttribute("font-size", "16");
        el.setAttribute(
          "font-family",
          "Inter, system-ui, -apple-system, Segoe UI, sans-serif",
        );
        el.textContent = ent.text ?? "";

        this.layer.appendChild(el);
      }
    }
  }
}

export const drafting2D = new Drafting2DLayer();

export function setupDrafting2D(): void {
  drafting2D.mount();

  const c = ctx as Any;

  if (!c.features) {
    c.features = {};
  }

  c.features.drafting2D = drafting2D;

  (window as Any).__obsDrafting2D = drafting2D;

  console.log(
    "[drafting-2d] ready. Left mouse draws. Middle/wheel/right remain Revit navigation.",
  );
}