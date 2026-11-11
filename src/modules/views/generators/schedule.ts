/**
 * Schedule view generator — renders a saved schedule as a paper-space table.
 *
 * Thin store shell over the pure layout module (schedule-sheet-layout.ts):
 * resolves the saved definition, runs the schedule engine, then assembles
 * the paper-true table scene. Kept separate so the layout math stays
 * DOM-free and unit-testable (house test pattern).
 */

import type { ViewDef } from "../types";
import type { Scene2D } from "../scene";
import { runSchedule } from "../../schedules/schedule-generator";
import { getSavedSchedule } from "../../schedules/schedule-store";
import {
  emptyScheduleScene,
  buildScheduleSceneFromRun,
} from "../../schedules/schedule-sheet-layout";

/** Full generator: resolve the saved schedule, run it, emit the table scene. */
export async function generateScheduleScene(viewDef: ViewDef): Promise<Scene2D> {
  const id = viewDef.schedule?.scheduleId;
  if (!id) return emptyScheduleScene("Schedule view not configured");
  const stored = getSavedSchedule(id);
  if (!stored) return emptyScheduleScene(`Saved schedule not found (${id})`);
  const run = await runSchedule(stored);
  return buildScheduleSceneFromRun(stored, run);
}
