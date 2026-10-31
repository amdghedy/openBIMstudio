/** Shared interactive modify command types — Revit-parity state machine. */

export type ModifyState =
  | "idle"
  | "awaiting-selection"
  | "ready"
  | "previewing"
  | "awaiting-input"
  | "committed"
  | "cancelled";

export type ModifyToolId =
  | "move"
  | "copy"
  | "rotate"
  | "mirror"
  | "array"
  | "offset"
  | "align"
  | "scale"
  | "trim"
  | "extend"
  | "split";

export interface PlanPoint {
  x: number;
  z: number;
  y?: number;
}

export interface PreviewGhost {
  sourceId: string;
  dx: number;
  dz: number;
  dy?: number;
  rot?: number;
  pivot?: PlanPoint;
  isCopy?: boolean;
}

export interface PreviewFrame {
  ghosts: PreviewGhost[];
  rubberFrom?: PlanPoint;
  rubberTo?: PlanPoint;
  tempDims?: Array<{ from: PlanPoint; to: PlanPoint; label: string }>;
  cursorLabel?: string;
  snapGlyph?: PlanPoint & { kind: string };
}

export interface ModifyStatus {
  state: ModifyState;
  tool: ModifyToolId | null;
  prompt: string;
  selectionCount: number;
}

export interface PointerSample {
  world: PlanPoint;
  screenX: number;
  screenY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  button: number;
}

export interface InteractiveCommand {
  readonly id: ModifyToolId;
  readonly displayName: string;
  readonly staysActiveAfterCommit: boolean;
  canStart(selectionIds: string[]): { can: boolean; reason?: string };
  start(selectionIds: string[]): void;
  onPointerMove(p: PointerSample): PreviewFrame | null;
  onClick(p: PointerSample): "continue" | "commit" | "cancel" | "need-selection";
  onKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; code: string }): "handled" | "ignore" | "cancel" | "commit";
  commit(): { label: string; apply: () => void; revert: () => void } | null;
  cancel(): void;
  getStatus(): ModifyStatus;
  getSelectionIds(): string[];
}
