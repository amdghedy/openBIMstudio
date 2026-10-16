/**
 * Interactive annotation tools.
 *
 * A tiny state machine that the views panel drives with clicks:
 *
 *   select         -> no-op (used for selection in a future pass)
 *   dim-aligned    -> pick ref1, pick ref2, create aligned dimension
 *   dim-linear     -> pick ref1, pick ref2, create linear dimension
 *   tag-category   -> pick ref, create category tag
 *
 * Click coordinates arrive in the view's own 2D plane (which for plan and
 * section views is world (x, z)). The tool returns a result describing what
 * was created or what feedback the UI should show.
 */

import { getElements } from "../../features/authoring";
import { pickReference } from "./hit-test";
import { addDimension, addTag, DEFAULT_DIM_STYLES } from "./annotations";
import { createView, updateView } from "./store";
import type { Dimension, Tag } from "./annotations";
import type { Reference } from "./references";

export type ActiveTool = "select" | "dim-aligned" | "dim-linear" | "tag-category" | "section-line";

export interface ToolClickResult {
  newSectionViewId?: string;
  created?: Dimension | Tag;
  feedback?: string;
}

class ToolStateImpl {
  active: ActiveTool = "select";
  pendingRef: Reference | null = null;
  pendingPoint: [number, number] | null = null;

  setTool(t: ActiveTool): void {
    this.active = t;
    this.pendingRef = null;
  }

  cancel(): void {
    this.pendingRef = null;
  }

  getHint(): string {
    switch (this.active) {
      case "select":
        return "Select mode â€” click a row on the left to switch view.";
      case "dim-aligned":
      case "dim-linear":
        return this.pendingRef
          ? "Pick second reference (endpoint / center / face)."
          : "Pick first reference (endpoint / center / face).";
      case "tag-category":
        return "Pick an element to tag.";
      case "section-line":
        return this.pendingPoint
          ? "Click second point of section cut line."
          : "Click first point of section cut line.";
      default:
        return "Ready.";
    }
  }

  click(
    worldX: number,
    worldZ: number,
    viewId: string,
    _viewScale: number,
    toleranceWorld: number,
    viewKind: string,
  ): ToolClickResult {
    if (viewKind !== "plan" && viewKind !== "rcp") {
      return { feedback: "Dimensions and tags are enabled in plan views only." };
    }
    if (this.active === "select") {
      return { feedback: this.getHint() };
    }

    const elements = getElements();
    const ref = pickReference(elements, worldX, worldZ, { tolerance: toleranceWorld });
    if (!ref) {
      return { feedback: "No reference nearby â€” click closer to an element." };
    }

    if (this.active === "section-line") {
      if (viewKind !== "plan" && viewKind !== "rcp") {
        return { feedback: "Switch to a plan view first, then draw the section line." };
      }
      if (!this.pendingPoint) {
        this.pendingPoint = [worldX, worldZ];
        return { feedback: "Click second point of section cut line." };
      }
      const [x1, z1] = this.pendingPoint;
      const x2 = worldX;
      const z2 = worldZ;
      if (Math.hypot(x2 - x1, z2 - z1) < 0.5) {
        return { feedback: "Section line is too short - click further away." };
      }
      const v = createView("section", "Section " + new Date().toLocaleTimeString());
      if (v.section) {
        v.section.cutLine = { x1, z1, x2, z2 };
      }
      updateView(v.id, { section: v.section });
      this.pendingPoint = null;
      return {
        newSectionViewId: v.id,
        feedback: "Section created - opening view.",
      };
    }
    if (this.active === "tag-category") {
      const tag: Tag = {
        id: `tag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        viewId,
        ref,
        kind: "category",
        offsetMm: [150, 150],
        leader: true,
        leaderShape: "straight",
        rotation: 0,
        createdAt: Date.now(),
      };
      addTag(tag);
      return { created: tag, feedback: "Tag created." };
    }

    if (this.active === "dim-aligned" || this.active === "dim-linear") {
      if (!this.pendingRef) {
        this.pendingRef = ref;
        return { feedback: this.getHint() };
      }
      const dim: Dimension = {
        id: `dim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        viewId,
        kind: this.active === "dim-linear" ? "linear" : "aligned",
        styleId: DEFAULT_DIM_STYLES[0].id,
        ref1: this.pendingRef,
        ref2: ref,
        offsetMm: 400,
        createdAt: Date.now(),
      };
      addDimension(dim);
      this.pendingRef = null;
      return { created: dim, feedback: "Dimension created." };
    }

    return { feedback: "Unsupported tool." };
  }
}

export const toolState = new ToolStateImpl();