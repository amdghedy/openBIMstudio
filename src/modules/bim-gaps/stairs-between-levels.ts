/**
 * Stairs between levels + railings on stairs — multi-storey circulation gap.
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { createM2Element, type StairShape } from "./m2-tools";
import type { Vec2 } from "./m2-geometry";

type Any = Record<string, any>;

function authoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}

function levelsSorted(): Any[] {
  return (authoring()?.getLevels?.() ?? []).slice().sort((a: Any, b: Any) => a.elevation - b.elevation);
}

function activeLevel(): Any | null {
  const a = authoring();
  const id = a?.getActiveLevelId?.() ?? null;
  return levelsSorted().find((l) => l.id === id) ?? levelsSorted()[0] ?? null;
}

function levelAbove(lv: Any): Any | null {
  const all = levelsSorted();
  const i = all.findIndex((l) => l.id === lv.id);
  return i >= 0 ? all[i + 1] ?? null : null;
}

/**
 * Place a straight stair from active level to the level above.
 * `start` is the lower end; run direction is +X by default (or `dir`).
 */
export function placeStairsBetweenLevels(opts?: {
  start?: Vec2;
  shape?: StairShape;
  width?: number;
  dir?: Vec2;
}): Any | null {
  const base = activeLevel();
  if (!base) {
    notify("warn", "Create a level first");
    return null;
  }
  const above = levelAbove(base);
  if (!above) {
    notify("warn", "Add a level above the active one (Levels panel) before placing inter-story stairs");
    return null;
  }
  const rise = Number(above.elevation) - Number(base.elevation);
  if (rise < 0.5) {
    notify("warn", "Level spacing too small for stairs");
    return null;
  }
  // Comfortable tread ~0.28 m, riser ~0.17 → run length ≈ rise/0.17 * 0.28
  const nRisers = Math.max(3, Math.ceil(rise / 0.175));
  const tread = 0.28;
  const runLen = nRisers * tread;
  const start: Vec2 = opts?.start ?? [0, 0];
  const dir: Vec2 = opts?.dir ?? [1, 0];
  const dlen = Math.hypot(dir[0], dir[1]) || 1;
  const ux = dir[0] / dlen, uz = dir[1] / dlen;
  const end: Vec2 = [start[0] + ux * runLen, start[1] + uz * runLen];

  const el = createM2Element("stairs", [start, end], {
    shape: opts?.shape ?? "straight",
    lv: {
      id: base.id,
      elevation: Number(base.elevation),
      above: Number(above.elevation),
    },
  });
  if (!el) return null;
  // Force height to exact level span
  try {
    el.params.height = rise;
    el.params.width = opts?.width ?? el.params.width ?? 1.2;
    el.properties = {
      ...(el.properties ?? {}),
      baseLevelId: base.id,
      topLevelId: above.id,
      betweenLevels: true,
    };
    authoring()?.rebuildAuthored?.();
  } catch { /* */ }
  notify(
    "success",
    `Stairs ${base.name ?? "L1"} → ${above.name ?? "L2"} · rise ${rise.toFixed(2)} m · run ${runLen.toFixed(2)} m`,
  );
  return el;
}

/** Build left/right railings along a stair's run line. */
export function placeRailingsOnStair(stairId?: string): number {
  const a = authoring();
  const els: Any[] = a?.getElements?.() ?? [];
  const stair =
    (stairId ? els.find((e) => e.id === stairId) : null) ??
    [...els].reverse().find((e) => e.type === "stairs");
  if (!stair?.params?.start || !stair?.params?.end) {
    notify("warn", "Select or place a stair first");
    return 0;
  }
  const [sx, sz] = stair.params.start;
  const [ex, ez] = stair.params.end;
  const dx = ex - sx, dz = ez - sz;
  const L = Math.hypot(dx, dz) || 1;
  const ux = dx / L, uz = dz / L;
  const px = -uz, pz = ux;
  const w = (Number(stair.params.width) || 1.2) / 2;
  const elev = Number(stair.params.elevation) || 0;
  let n = 0;
  for (const side of [-1, 1]) {
    const ox = px * w * side, oz = pz * w * side;
    const path: Vec2[] = [
      [sx + ox, sz + oz],
      [ex + ox, ez + oz],
    ];
    const rail = createM2Element("railing", path, {
      lv: {
        id: stair.levelId ?? null,
        elevation: elev,
        above: elev + (Number(stair.params.height) || 3),
      },
    });
    if (rail) {
      rail.properties = { ...(rail.properties ?? {}), hostStairId: stair.id };
      n++;
    }
  }
  if (n) {
    try { a?.rebuildAuthored?.(); } catch { /* */ }
    notify("success", `Added ${n} railing(s) on stair`);
  }
  return n;
}

export function setupStairsBetweenLevels(): void {
  // Published as a service key, not a window global: bim-gaps-boot imports the
  // functions directly and registers the command-palette entries itself.
  (ctx.features as Any).stairsBetweenLevels = {
    placeStairsBetweenLevels,
    placeRailingsOnStair,
  };
  console.log("[stairs-between-levels] STAIRSBETWEENLEVELS / RAILONSTAIR ready");
}
