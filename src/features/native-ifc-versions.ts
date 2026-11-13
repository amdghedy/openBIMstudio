/**
 * Native IFC versions — the “git for BIM” layer for Native Twin authorship.
 *
 * Companion to native-ifc-workflow.ts (make editable → edit → export IFC4).
 * Where the workflow exposes a change *log*, this module adds real versioning:
 *   • commit    — named snapshot of every Native Twin (full lossless payload)
 *   • log       — version list (label, message, twin count, timestamp)
 *   • diff      — structured added / removed / changed report between versions
 *   • restore   — checkout any version (current state auto-stashed first)
 *
 * Storage is localStorage with progressive degradation: on quota pressure the
 * store drops the oldest half, then re-saves older commits without geometry
 * payloads (restore re-derives geometry from the linked model), so the most
 * recent commits always stay lossless.
 *
 * Honest scope: single-branch, local-first versioning for the authoring
 * session — a pragmatic “git for BIM”, not a distributed VCS.
 */

import type { FragEdit } from "./frag-edit";
import { serializeEdits, deserializeEdits } from "./frag-edit";
import { ctx } from "../core/context";
import { confirmDialog, promptLine } from "./form-modal";
import { markDirty } from "../modules/projects/projects";
import { fmtDateTime } from "../core/region";

type Any = Record<string, any>;

const VERSIONS_KEY = "obs.nativeIfc.versions.v1";
/** Hard cap on stored versions (oldest trimmed first). */
const MAX_VERSIONS = 30;
/** Quota fallback: smallest store we still try before giving up. */
const MIN_VERSIONS = 5;

export interface NativeIfcVersion {
  id: string;
  label: string;
  message: string;
  at: number;
  parent: string | null;
  twinCount: number;
  models: string[];
  /** Created automatically (export milestone / pre-restore stash / baseline). */
  auto?: boolean;
  /** Geometry payloads dropped for quota — restore re-derives from the model. */
  slim?: boolean;
  edits: FragEdit[];
}

/** Metadata view without the heavy edits payload (for lists/logs). */
export type NativeIfcVersionMeta = Omit<NativeIfcVersion, "edits">;

export interface TwinDiffRow {
  key: string;
  name: string;
  category: string;
  modelId?: string;
  changes: string[];
  deltaMeters?: number;
}

export interface TwinDiff {
  from: { id: string; label: string; at: number } | null;
  to: { id: string; label: string; at: number } | null;
  added: TwinDiffRow[];
  removed: TwinDiffRow[];
  changed: TwinDiffRow[];
  unchanged: number;
}

/* ── Change recorder hook (avoids an import cycle with native-ifc-workflow) ── */

type ChangeRecorder = (action: "commit" | "restore" | "delete", summary: string, extra?: Any) => void;
let changeRecorder: ChangeRecorder | null = null;

export function setIfcVersionChangeRecorder(fn: ChangeRecorder | null): void {
  changeRecorder = fn;
}

function record(action: "commit" | "restore" | "delete", summary: string, extra?: Any): void {
  try {
    changeRecorder?.(action, summary, extra);
  } catch {
    /* recorder must never break versioning */
  }
}

function toast(msg: string, kind: "success" | "warn" | "error" | "info" = "info"): void {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: msg, kind } }));
  } catch {
    console.log(`[native-ifc-versions] ${kind}: ${msg}`);
  }
}

/* ── Storage ─────────────────────────────────────────────────────────────── */

function loadVersions(): NativeIfcVersion[] {
  try {
    const raw = localStorage.getItem(VERSIONS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as NativeIfcVersion[]) : [];
  } catch {
    return [];
  }
}

function stripGeometry(edits: FragEdit[]): FragEdit[] {
  return (edits || []).map((e) => {
    if (!e?.geometry?.positions?.length) return e;
    const { geometry, ...rest } = e as Any;
    return { ...rest, geometry: undefined } as FragEdit;
  });
}

function bytesOf(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}

