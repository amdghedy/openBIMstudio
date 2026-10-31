/** Shared types for the P6-driven 4D / 5D / 6D pipeline. Pure data, no DOM. */
export type RelType = "FS" | "SS" | "FF" | "SF";

export interface SchedTask {
  /** Stable id inside the imported schedule (P6 task_code / activity Id). */
  id: string;
  /** Internal key used for relationships (P6 task_id / ObjectId). */
  key: string;
  name: string;
  /** WBS path of short names, e.g. "B1.STR.COL". */
  wbs: string;
  wbsName?: string;
  /** Epoch milliseconds (UTC-naive: the schedule's wall-clock date is stored as if UTC). */
  start: number;
  finish: number;
  /** Planned duration in days (calendar). */
  durationDays: number;
  /** 0..100 physical % complete. */
  percent: number;
  isMilestone: boolean;
  /** Total planned/budgeted cost from P6 resource assignments (0 when absent). */
  plannedCost: number;
  predecessors: Array<{ key: string; type: RelType; lagDays: number }>;
}

export interface ParsedSchedule {
  source: "xer" | "pmxml";
  projectName: string;
  tasks: SchedTask[];
  warnings: string[];
}

export const DAY_MS = 86_400_000;
