/**
 * Wire parametric regeneration + equality constraints to live authoring.
 *
 * Equal height / thickness / width / depth / sillHeight and equal LENGTH
 * (linear start–end elements) stay synchronized when any linked element is edited.
 */
import { getParametricRegenService } from "../parametric-regen";
import { endpointForLength, baselineLength } from "../native-twin/twin-dimensions";
import { ctx } from "../../core/context";

type Any = Record<string, any>;

const EQUAL_PARAM_KEYS = ["height", "thickness", "width", "depth", "sillHeight", "length"] as const;
type EqualParamKey = (typeof EQUAL_PARAM_KEYS)[number];

function auth(): Any | null {
  try {
    return (ctx.features as Any)?.authoring ?? null;
  } catch {
    return null;
  }
}

function elements(): Any[] {
  const a = auth();
  if (!a) return [];
  if (typeof a.getElements === "function") return a.getElements() ?? [];
  return Array.isArray(a.elements) ? a.elements : [];
}

function equalGroupId(el: Any, key: string): string | null {
  const pe = el?.properties?.paramEquals;
  if (!pe || typeof pe !== "object") return null;
  const g = pe[key];
  return g != null && String(g) ? String(g) : null;
}

function segmentLen(el: Any): number {
  const s = el?.params?.start;
  const e = el?.params?.end;
  if (!Array.isArray(s) || !Array.isArray(e)) return 0;
  return baselineLength([Number(s[0]), Number(s[1])], [Number(e[0]), Number(e[1])]);
}

/** Resize a linear element to `newLen`, keeping start and direction (end moves). */
function applySegmentLength(el: Any, newLen: number): boolean {
  if (!(newLen > 1e-6)) return false;
  const s = el?.params?.start;
  const e = el?.params?.end;
  if (!Array.isArray(s) || !Array.isArray(e)) return false;
  const start: [number, number] = [Number(s[0]), Number(s[1])];
  const end: [number, number] = [Number(e[0]), Number(e[1])];
  const next = endpointForLength(start, end, newLen);
  if (!next) return false;
  const cur = baselineLength(start, end);
  if (Math.abs(cur - newLen) < 1e-6) return false;
  el.params = { ...(el.params || {}), end: [next[0], next[1]] };
  return true;
}

/**
 * Link selected elements so the given parameter stays equal (parametric model).
 * For `length`, peers are linear start–end elements resized to the driver length.
 */
export function linkEqualParam(elementIds: string[], key: EqualParamKey | string): string | null {
  const ids = elementIds.map(String).filter(Boolean);
  if (ids.length < 2) return null;
  const group = `eq-${key}-${Date.now().toString(36)}`;
  const els = elements();
  let driver: Any | null = null;
  for (const el of els) {
    if (!ids.includes(String(el.id))) continue;
    if (key === "length" && (!el.params?.start || !el.params?.end)) continue;
    el.properties = { ...(el.properties || {}) };
    el.properties.paramEquals = { ...(el.properties.paramEquals || {}), [key]: group };
    if (!driver) driver = el;
  }
  if (!driver) return null;

  if (key === "length") {
    const L = segmentLen(driver);
    if (L > 1e-6) propagateEqualParam(String(driver.id), "length", L, { skipSource: true });
  } else if (typeof driver.params?.[key] === "number") {
    propagateEqualParam(String(driver.id), key, Number(driver.params[key]), { skipSource: true });
  }

  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", {
        detail: {
          message: `Parametric: equal ${key} on ${ids.length} elements`,
          kind: "success",
        },
      }),
    );
  } catch {
    /* */
  }
  return group;
}

export function unlinkEqualParam(elementIds: string[], key: string): void {
  const idSet = new Set(elementIds.map(String));
  for (const el of elements()) {
    if (!idSet.has(String(el.id))) continue;
    if (el.properties?.paramEquals?.[key] != null) {
      const pe = { ...el.properties.paramEquals };
      delete pe[key];
      el.properties = { ...el.properties, paramEquals: pe };
    }
  }
}

