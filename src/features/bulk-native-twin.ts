/**
 * Bulk convert linked-model (IFC/FRAG) selection → Editable Native Twins.
 *
 * Designed for multi-selection: progress, cancellation, summary reporting,
 * continue-on-error, single soft fragments refresh, optional batch history.
 *
 * Wire into frag-edit via:
 *   import { bulkConvertLinkedToNativeTwin } from "./bulk-native-twin";
 *   ctx.features.fragEdit.bulkConvert = bulkConvertLinkedToNativeTwin;
 *
 * Or call beginEdit from frag-edit (injected) to avoid circular imports.
 */

import { ctx } from "../core/context";

export type BulkTwinStatus =
  | "created"
  | "skipped_existing"
  | "failed_no_geometry"
  | "failed_validation"
  | "failed_register"
  | "aborted"
  | "failed_unknown";

export interface BulkTwinItemResult {
  modelId: string;
  localId: number;
  status: BulkTwinStatus;
  twinId?: string;
  name?: string;
  message?: string;
}

export interface BulkTwinProgress {
  index: number;
  total: number;
  modelId: string;
  localId: number;
  status: BulkTwinStatus;
  createdSoFar: number;
  failedSoFar: number;
}

export interface BulkTwinSelectionMap {
  [modelId: string]: Iterable<number> | Set<number> | number[];
}

export interface BulkConvertOptions {
  /** Explicit multi-selection. If omitted, reads current selection manager / highlighter. */
  selection?: BulkTwinSelectionMap | null;
  /** Abort mid-batch. */
  signal?: AbortSignal | null;
  /** Progress for UI (panel, command center). */
  onProgress?: (p: BulkTwinProgress) => void;
  /**
   * When true (default), suppress per-item success toasts from beginEdit
   * by relying on a single summary toast at the end.
   * Implementation uses a short-lived flag on ctx.features.fragEdit.
   */
  quietPerItem?: boolean;
  /** Open Native Twin panel when at least one twin was created (default true). */
  openPanelOnSuccess?: boolean;
  /**
   * Injected single-item converter (defaults to ctx.features.fragEdit.begin).
   * Tests can pass a mock.
   */
  convertOne?: (modelId: string, localId: number) => Promise<{ id: string; name?: string } | null>;
  /**
   * Existing twins lookup: return true if modelId+localId already has a twin.
   * Defaults to scanning fragEdit.list().
   */
  isAlreadyTwin?: (modelId: string, localId: number) => boolean;
}

export interface BulkConvertResult {
  total: number;
  created: number;
  skipped: number;
  failed: number;
  aborted: boolean;
  items: BulkTwinItemResult[];
  twins: Array<{ id: string; modelId: string; localId: number; name?: string }>;
}

type Any = Record<string, any>;

function toast(message: string, kind: "info" | "success" | "warn" | "error" = "info") {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
  } catch {
    /* optional */
  }
}

function readSelectionSnapshot(): BulkTwinSelectionMap | null {
  try {
    const sel: Any = (ctx.features as Any)?.selection;
    const snap = sel?.snapshot?.();
    if (snap && Object.keys(snap).length) return snap as BulkTwinSelectionMap;
  } catch {
    /* */
  }
  try {
    const sel: Any = (ctx.features as Any)?.selection;
    if (sel && typeof sel.adoptFromHighlighter === "function") {
      sel.adoptFromHighlighter();
      const snap = sel?.snapshot?.();
      if (snap && Object.keys(snap).length) return snap as BulkTwinSelectionMap;
    }
  } catch {
    /* */
  }
  return null;
}

function flattenSelection(map: BulkTwinSelectionMap): Array<{ modelId: string; localId: number }> {
  const out: Array<{ modelId: string; localId: number }> = [];
  for (const [modelId, ids] of Object.entries(map)) {
    if (!modelId) continue;
    const list = ids instanceof Set ? [...ids] : Array.from(ids as Iterable<number>);
    for (const raw of list) {
      const localId = Number(raw);
      if (!Number.isFinite(localId)) continue;
      out.push({ modelId, localId });
    }
  }
  return out;
}

function defaultIsAlreadyTwin(modelId: string, localId: number): boolean {
  try {
    const listFn = (ctx.features as Any)?.fragEdit?.list;
    const edits = typeof listFn === "function" ? listFn() : [];
    if (!Array.isArray(edits)) return false;
    return edits.some(
      (e: Any) => e && e.modelId === modelId && Number(e.localId) === localId,
    );
  } catch {
    return false;
  }
}

async function defaultConvertOne(
  modelId: string,
  localId: number,
): Promise<{ id: string; name?: string } | null> {
  const begin = (ctx.features as Any)?.fragEdit?.begin;
  if (typeof begin !== "function") {
    throw new Error("fragEdit.begin is not registered — call setupFragEdit() first");
  }
  const twin = await begin(modelId, localId);
  if (!twin) return null;
  return { id: String(twin.id), name: twin.name ? String(twin.name) : undefined };
}

