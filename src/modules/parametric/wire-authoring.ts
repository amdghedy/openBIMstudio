/**
 * Wire parametric regeneration + equality constraints to live authoring.
 *
 * Closes the gap where ParametricRegenService existed but never read/wrote
 * authored params, and equal-height / equal-thickness links were metadata only.
 */
import { getParametricRegenService } from "../parametric-regen";
import { ctx } from "../../core/context";

type Any = Record<string, any>;

const EQUAL_PARAM_KEYS = ["height", "thickness", "width", "depth", "sillHeight"] as const;
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

/** Group id stored on properties.paramEquals[key] */
function equalGroupId(el: Any, key: string): string | null {
  const pe = el?.properties?.paramEquals;
  if (!pe || typeof pe !== "object") return null;
  const g = pe[key];
  return g != null && String(g) ? String(g) : null;
}

/**
 * Link selected elements so the given parameter stays equal (parametric model).
 * Returns the shared group id.
 */
export function linkEqualParam(elementIds: string[], key: EqualParamKey | string): string | null {
  const ids = elementIds.map(String).filter(Boolean);
  if (ids.length < 2) return null;
  const group = `eq-${key}-${Date.now().toString(36)}`;
  const els = elements();
  let driver: Any | null = null;
  for (const el of els) {
    if (!ids.includes(String(el.id))) continue;
    el.properties = { ...(el.properties || {}) };
    el.properties.paramEquals = { ...(el.properties.paramEquals || {}), [key]: group };
    if (!driver) driver = el;
  }
  // Seed peers from first element's value
  if (driver && typeof driver.params?.[key] === "number") {
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

/** Clear equal-param link for key on given elements. */
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
 * sharing the same paramEquals group (one-way parametric drive).
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

/** Hook after a geometric param write from the property palette / grips. */
export function onParametricParamWritten(elementId: string, key: string, value: number): void {
  try {
    getParametricRegenService().markDirty(String(elementId), "parameter");
  } catch {
    /* */
  }
  if (EQUAL_PARAM_KEYS.includes(key as EqualParamKey) || key === "height" || key === "thickness") {
    propagateEqualParam(String(elementId), key, value);
  }
}

export function wireParametricToAuthoring(): void {
  const regen = getParametricRegenService();
  regen.setParamAccessors(
    (id, name) => {
      const el = elements().find((e) => String(e.id) === String(id));
      const v = el?.params?.[name];
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    },
    (id, name, value) => {
      const el = elements().find((e) => String(e.id) === String(id));
      if (!el) return;
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
      onParametricParamWritten,
      wireParametricToAuthoring,
      version: 1,
    };
  } catch {
    /* */
  }
  console.log("[parametric] regen wired to authoring · equal height/thickness links live");
}