/** Progressive degradation so quota pressure never loses the newest commits. */
function saveVersions(versions: NativeIfcVersion[]): boolean {
  let store = versions.slice(-MAX_VERSIONS);
  const attempts: Array<(v: NativeIfcVersion[]) => NativeIfcVersion[]> = [
    (v) => v, // 1. as-is
    (v) => v.slice(-Math.max(MIN_VERSIONS, Math.floor(v.length / 2))), // 2. drop oldest half
    (v) => v.map((ver, i) => (i < v.length - 1 ? { ...ver, slim: true, edits: stripGeometry(ver.edits) } : ver)), // 3. slim history
    (v) => v.slice(-MIN_VERSIONS).map((ver) => ({ ...ver, slim: true, edits: stripGeometry(ver.edits) })), // 4. last resort
  ];
  for (let i = 0; i < attempts.length; i++) {
    store = i === 0 ? store : attempts[i](store);
    try {
      localStorage.setItem(VERSIONS_KEY, JSON.stringify(store));
      return true;
    } catch {
      /* quota — try next degradation */
    }
  }
  console.warn("[native-ifc-versions] could not persist versions (storage quota)");
  return false;
}

export function nativeIfcVersionBytes(): number {
  try {
    return bytesOf(localStorage.getItem(VERSIONS_KEY) ?? "");
  } catch {
    return 0;
  }
}

/* ── Identity + diff (pure, mirrored in tests) ───────────────────────────── */

/** Stable element identity across versions. */
export function twinIdentity(e: Any): string {
  // Order matters: nativeElementId is re-minted when a twin is rebuilt from a
  // snapshot (clearAllEdits drops the old native element), so the IFC element
  // pair modelId:localId is the stable anchor; GlobalId stays first for
  // cross-model portability.
  if (e?.sourceGlobalId) return `gid:${e.sourceGlobalId}`;
  const lid = Number(e?.localId);
  if (e?.modelId != null && Number.isFinite(lid)) return `el:${e.modelId}:${lid}`;
  if (e?.nativeElementId) return `nat:${e.nativeElementId}`;
  return `id:${e?.id ?? "?"}`;
}

/** Canonical JSON so property-set comparisons do not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameGeometry(a?: { positions?: number[] }, b?: { positions?: number[] }): boolean {
  const pa = a?.positions;
  const pb = b?.positions;
  if (!pa?.length && !pb?.length) return true;
  if (pa?.length !== pb?.length) return false;
  if (!pa || !pb) return pa === pb;
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

function changedRow(from: Any, to: Any): TwinDiffRow | null {
  const changes: string[] = [];
  let deltaMeters: number | undefined;

  const p1 = Array.isArray(from.position) ? from.position : null;
  const p2 = Array.isArray(to.position) ? to.position : null;
  if (p1 && p2) {
    const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
    if (d > 1e-9) {
      changes.push(`moved · Δ ${d.toFixed(2)}m`);
      deltaMeters = d;
    }
  }
  const q1 = Array.isArray(from.quaternion) ? from.quaternion : null;
  const q2 = Array.isArray(to.quaternion) ? to.quaternion : null;
  if (q1 && q2) {
    const dot = Math.abs(q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3]);
    if (dot < 0.99999) changes.push("rotated");
  }
  const s1 = Array.isArray(from.scale) ? from.scale : null;
  const s2 = Array.isArray(to.scale) ? to.scale : null;
  if (s1 && s2 && s1.some((v: number, i: number) => Math.abs(v - s2[i]) > 1e-9)) changes.push("scaled");
  if (from.name !== to.name) changes.push("renamed");
  if (from.category !== to.category) changes.push("type changed");
  if (from.predefinedType !== to.predefinedType) changes.push("predefined type changed");
  if (from.description !== to.description) changes.push("description changed");
  for (const field of ["propertySets", "quantities", "overrides"] as const) {
    if (canonicalJson(from[field] ?? null) !== canonicalJson(to[field] ?? null)) {
      changes.push("properties changed");
      break;
    }
  }
  if (!sameGeometry(from.geometry, to.geometry)) changes.push("geometry changed");

  if (!changes.length) return null;
  return {
    key: twinIdentity(to),
    name: String(to.name ?? "(unnamed)"),
    category: String(to.category ?? "—"),
    modelId: to.modelId ? String(to.modelId) : undefined,
    changes,
    deltaMeters,
  };
}

/** Structured diff between two twin snapshots. */
export function computeTwinDiff(fromEdits: Any[], toEdits: Any[]): TwinDiff {
  const from = Array.isArray(fromEdits) ? fromEdits : [];
  const to = Array.isArray(toEdits) ? toEdits : [];
  const fromMap = new Map<string, Any>();
  for (const e of from) fromMap.set(twinIdentity(e), e);
  const toMap = new Map<string, Any>();
  for (const e of to) toMap.set(twinIdentity(e), e);

  const added: TwinDiffRow[] = [];
  const removed: TwinDiffRow[] = [];
  const changed: TwinDiffRow[] = [];
  let unchanged = 0;

  for (const [key, e] of toMap) {
    const prev = fromMap.get(key);
    if (!prev) {
      added.push({
        key, name: String(e.name ?? "(unnamed)"), category: String(e.category ?? "—"),
        modelId: e.modelId ? String(e.modelId) : undefined, changes: [],
      });
    } else {
      const row = changedRow(prev, e);
      if (row) changed.push(row);
      else unchanged++;
    }
  }
  for (const [key, e] of fromMap) {
    if (!toMap.has(key)) {
      removed.push({
        key, name: String(e.name ?? "(unnamed)"), category: String(e.category ?? "—"),
        modelId: e.modelId ? String(e.modelId) : undefined, changes: [],
      });
    }
  }
  return { from: null, to: null, added, removed, changed, unchanged };
}

