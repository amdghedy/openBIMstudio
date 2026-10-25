/**
 * Interactive modeling state machine (MASTER PROMPT MODULE 2B.1).
 *
 * States: Idle, ToolActivated, Selection, FirstPoint, Endpoint,
 * SnapAcquisition, TempConstraint, PlacementPreview, Validation, Commit,
 * ModificationPreview, Cancelled, Failed.
 *
 * Implements: BeginModelingCommand, UpdatePointerContext,
 * ResolveModelingIntent, UpdateTemporaryConstraints,
 * GeneratePlacementPreview, ValidatePlacementCandidate,
 * CommitModelingCommand, CancelModelingCommand.
 *
 * Invariants (spec 2B.1):
 *   - Transitions are explicit and validated; illegal transitions throw.
 *   - Temporary state (pointer context, acquired snaps, previews) is
 *     cleared on commit, cancel and failure — no preview leaks.
 *   - Validation runs BEFORE commit; a failed validation moves to Failed
 *     with diagnostics, never to Commit.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import {
  acquireSnapCandidate, maintainSnapLock, querySnapCandidates, rankSnapCandidates,
  resolveSnapAmbiguity, releaseSnapCandidate, createTemporarySnapConstraint,
  validateSnapConstraint,
  type RankedCandidate, type SnapCandidateRaw, type SnapIndicator,
  type SnapSettings, type ToolSnapFilter, type TemporarySnapConstraint,
  DEFAULT_SNAP_SETTINGS,
} from "./engine";

export type ModelingStateName =
  | "Idle" | "ToolActivated" | "Selection" | "FirstPoint" | "Endpoint"
  | "SnapAcquisition" | "TempConstraint" | "PlacementPreview" | "Validation"
  | "Commit" | "ModificationPreview" | "Cancelled" | "Failed";

export interface PointerContext {
  screen: { x: number; y: number };
  model: [number, number, number];
  /** Model-space depth of the pointer ray at the work plane. */
  depth: number;
  /** Shift = orthogonal lock, per spec "keyboard modifiers". */
  orthoLock: boolean;
  /** Raw candidates from the view layer for this frame. */
  candidates: SnapCandidateRaw[];
}

export interface PlacementPreviewData {
  /** Preview geometry payload — tool-specific (e.g. wall start/end). */
  points: Array<[number, number, number]>;
  /** Snaps that are currently constraining the preview. */
  snaps: Array<{ kind: string; elementId: string; position: [number, number, number] }>;
  /** Orthogonal override active on the preview. */
  ortho: boolean;
}

export interface PlacementDiagnostic {
  ok: boolean;
  code?: string;
  message?: string;
}

/** A modeling tool supplies intent-specific behaviour to the machine. */
export interface ModelingTool {
  name: string;
  /** Does the tool accept this snap kind? */
  accepts: Set<string>;
  /** Resolve the user's pointer into tool points (snaps applied here). */
  resolveIntent: (
    session: ModelingSession,
    pointer: PointerContext,
  ) => { points: Array<[number, number, number]>; tempConstraints: TemporarySnapConstraint[] };
  /** Validate a candidate placement before commit. */
  validate: (session: ModelingSession) => PlacementDiagnostic;
  /** Commit hook: the caller performs the transaction; return success. */
  commit: (session: ModelingSession) => boolean;
}

/** Allowed transitions (spec 2B.1 table). */
const TRANSITIONS: Record<ModelingStateName, ModelingStateName[]> = {
  Idle: ["ToolActivated"],
  ToolActivated: ["FirstPoint", "Selection", "Cancelled"],
  Selection: ["ModificationPreview", "ToolActivated", "Cancelled", "Commit"],
  FirstPoint: ["Endpoint", "SnapAcquisition", "PlacementPreview", "TempConstraint", "Cancelled"],
  Endpoint: ["PlacementPreview", "SnapAcquisition", "TempConstraint", "Commit", "Cancelled", "FirstPoint"],
  SnapAcquisition: ["FirstPoint", "Endpoint", "TempConstraint", "PlacementPreview", "Cancelled"],
  TempConstraint: ["Endpoint", "PlacementPreview", "Cancelled"],
  PlacementPreview: ["Validation", "Endpoint", "Cancelled"],
  Validation: ["Commit", "PlacementPreview", "Failed", "Cancelled"],
  Commit: ["Idle"],
  ModificationPreview: ["Commit", "Validation", "Selection", "Cancelled"],
  Cancelled: ["Idle"],
  Failed: ["Idle", "ToolActivated", "Cancelled"],
};

export class ModelingTransitionError extends Error {}

export class ModelingSession {
  state: ModelingStateName = "Idle";
  tool: ModelingTool | null = null;
  settings: SnapSettings = DEFAULT_SNAP_SETTINGS;
  filter: ToolSnapFilter = {};

  /** Tool points committed so far (first point, etc.). */
  points: Array<[number, number, number]> = [];
  locked: RankedCandidate | null = null;
  indicator: SnapIndicator | null = null;
  tempConstraints: TemporarySnapConstraint[] = [];
  preview: PlacementPreviewData | null = null;
  lastDiagnostics: PlacementDiagnostic | null = null;
  history: ModelingStateName[] = ["Idle"];

  private transitions = TRANSITIONS;

  private go(next: ModelingStateName): void {
    if (!this.transitions[this.state].includes(next)) {
      throw new ModelingTransitionError(`illegal transition ${this.state} → ${next}`);
    }
    this.state = next;
    this.history.push(next);
  }

  private clearTemp(): void {
    this.points = [];
    const r = releaseSnapCandidate();
    this.locked = r.locked;
    this.indicator = r.indicator;
    this.tempConstraints = [];
    this.preview = null;
    this.lastDiagnostics = null;
  }