/**
 * Bulk-convert all selected (or explicitly provided) linked-model objects
 * into editable Native Twins.
 */
export async function bulkConvertLinkedToNativeTwin(
  options: BulkConvertOptions = {},
): Promise<BulkConvertResult> {
  const quiet = options.quietPerItem !== false;
  const openPanel = options.openPanelOnSuccess !== false;
  const signal = options.signal ?? null;
  const convertOne = options.convertOne ?? defaultConvertOne;
  const isAlreadyTwin = options.isAlreadyTwin ?? defaultIsAlreadyTwin;

  const selection = options.selection ?? readSelectionSnapshot();
  const flat = selection ? flattenSelection(selection) : [];

  const result: BulkConvertResult = {
    total: flat.length,
    created: 0,
    skipped: 0,
    failed: 0,
    aborted: false,
    items: [],
    twins: [],
  };

  if (!flat.length) {
    toast("Native Twin bulk convert: no linked elements selected.", "warn");
    return result;
  }

  const fragEdit = (ctx.features as Any)?.fragEdit as Any | undefined;
  const prevQuiet = fragEdit?.__bulkQuiet;
  if (fragEdit && quiet) fragEdit.__bulkQuiet = true;

  try {
    for (let index = 0; index < flat.length; index++) {
      if (signal?.aborted) {
        result.aborted = true;
        result.items.push({
          modelId: flat[index].modelId,
          localId: flat[index].localId,
          status: "aborted",
          message: "Batch aborted",
        });
        result.failed += flat.length - index;
        break;
      }

      const { modelId, localId } = flat[index];

      if (isAlreadyTwin(modelId, localId)) {
        const item: BulkTwinItemResult = {
          modelId,
          localId,
          status: "skipped_existing",
          message: "Already has a Native Twin",
        };
        result.items.push(item);
        result.skipped++;
        options.onProgress?.({
          index: index + 1,
          total: flat.length,
          modelId,
          localId,
          status: item.status,
          createdSoFar: result.created,
          failedSoFar: result.failed,
        });
        continue;
      }

      let status: BulkTwinStatus = "failed_unknown";
      let twinId: string | undefined;
      let name: string | undefined;
      let message: string | undefined;

      try {
        const twin = await convertOne(modelId, localId);
        if (twin?.id) {
          status = "created";
          twinId = twin.id;
          name = twin.name;
          result.created++;
          result.twins.push({ id: twin.id, modelId, localId, name: twin.name });
        } else {
          status = "failed_no_geometry";
          message = "No usable geometry or registration failed";
          result.failed++;
        }
      } catch (err) {
        status = "failed_unknown";
        message = err instanceof Error ? err.message : String(err);
        result.failed++;
        console.warn("[bulk-native-twin] item failed", modelId, localId, err);
      }

      const item: BulkTwinItemResult = { modelId, localId, status, twinId, name, message };
      result.items.push(item);
      options.onProgress?.({
        index: index + 1,
        total: flat.length,
        modelId,
        localId,
        status,
        createdSoFar: result.created,
        failedSoFar: result.failed,
      });
    }
  } finally {
    if (fragEdit) fragEdit.__bulkQuiet = prevQuiet;
  }

  // Soft fragments refresh once after the batch (avoid blanking large links).
  try {
    const core = (ctx.fragments as Any)?.core;
    if (core && typeof core.update === "function") {
      await Promise.resolve(core.update(false));
    }
  } catch {
    /* optional */
  }

  // Clear linked selection highlight after successful batch.
  try {
    const sel = (ctx.features as Any)?.selection;
    sel?.clear?.();
    await sel?.applyToHighlighter?.();
  } catch {
    /* optional */
  }

  if (openPanel && result.created > 0) {
    try {
      (ctx.features as Any)?.fragEdit?.togglePanel?.();
      const vis = (ctx.features as Any)?.fragEdit?.isPanelVisible?.();
      if (vis === false) (ctx.features as Any)?.fragEdit?.togglePanel?.();
    } catch {
      /* optional */
    }
  }

  const parts = [
    `${result.created} created`,
    result.skipped ? `${result.skipped} skipped` : null,
    result.failed ? `${result.failed} failed` : null,
    result.aborted ? "aborted" : null,
  ].filter(Boolean);
  const kind =
    result.created > 0 && result.failed === 0
      ? "success"
      : result.created > 0
        ? "warn"
        : "error";
  toast(`Native Twin bulk convert: ${parts.join(", ")} (${result.total} selected).`, kind);

  return result;
}

/** Convenience: convert current multi-selection only. */
export async function bulkConvertCurrentSelection(
  opts: Omit<BulkConvertOptions, "selection"> = {},
): Promise<BulkConvertResult> {
  return bulkConvertLinkedToNativeTwin(opts);
}
