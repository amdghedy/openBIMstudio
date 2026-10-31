/**
 * Live Move / Copy command — Revit-parity interaction.
 */
import type {
  InteractiveCommand,
  ModifyStatus,
  ModifyState,
  ModifyToolId,
  PlanPoint,
  PointerSample,
  PreviewFrame,
} from "../types";
import { distPlan, formatDist } from "../preview-layer";

export interface MoveElementRef {
  id: string;
  name: string;
  pinned?: boolean;
}

export interface MoveHostApi {
  getSelection(): string[];
  resolveElements(ids: string[]): MoveElementRef[];
  buildTransaction(
    ids: string[],
    dx: number,
    dz: number,
    mode: "move" | "copy",
  ): { label: string; apply: () => void; revert: () => void } | null;
}

export class MoveCommand implements InteractiveCommand {
  readonly id: ModifyToolId;
  readonly displayName: string;
  readonly staysActiveAfterCommit = true;

  private api: MoveHostApi;
  private mode: "move" | "copy";
  private state: ModifyState = "idle";
  private ids: string[] = [];
  private base: PlanPoint | null = null;
  private current: PlanPoint | null = null;
  private typed = "";
  private lastDx = 0;
  private lastDz = 0;

  constructor(api: MoveHostApi, mode: "move" | "copy" = "move") {
    this.api = api;
    this.mode = mode;
    this.id = mode === "copy" ? "copy" : "move";
    this.displayName = mode === "copy" ? "Copy" : "Move";
  }

  canStart(selectionIds: string[]): { can: boolean; reason?: string } {
    if (!selectionIds.length) return { can: true };
    const els = this.api.resolveElements(selectionIds);
    if (!els.length) return { can: false, reason: "Nothing editable in selection." };
    if (els.every((e) => e.pinned)) return { can: false, reason: "All selected elements are pinned." };
    return { can: true };
  }

  start(selectionIds: string[]): void {
    this.ids = selectionIds.slice();
    this.base = null;
    this.current = null;
    this.typed = "";
    this.lastDx = 0;
    this.lastDz = 0;
    this.state = this.ids.length ? "ready" : "awaiting-selection";
  }

  onPointerMove(p: PointerSample): PreviewFrame | null {
    if (this.state === "awaiting-selection" || this.state === "ready") return null;
    if (this.state !== "previewing" || !this.base) return null;

    let to = { ...p.world };
    if (p.shiftKey) to = orthoFrom(this.base, to);
    if (this.typed) {
      const d = parseFloat(this.typed);
      if (Number.isFinite(d) && d > 0) {
        const dir = direction(this.base, to);
        to = { x: this.base.x + dir.x * d, z: this.base.z + dir.z * d };
      }
    }

    this.current = to;
    const dx = to.x - this.base.x;
    const dz = to.z - this.base.z;
    const copy = this.mode === "copy" || p.ctrlKey;
    this.lastDx = dx;
    this.lastDz = dz;

    const dist = distPlan(this.base, to);
    return {
      ghosts: this.ids.map((id) => ({ sourceId: id, dx, dz, isCopy: copy })),
      rubberFrom: this.base,
      rubberTo: to,
      tempDims: [{ from: this.base, to, label: formatDist(dist) }],
      cursorLabel: `${formatDist(dist)}${copy ? " · COPY" : ""}${p.shiftKey ? " · ORTHO" : ""}`,
    };
  }

  onClick(p: PointerSample): "continue" | "commit" | "cancel" | "need-selection" {
    if (this.state === "awaiting-selection") return "need-selection";

    if (this.state === "ready") {
      this.base = { ...p.world };
      this.state = "previewing";
      this.current = { ...p.world };
      this.typed = "";
      return "continue";
    }

    if (this.state === "previewing" && this.base) {
      this.onPointerMove(p);
      if (Math.abs(this.lastDx) < 1e-9 && Math.abs(this.lastDz) < 1e-9) return "continue";
      if (p.ctrlKey) this.mode = "copy";
      return "commit";
    }

    return "continue";
  }

  onKey(e: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    code: string;
  }): "handled" | "ignore" | "cancel" | "commit" {
    if (e.key === "Escape") return "cancel";

    if (this.state === "previewing") {
      if (/^[0-9.]$/.test(e.key)) {
        if (e.key === "." && this.typed.includes(".")) return "handled";
        this.typed += e.key;
        return "handled";
      }
      if (e.key === "Backspace") {
        this.typed = this.typed.slice(0, -1);
        return "handled";
      }
      if (e.key === "Enter" && this.typed) return "commit";
    }
    return "ignore";
  }

  commit(): { label: string; apply: () => void; revert: () => void } | null {
    if (!this.base || (Math.abs(this.lastDx) < 1e-9 && Math.abs(this.lastDz) < 1e-9)) {
      this.state = "ready";
      this.base = null;
      return null;
    }
    const mode = this.mode;
    const tx = this.api.buildTransaction(this.ids, this.lastDx, this.lastDz, mode);
    this.base = null;
    this.current = null;
    this.typed = "";
    this.lastDx = 0;
    this.lastDz = 0;
    this.state = "ready";
    return tx;
  }

  cancel(): void {
    this.base = null;
    this.current = null;
    this.typed = "";
    this.lastDx = 0;
    this.lastDz = 0;
    this.state = this.ids.length ? "ready" : "awaiting-selection";
  }

  getStatus(): ModifyStatus {
    const n = this.ids.length;
    let prompt = "";
    if (this.state === "awaiting-selection") {
      prompt = `Select element(s) to ${this.displayName.toLowerCase()}.`;
    } else if (this.state === "ready") {
      prompt =
        this.mode === "copy"
          ? "Click to enter the copy start point."
          : "Click to enter the move start point.";
    } else if (this.state === "previewing") {
      const extra = this.typed ? ` · distance ${this.typed}` : "";
      prompt =
        this.mode === "copy"
          ? `Click to enter the copy end point.${extra}`
          : `Click to enter the move end point.${extra}`;
    } else {
      prompt = this.displayName;
    }
    return { state: this.state, tool: this.id, prompt, selectionCount: n };
  }

  getSelectionIds(): string[] {
    return this.ids.slice();
  }

  setSelection(ids: string[]): void {
    this.ids = ids.slice();
    if (this.ids.length && this.state === "awaiting-selection") this.state = "ready";
  }
}

function orthoFrom(base: PlanPoint, to: PlanPoint): PlanPoint {
  const dx = to.x - base.x;
  const dz = to.z - base.z;
  if (Math.abs(dx) >= Math.abs(dz)) return { x: base.x + dx, z: base.z };
  return { x: base.x, z: base.z + dz };
}

function direction(from: PlanPoint, to: PlanPoint): PlanPoint {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}