  // ── Spec functions ─────────────────────────────────────────────────────

  /** BeginModelingCommand. */
  beginModelingCommand(tool: ModelingTool, filter: ToolSnapFilter = {}, settings?: Partial<SnapSettings>): void {
    this.tool = tool;
    this.filter = filter;
    if (settings) this.settings = { ...this.settings, ...settings };
    this.clearTemp();
    this.go("ToolActivated");
  }

  /**
   * UpdatePointerContext: snap acquisition + lock maintenance for the
   * current frame. Updates `locked`/`indicator` and returns them.
   */
  updatePointerContext(pointer: PointerContext): { locked: RankedCandidate | null; indicator: SnapIndicator | null } {
    if (this.state === "Idle") return { locked: null, indicator: null };
    const eligible = querySnapCandidates(pointer.candidates, pointer.screen, this.settings, this.filter)
      .filter((raw) => raw.kind === "nearest" || this.tool?.accepts.has(raw.kind) !== false);
    const ranked = rankSnapCandidates(eligible, pointer.screen, this.settings, pointer.depth);
    const resolved = resolveSnapAmbiguity(ranked, this.locked, this.settings);
    if (!resolved) {
      const r = releaseSnapCandidate();
      this.locked = r.locked;
      this.indicator = r.indicator;
      if (this.state === "SnapAcquisition" || this.state === "FirstPoint") this.go("FirstPoint");
      return { locked: null, indicator: null };
    }
    const acquired = acquireSnapCandidate(resolved);
    if (
      this.locked &&
      this.locked.raw.elementId === resolved.raw.elementId &&
      this.locked.kind === resolved.kind
    ) {
      const held = maintainSnapLock(resolved, pointer.screen, this.settings);
      if (held.held) {
        this.indicator = held.indicator;
        if (this.state === "FirstPoint" || this.state === "Endpoint") this.go("SnapAcquisition");
        return { locked: this.locked, indicator: this.indicator };
      }
    }
    this.locked = acquired.locked;
    this.indicator = acquired.indicator;
    if (this.state === "FirstPoint" || this.state === "Endpoint") this.go("SnapAcquisition");
    return { locked: this.locked, indicator: this.indicator };
  }

  /**
   * ResolveModelingIntent: the tool turns the pointer (with active snaps)
   * into tool points; temporary constraints are captured here.
   */
  resolveModelingIntent(pointer: PointerContext): PlacementPreviewData {
    if (!this.tool) throw new ModelingTransitionError("no active tool");
    const intent = this.tool.resolveIntent(this, pointer);
    this.points = intent.points;
    this.tempConstraints = intent.tempConstraints;
    if (this.tempConstraints.length && (this.state === "SnapAcquisition" || this.state === "Endpoint" || this.state === "FirstPoint")) {
      this.go("TempConstraint");
    }
    return this.generatePlacementPreview(pointer);
  }

  /** UpdateTemporaryConstraints: revalidate held snaps, drop stale ones. */
  updateTemporaryConstraints(pointer: PointerContext): TemporarySnapConstraint[] {
    this.tempConstraints = this.tempConstraints.filter((c) => validateSnapConstraint(c, pointer.candidates).valid);
    return this.tempConstraints;
  }

  /** GeneratePlacementPreview (called by resolveModelingIntent, re-callable). */
  generatePlacementPreview(pointer: PointerContext): PlacementPreviewData {
    if (!this.tool) throw new ModelingTransitionError("no active tool");
    const snaps = this.tempConstraints.map((c) => ({ kind: c.kind, elementId: c.elementId, position: c.position }));
    const preview: PlacementPreviewData = {
      points: this.points,
      snaps,
      ortho: pointer.orthoLock,
    };
    this.preview = preview;
    if (this.points.length <= 1) {
      if (this.state !== "FirstPoint") this.go("FirstPoint");
    } else if (this.state !== "Endpoint" && this.state !== "TempConstraint") {
      this.go("Endpoint");
    }
    if (this.state !== "PlacementPreview") this.go("PlacementPreview");
    return preview;
  }

  /** ValidatePlacementCandidate. */
  validatePlacementCandidate(): PlacementDiagnostic {
    if (!this.tool || !this.preview) {
      this.lastDiagnostics = { ok: false, code: "no-preview", message: "no placement preview to validate" };
      return this.lastDiagnostics;
    }
    if (this.state !== "Validation") this.go("Validation");
    const d = this.tool.validate(this);
    this.lastDiagnostics = d;
    return d;
  }

  /** CommitModelingCommand: validate → commit → cleanup. */
  commitModelingCommand(): PlacementDiagnostic {
    if (this.state === "Idle" || !this.tool) {
      throw new ModelingTransitionError("commit without an active tool");
    }
    const v = this.validatePlacementCandidate();
    if (!v.ok) {
      this.state = "Failed";
      this.history.push("Failed");
      return v;
    }
    if (!this.tool) throw new ModelingTransitionError("no active tool");
    const ok = this.tool.commit(this);
    if (!ok) {
      this.state = "Failed";
      this.history.push("Failed");
      return { ok: false, code: "commit-rejected", message: "tool commit returned failure" };
    }
    this.clearTemp();
    this.go("Commit");
    this.go("Idle");
    this.tool = null;
    return { ok: true };
  }

  /** CancelModelingCommand: reachable from any active state. */
  cancelModelingCommand(): void {
    if (this.state === "Idle") return;
    this.clearTemp();
    this.go("Cancelled");
    this.tool = null;
    this.go("Idle");
  }
}