/* ── Commit / log / restore ──────────────────────────────────────────────── */

export function commitNativeIfcVersion(
  message?: string,
  opts?: { auto?: boolean; edits?: FragEdit[]; silent?: boolean },
): NativeIfcVersion | null {
  let edits: FragEdit[];
  try {
    edits = opts?.edits ?? serializeEdits();
  } catch (err) {
    console.warn("[native-ifc-versions] snapshot failed", err);
    if (!opts?.silent) toast("Could not snapshot Native Twins for the commit.", "error");
    return null;
  }
  if (!edits.length) {
    if (!opts?.silent) toast("No Native Twin edits to commit. Make model editable first.", "warn");
    return null;
  }

  const versions = loadVersions();
  const prev = versions[versions.length - 1];
  const models = Array.from(new Set(edits.map((e) => String((e as Any).modelId ?? "?")))).sort();
  const version: NativeIfcVersion = {
    id: `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: `v${versions.length + 1}`,
    message: (message ?? "").trim() || `Commit · ${edits.length} twin(s)`,
    at: Date.now(),
    parent: prev?.id ?? null,
    twinCount: edits.length,
    models,
    auto: opts?.auto || undefined,
    edits,
  };
  versions.push(version);
  if (!saveVersions(versions)) {
    if (!opts?.silent) toast("Commit could not be saved (storage quota).", "error");
    return null;
  }
  record("commit", `${version.label} — ${version.message}`, { count: edits.length, id: version.id });
  if (!opts?.silent) toast(`Committed ${version.label}: ${version.message}`, "success");
  return version;
}

/** Version log, newest first, without the heavy edits payload. */
export function listNativeIfcVersions(): NativeIfcVersionMeta[] {
  return loadVersions()
    .slice()
    .reverse()
    .map(({ edits, ...meta }) => {
      void edits;
      return meta;
    });
}

export function getNativeIfcVersion(id: string): NativeIfcVersion | null {
  if (!id) return null;
  const found = loadVersions().find((v) => v.id === id || v.label === id);
  return found ?? null;
}

export function latestNativeIfcVersion(): NativeIfcVersion | null {
  const versions = loadVersions();
  return versions.length ? versions[versions.length - 1] : null;
}

/** Diff two stored versions; defaults to previous → latest (like HEAD~1..HEAD). */
export function diffNativeIfcVersions(fromId?: string, toId?: string): TwinDiff | null {
  const versions = loadVersions();
  if (!versions.length) return null;
  const toV = toId ? getNativeIfcVersion(toId) : versions[versions.length - 1];
  const fromV = fromId
    ? getNativeIfcVersion(fromId)
    : versions.length > 1
      ? versions[versions.length - 2]
      : null;
  if (!toV) return null;
  const diff = computeTwinDiff(fromV?.edits ?? [], toV.edits);
  diff.from = fromV ? { id: fromV.id, label: fromV.label, at: fromV.at } : null;
  diff.to = { id: toV.id, label: toV.label, at: toV.at };
  return diff;
}

/** Checkout a version. Current edits are auto-stashed as a new commit first. */
export async function restoreNativeIfcVersion(id: string): Promise<boolean> {
  const version = getNativeIfcVersion(id);
  if (!version) {
    toast("Version not found.", "warn");
    return false;
  }
  const ok = await confirmDialog(
    `Restore ${version.label}?`,
    `The scene Native Twins are replaced by ${version.twinCount} element(s) from “${version.message}”. ` +
      `Your current edits are committed automatically before the restore, so nothing is lost.`,
  );
  if (!ok) return false;

  try {
    const current = serializeEdits();
    if (current.length) {
      commitNativeIfcVersion(`Auto-saved before restore to ${version.label}`, { auto: true, silent: true });
    }
  } catch {
    /* stash best-effort */
  }

  try {
    await deserializeEdits(version.edits);
  } catch (err) {
    console.warn("[native-ifc-versions] restore failed", err);
    toast(`Restore failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return false;
  }
  try {
    markDirty();
  } catch {
    /* a broken dirty-listener must never swallow the restore record */
  }
  record("restore", `Restored ${version.label} — ${version.twinCount} twin(s)`, { count: version.twinCount });
  toast(`Restored ${version.label}: ${version.message}`, "success");
  return true;
}

