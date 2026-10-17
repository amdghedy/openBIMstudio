/** 4D construction simulation types — Navisworks TimeLiner-style. */

export interface Phase {
  id: string;
  name: string;
  /** Sequence order (lower = earlier). */
  order: number;
  /** Optional ISO date string for real calendar simulation. */
  startDate?: string;
  endDate?: string;
  color: string;
  /** Element / fragment IDs belonging to this phase. */
  elementIds: string[];
  /** How elements appear before their phase starts. */
  beforeMode: "hidden" | "ghost" | "visible";
  /** How elements appear after their phase ends. */
  afterMode: "hidden" | "ghost" | "visible" | "complete";
}

export interface TimelineState {
  phases: Phase[];
  /** Current playback position (0 = start, 1 = end). */
  progress: number;
  playing: boolean;
  /** Playback speed (phases per second). */
  speed: number;
}

export const DEFAULT_PHASE_COLORS = [
  "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1",
];
