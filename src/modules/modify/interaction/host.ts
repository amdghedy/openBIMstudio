/**
 * CommandHost — single orchestrator for all interactive modify tools.
 * Owns PreviewLayer, status bus, Esc semantics, and commit → history.
 */
import type { InteractiveCommand, ModifyStatus, ModifyToolId, PointerSample, PreviewFrame } from "./types";
import { PreviewLayer } from "./preview-layer";
import { MoveCommand, type MoveHostApi } from "./commands/move";
import * as THREE from "three";

export type HistoryPush = (cmd: {
  label: string;
  apply: () => void;
  revert: () => void;
}) => void;

export interface CommandHostOptions {
  getScene: () => THREE.Scene | null;
  collectMeshes: (ids: string[]) => Map<string, THREE.Object3D[]>;
  historyPush: HistoryPush;
  onStatus: (status: ModifyStatus) => void;
  moveApi: MoveHostApi;
  clearSelection?: () => void;
  getSelection?: () => string[];
}

export class CommandHost {
  private cmd: InteractiveCommand | null = null;
  private preview = new PreviewLayer();
  private opts: CommandHostOptions;
  private raf = 0;
  private lastSample: PointerSample | null = null;
  private escArmed = false;

  constructor(opts: CommandHostOptions) {
    this.opts = opts;
  }

  get activeTool(): ModifyToolId | null {
    return this.cmd?.id ?? null;
  }

  isActive(): boolean {
    return this.cmd !== null;
  }

  startMove(selectionIds: string[], mode: "move" | "copy" = "move"): boolean {
    const move = new MoveCommand(this.opts.moveApi, mode);
    const gate = move.canStart(selectionIds);
    if (!gate.can) {
      this.opts.onStatus({
        state: "idle",
        tool: null,
        prompt: gate.reason ?? "Cannot start Move.",
        selectionCount: selectionIds.length,
      });
      return false;
    }
    this.cmd = move;
    move.start(selectionIds);
    this.escArmed = false;
    this.attachPreview();
    this.emitStatus();
    return true;
  }

  startCommand(cmd: InteractiveCommand, selectionIds: string[]): boolean {
    const gate = cmd.canStart(selectionIds);
    if (!gate.can) return false;
    this.cmd = cmd;
    cmd.start(selectionIds);
    this.escArmed = false;
    this.attachPreview();
    this.emitStatus();
    return true;
  }

  stop(): void {
    if (this.cmd) this.cmd.cancel();
    this.cmd = null;
    this.preview.clear();
    this.preview.detach();
    this.escArmed = false;
    this.emitStatus();
  }

  onSelectionChanged(ids: string[]): void {
    if (!this.cmd) return;
    const any = this.cmd as any;
    if (typeof any.setSelection === "function") any.setSelection(ids);
    this.emitStatus();
  }

  onPointerMove(sample: PointerSample): void {
    if (!this.cmd) return;
    this.lastSample = sample;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.cmd || !this.lastSample) return;
      const frame = this.cmd.onPointerMove(this.lastSample);
      this.renderPreview(frame);
      this.emitStatus();
    });
  }

  onClick(sample: PointerSample): void {
    if (!this.cmd) return;
    this.escArmed = false;
    const result = this.cmd.onClick(sample);
    if (result === "need-selection") {
      this.emitStatus();
      return;
    }
    if (result === "commit") {
      this.doCommit();
      return;
    }
    if (result === "cancel") {
      this.cmd.cancel();
      this.preview.clear();
      this.emitStatus();
      return;
    }
    const frame = this.cmd.onPointerMove(sample);
    this.renderPreview(frame);
    this.emitStatus();
  }

  onEscape(): boolean {
    if (!this.cmd) return false;
    const st = this.cmd.getStatus().state;
    if (st === "previewing" || st === "awaiting-input") {
      this.cmd.cancel();
      this.preview.clear();
      this.escArmed = true;
      this.emitStatus();
      return true;
    }
    this.stop();
    return true;
  }

  onKey(e: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    code: string;
  }): boolean {
    if (!this.cmd) return false;
    if (e.key === "Escape") return this.onEscape();
    const r = this.cmd.onKey(e);
    if (r === "cancel") return this.onEscape();
    if (r === "commit") {
      this.doCommit();
      return true;
    }
    if (r === "handled") {
      if (this.lastSample) {
        const frame = this.cmd.onPointerMove(this.lastSample);
        this.renderPreview(frame);
      }
      this.emitStatus();
      return true;
    }
    return false;
  }

  private doCommit(): void {
    if (!this.cmd) return;
    const tx = this.cmd.commit();
    this.preview.clear();
    if (tx) {
      try {
        this.opts.historyPush(tx);
      } catch (err) {
        console.warn("[modify-host] history push failed", err);
        try { tx.apply(); } catch { /* */ }
      }
    }
    if (!this.cmd.staysActiveAfterCommit) {
      this.stop();
    } else {
      this.emitStatus();
    }
  }

  private attachPreview(): void {
    const scene = this.opts.getScene();
    if (scene) this.preview.attach(scene);
  }

  private renderPreview(frame: PreviewFrame | null): void {
    if (!this.cmd) {
      this.preview.clear();
      return;
    }
    const ids = this.cmd.getSelectionIds();
    const meshes = this.opts.collectMeshes(ids);
    this.preview.show(frame, meshes);
  }

  private emitStatus(): void {
    if (!this.cmd) {
      this.opts.onStatus({
        state: "idle",
        tool: null,
        prompt: "",
        selectionCount: this.opts.getSelection?.().length ?? 0,
      });
      return;
    }
    this.opts.onStatus(this.cmd.getStatus());
  }
}