/**
 * When `sourceId` changes `key` to `value`, push that value to every element
 * sharing the same paramEquals group.
 */
export function propagateEqualParam(
  sourceId: string,
  key: string,
  value: number,
  opts?: { skipSource?: boolean },
): number {
  if (!Number.isFinite(value)) return 0;
  const els = elements();
  const source = els.find((e) => String(e.id) === String(sourceId));
  if (!source) return 0;
  const group = equalGroupId(source, key);
  if (!group) return 0;

  let n = 0;
  for (const el of els) {
    if (opts?.skipSource && String(el.id) === String(sourceId)) continue;
    if (equalGroupId(el, key) !== group) continue;
    if (String(el.id) === String(sourceId)) continue;

    if (key === "length") {
      if (applySegmentLength(el, value)) n++;
      continue;
    }

    const cur = Number(el.params?.[key]);
    if (Math.abs(cur - value) < 1e-9) continue;
    el.params = { ...(el.params || {}), [key]: value };
    n++;
  }

  if (n > 0) {
    const a = auth();
    try {
      a?.rebuildAuthored?.();
      a?.markAuthoringDirty?.();
    } catch {
      /* */
    }
    try {
      getParametricRegenService().markDirtyMany(
        els.filter((e) => equalGroupId(e, key) === group).map((e) => String(e.id)),
        "constraint",
      );
    } catch {
      /* */
    }
  }
  return n;
}

/**
 * After a transform/drag of linear elements, sync equal-length groups using
 * each focused element's current segment length as driver.
 */
export function syncEqualLengthAfterTransform(focusIds: string[]): number {
  const els = elements();
  const idSet = new Set(focusIds.map(String));
  let total = 0;
  const seenGroups = new Set<string>();
  for (const el of els) {
    if (!idSet.has(String(el.id))) continue;
    const g = equalGroupId(el, "length");
    if (!g || seenGroups.has(g)) continue;
    seenGroups.add(g);
    const L = segmentLen(el);
    if (L > 1e-6) total += propagateEqualParam(String(el.id), "length", L);
  }
  return total;
}

export function onParametricParamWritten(elementId: string, key: string, value: number): void {
  try {
    getParametricRegenService().markDirty(String(elementId), "parameter");
  } catch {
    /* */
  }
  if (key === "length" || EQUAL_PARAM_KEYS.includes(key as EqualParamKey)) {
    // length may be written as key "length" while geometry lives in start/end
    if (key === "length") {
      const el = elements().find((e) => String(e.id) === String(elementId));
      const L = el ? segmentLen(el) : value;
      propagateEqualParam(String(elementId), "length", Number.isFinite(L) && L > 0 ? L : value);
    } else {
      propagateEqualParam(String(elementId), key, value);
    }
  }
}

export function wireParametricToAuthoring(): void {
  const regen = getParametricRegenService();
  regen.setParamAccessors(
    (id, name) => {
      const el = elements().find((e) => String(e.id) === String(id));
      if (name === "length" && el) {
        const L = segmentLen(el);
        return L > 0 ? L : undefined;
      }
      const v = el?.params?.[name];
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    },
    (id, name, value) => {
      const el = elements().find((e) => String(e.id) === String(id));
      if (!el) return;
      if (name === "length") {
        applySegmentLength(el, value);
        return;
      }
      el.params = { ...(el.params || {}), [name]: value };
    },
  );
  regen.setRegenHandler(async () => {
    const a = auth();
    a?.rebuildAuthored?.();
  });

  try {
    (window as any).__obsParametric = {
      linkEqualParam,
      unlinkEqualParam,
      propagateEqualParam,
      syncEqualLengthAfterTransform,
      onParametricParamWritten,
      wireParametricToAuthoring,
      version: 2,
    };
  } catch {
    /* */
  }
  console.log("[parametric] regen wired · equal height/thickness/length live");
}
