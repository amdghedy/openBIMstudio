/**
 * Boot runner — the single authority for executing named startup steps.
 *
 * `main.ts` previously ran ~90 `step(name, fn)` calls through a local
 * try/catch that only wrote to the console and an error overlay. Those steps
 * were invisible to the Startup-health layer: not tracked, not timed, not
 * retryable, and `bootHealth.finalize()` was claimed by whichever side
 * module happened to finish first — "boot complete" was reported while most
 * of the real chain was still running.
 *
 * This stepper keeps the exact call-site shape (`await step("name", fn)`)
 * but routes every step through the real boot-health implementation:
 *
 *   • tracked + timed in `bootHealth` (visible in the Startup health panel)
 *   • the original runner is registered so failed steps can be retried
 *   • failures reach the UI surface once, with the original error object
 *     (stack preserved via `rawError`, not just the message)
 *   • `finalize()` is owned by the end of the boot chain — one authoritative
 *     "boot finished" event, idempotent, after every step has reported
 */

import { bootHealth, trackedBootStep } from "./boot-health";

export interface BootStepperOptions {
  /**
   * UI surface for a failed step (overlay / toast). Receives a human title
   * and the ORIGINAL thrown value — not a re-wrapped copy.
   */
  onStepError?: (title: string, err: unknown) => void;
  /** Line logger; defaults to console.log (keeps the legacy prefix). */
  log?: (line: string) => void;
}

export interface BootFinalizeInfo {
  /** True when no boot step's latest outcome is a failure. */
  ok: boolean;
  /** Names of steps whose latest outcome failed. */
  failed: string[];
  /** Sum of the latest duration per step, in ms. */
  totalMs: number;
  /** Number of distinct steps recorded. */
  steps: number;
}

export interface BootStepper {
  /**
   * Run one named boot step. Never throws — a failure is recorded in
   * bootHealth, reported to `onStepError`, and resolves to `false`.
   */
  step(name: string, fn: () => unknown | Promise<unknown>): Promise<boolean>;
  /**
   * Mark boot complete. Idempotent: repeated calls while no new step results
   * arrived do not re-emit. Returns the final summary.
   */
  finalize(): BootFinalizeInfo;
}

export function createBootStepper(options: BootStepperOptions = {}): BootStepper {
  const log = options.log ?? ((line: string) => console.log(line));

  function step(name: string, fn: () => unknown | Promise<unknown>): Promise<boolean> {
    // Register the ORIGINAL runner first so the Startup health panel's
    // retry button re-executes the same work.
    trackedBootStep(name, fn);
    const t0 = Date.now();
    return bootHealth
      .runStep(name, fn)
      .then((result) => {
        if (result.ok) {
          log(`[TOC boot] ✓ ${name} (${result.ms}ms${result.retried ? ", retried" : ""})`);
          return true;
        }
        log(`[TOC boot] ✗ ${name} (${Date.now() - t0}ms)`);
        options.onStepError?.(
          `Step failed: ${name} (viewer continues without it)`,
          result.rawError ?? new Error(result.error ?? "boot step failed"),
        );
        return false;
      });
  }

  function finalize(): BootFinalizeInfo {
    const status = bootHealth.finalize();
    return {
      ok: status.ok,
      failed: status.failed,
      totalMs: status.totalMs,
      steps: status.steps.length,
    };
  }

  return { step, finalize };
}