export function deleteNativeIfcVersion(id: string): boolean {
  const versions = loadVersions();
  const next = versions.filter((v) => v.id !== id && v.label !== id);
  if (next.length === versions.length) return false;
  const removed = versions.find((v) => v.id === id || v.label === id);
  saveVersions(next);
  if (removed) record("delete", `Deleted version ${removed.label}`, { count: removed.twinCount });
  return true;
}

export function clearNativeIfcVersions(): void {
  try {
    localStorage.removeItem(VERSIONS_KEY);
  } catch {
    /* */
  }
}

export function nativeIfcVersionStatus(): { count: number; latest: string | null; bytes: number } {
  const versions = loadVersions();
  const latest = versions.length ? versions[versions.length - 1].label : null;
  return { count: versions.length, latest, bytes: nativeIfcVersionBytes() };
}

/* ── UI: diff dialog ─────────────────────────────────────────────────────── */

const MAX_DIFF_ROWS = 80;

export function showNativeIfcDiffDialog(fromId?: string, toId?: string): void {
  const diff = diffNativeIfcVersions(fromId, toId);
  const existing = document.getElementById("obs-native-ifc-diff");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = "obs-native-ifc-diff";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:100060;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font:12.5px system-ui,sans-serif";
  const card = document.createElement("div");
  card.style.cssText =
    "width:min(560px,94vw);max-height:80vh;display:flex;flex-direction:column;background:#161922;border:1px solid #2a2e3a;" +
    "border-radius:12px;color:#e8eaf0;box-shadow:0 16px 50px rgba(0,0,0,.5);overflow:hidden";
  const head = document.createElement("div");
  head.style.cssText = "padding:12px 14px;border-bottom:1px solid #2a2e3a;display:flex;align-items:center;gap:8px";
  head.innerHTML =
    `<b style="flex:1">Version diff</b>` +
    `<button type="button" data-x style="background:transparent;border:0;color:#94a3b8;cursor:pointer;font-size:16px">×</button>`;
  const body = document.createElement("div");
  body.style.cssText = "padding:10px 14px;overflow:auto";
  card.append(head, body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  (head.querySelector("[data-x]") as HTMLButtonElement | null)?.addEventListener("click", () => overlay.remove());

  if (!diff) {
    body.innerHTML = `<div style="color:#94a3b8;font-size:11.5px">No versions to diff yet — commit one first.</div>`;
    return;
  }
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  const range =
    diff.from ? `${diff.from.label} → ${diff.to?.label ?? "?"}` : `(empty) → ${diff.to?.label ?? "?"}`;
  const summary = document.createElement("div");
  summary.style.cssText = "font-size:11.5px;color:#cbd5e1;margin-bottom:8px";
  summary.textContent =
    `${range}: ${diff.added.length} added · ${diff.removed.length} removed · ` +
    `${diff.changed.length} changed · ${diff.unchanged} unchanged`;
  body.appendChild(summary);
  if (!total) {
    const none = document.createElement("div");
    none.style.cssText = "font-size:11px;color:#64748b";
    none.textContent = "Identical — no element changed between these versions.";
    body.appendChild(none);
    return;
  }

  const section = (title: string, rows: TwinDiffRow[], color: string) => {
    if (!rows.length) return;
    const t = document.createElement("div");
    t.style.cssText = `margin:8px 0 4px;font-weight:700;font-size:11px;color:${color}`;
    t.textContent = `${title} (${rows.length})`;
    body.appendChild(t);
    for (const r of rows.slice(0, MAX_DIFF_ROWS)) {
      const row = document.createElement("div");
      row.style.cssText = "font-size:11px;color:#cbd5e1;padding:3px 0;border-bottom:1px solid #1e2230";
      row.textContent =
        `${r.category} · ${r.name}` +
        (r.changes.length ? ` — ${r.changes.join(", ")}` : "");
      body.appendChild(row);
    }
    if (rows.length > MAX_DIFF_ROWS) {
      const more = document.createElement("div");
      more.style.cssText = "font-size:10.5px;color:#64748b;padding:4px 0";
      more.textContent = `…and ${rows.length - MAX_DIFF_ROWS} more`;
      body.appendChild(more);
    }
  };
  section("Added", diff.added, "#4ade80");
  section("Removed", diff.removed, "#f87171");
  section("Changed", diff.changed, "#facc15");
}

/* ── UI: versions section inside the Native IFC workflow panel ───────────── */

export function renderVersionsSection(container: HTMLElement, refresh?: () => void): void {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:6px";
  const title = document.createElement("div");
  title.style.cssText = "margin-top:6px;font-weight:600;font-size:11px;color:#94a3b8";
  const st = nativeIfcVersionStatus();
  title.textContent = `Versions — git for BIM (${st.count}${st.latest ? ` · latest ${st.latest}` : ""})`;
  wrap.appendChild(title);

  const rowBtns = document.createElement("div");
  rowBtns.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";

  const smallBtn = (label: string, onClick: () => void | Promise<void>, primary = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = primary
      ? "padding:6px 10px;border-radius:6px;border:1px solid #0284c7;background:#0369a1;color:#fff;font-weight:600;cursor:pointer;font-size:11px"
      : "padding:6px 10px;border-radius:6px;border:1px solid #3a3f4d;background:#2a2e3a;color:#e8eaf0;cursor:pointer;font-size:11px";
    b.onclick = () => {
      void (async () => {
        try {
          await onClick();
          refresh?.();
        } catch (err) {
          console.warn("[native-ifc-versions] action failed", err);
          toast(err instanceof Error ? err.message : String(err), "error");
        }
      })();
    };
    return b;
  };

  rowBtns.append(
    smallBtn("＋ Commit", async () => {
      const msg = await promptLine(
        "Commit version",
        "Commit message",
        "",
        "e.g. Moved south wall, resized window",
        "Snapshots every Native Twin (position, rotation, scale, properties).",
      );
      commitNativeIfcVersion(msg ?? undefined);
    }, true),
    smallBtn("Diff last two", () => showNativeIfcDiffDialog()),
  );
  wrap.appendChild(rowBtns);

  const versions = listNativeIfcVersions().slice(0, 8);
  if (!versions.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:10.5px;color:#64748b";
    empty.textContent = "No versions yet — commit to snapshot the current edits.";
    wrap.appendChild(empty);
  } else {
    for (const v of versions) {
      const row = document.createElement("div");
      row.style.cssText = "font-size:10.5px;color:#cbd5e1;padding:4px 0;border-bottom:1px solid #1e2230";
      const when = fmtDateTime(v.at);
      const head = document.createElement("div");
      head.textContent =
        `${v.auto ? "⚙ " : ""}${v.label} · ${v.twinCount} twin(s) · ${when}` +
        (v.slim ? " · slim" : "");
      row.appendChild(head);
      const msg = document.createElement("div");
      msg.style.cssText = "color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      msg.textContent = v.message;
      row.appendChild(msg);
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px;margin-top:3px";
      actions.append(
        smallBtn("Diff vs previous", () => showNativeIfcDiffDialog(v.id)),
        smallBtn("Restore", async () => {
          await restoreNativeIfcVersion(v.id);
        }),
        smallBtn("Delete", () => {
          deleteNativeIfcVersion(v.id);
        }),
      );
      row.appendChild(actions);
      wrap.appendChild(row);
    }
  }
  container.appendChild(wrap);
}

/* ── Setup ───────────────────────────────────────────────────────────────── */

export function setupNativeIfcVersions(): void {
  const api = {
    commit: commitNativeIfcVersion,
    list: listNativeIfcVersions,
    get: getNativeIfcVersion,
    diff: diffNativeIfcVersions,
    restore: restoreNativeIfcVersion,
    delete: deleteNativeIfcVersion,
    clear: clearNativeIfcVersions,
    status: nativeIfcVersionStatus,
    showDiffDialog: showNativeIfcDiffDialog,
    renderSection: renderVersionsSection,
    setChangeRecorder: setIfcVersionChangeRecorder,
    version: 1,
  };
  try {
    const core = ctx as Any;
    core.features = core.features || {};
    core.features.nativeIfcVersions = api;
  } catch {
    /* */
  }
  console.log(
    "[native-ifc-versions] git-for-BIM ready — commit · diff · restore (localStorage, progressive slimming)",
  );
}
