/**
 * Conversion job store for the openBIM NWC bridge.
 *
 * A job owns a workspace folder:
 *   <workspace>/<jobId>/source/<file>.nwc|nwd|nwf   (uploaded bytes)
 *   <workspace>/<jobId>/export/                     (watched for *.ifc output)
 *
 * States:
 *   converting          — headless runner is executing
 *   waiting-for-export  — Navisworks is open with the model; the user (or the
 *                         plug-in) still has to write the IFC into export/
 *   done                — at least one stable IFC was collected
 *   error               — a failure message is attached
 *   expired             — TTL reached without output (workspace removed)
 *
 * The store keeps IO injectable (readdir/stat) so tests run the real state
 * machine against a fake export folder.
 */
import { describeJobState } from "./http-utils.mjs";

export const JOB_TTL_MS_DEFAULT = 30 * 60 * 1000; // 30 minutes

/**
 * Scan a folder for IFC output. `fsApi` = {readdir, stat, join(dir,name)}.
 * join is injected so the scan is platform-correct (path.join on the host).
 */
export function scanExportFolder(exportDir, fsApi, previous) {
  const prev = previous || new Map(); // name -> sizeBytes seen last sweep
  const join = fsApi.join || ((dir, name) => `${dir}\\${name}`);
  const out = [];
  let entries = [];
  try { entries = fsApi.readdir(exportDir) || []; } catch { return { files: [], stable: prev }; }
  const stable = new Map();
  for (const entry of entries) {
    if (!/\.ifc$/i.test(String(entry))) continue;
    const full = join(exportDir, entry);
    let size = 0;
    try { size = fsApi.stat(full).size; } catch { continue; }
    stable.set(entry, size);
    const lastSize = prev.get(entry);
    out.push({ name: entry, sizeBytes: size, stable: lastSize === size && size > 0 });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { files: out, stable };
}

/** Create a job store. `now` is injectable for TTL tests. */
export function createJobStore({ ttlMs = JOB_TTL_MS_DEFAULT, now = () => Date.now() } = {}) {
  const jobs = new Map();

  function create({ id, sourceName, sourceBytes, mode, sourceDir, exportDir }) {
    const job = {
      id,
      sourceName,
      mode, // "headless" | "guided"
      state: mode === "headless" ? "converting" : "waiting-for-export",
      message: null,
      error: null,
      sourceDir,
      exportDir,
      sourceBytes,
      ifcFiles: [],
      createdAt: now(),
      updatedAt: now(),
      _exportSeen: new Map(),
    };
    jobs.set(id, job);
    return job;
  }

  function get(id) {
    return jobs.get(String(id || "")) || null;
  }

  function touch(job, patch = {}) {
    job.updatedAt = now();
    for (const [k, v] of Object.entries(patch)) {
      if (k.startsWith("_")) continue;
      job[k] = v;
    }
    return job;
  }

  /** Public JSON view of a job (never exposes absolute paths except exportDir, which the user needs). */
  function view(job) {
    return {
      jobId: job.id,
      mode: job.mode,
      state: job.state,
      message: describeJobState(job.state, job.message),
      error: job.error || null,
      exportDir: job.exportDir,
      sourceName: job.sourceName,
      ifcFiles: job.ifcFiles.map((f) => ({ name: f.name, sizeBytes: f.sizeBytes, url: `/openbim-bridge/jobs/${job.id}/ifc/${encodeURIComponent(f.name)}` })),
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
    };
  }

  /** Expire jobs past the TTL that have not finished; returns expired ids. */
  function sweep() {
    const expired = [];
    const t = now();
    for (const job of jobs.values()) {
      if (job.state === "done" || job.state === "error" || job.state === "expired") continue;
      if (t - job.updatedAt > ttlMs) {
        job.state = "expired";
        job.message = "Job expired before an IFC was produced.";
        job.updatedAt = t;
        expired.push(job.id);
      }
    }
    return expired;
  }

  function remove(id) {
    return jobs.delete(String(id || ""));
  }

  return { create, get, touch, view, sweep, remove, _jobs: jobs };
}

/** Flatten a stable-IFC scan result into the job record's ifcFiles list. */
export function collectStableIfc(scanResult) {
  return (scanResult.files || []).filter((f) => f.stable);
}
