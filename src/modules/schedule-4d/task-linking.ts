/**
 * Link P6 activities to model elements. Strategies, strongest first:
 *   1. explicit id: element property activityId / taskCode / wbs equals the activity id or WBS path (prefix)
 *   2. vocabulary + level: the activity text names an element category (wall, slab, duct ...) and, when it
 *      names a level ("Level 2", "L2", "2nd floor", "ground floor"), the element sits on that level.
 * An element is linked to at most one activity (the highest-scoring one). Pure.
 */
import type { SchedTask } from "./types";

export interface LinkElement {
  id: string;
  /** Element category, e.g. "wall", "slab", "column", "duct" (authored types or IFC class names). */
  type?: string;
  name?: string;
  /** Level name, e.g. "Level 2". */
  level?: string;
  activityId?: string;
  wbs?: string;
}

export interface LinkResult {
  /** activity id -> element ids */
  byTask: Map<string, string[]>;
  /** element id -> activity id */
  byElement: Map<string, string>;
  /** how each element was linked */
  how: Map<string, "id" | "wbs" | "vocabulary">;
  unlinkedTasks: string[];
  unlinkedElements: string[];
}

const VOCAB: Array<[RegExp, string[]]> = [
  [/\b(walls?|masonry|blockwork|partitions?|brickwork)\b/i, ["wall", "wallstandardcase", "curtain-wall"]],
  [/\b(columns?|pillars?)\b/i, ["column"]],
  [/\b(slabs?|floors?|decks?|screed|toppings?)\b(?!\s*\d)/i, ["slab", "floor"]],
  [/\b(beams?|girders?|joists?)\b/i, ["beam", "member"]],
  [/\b(roof(?:ing)?)\b/i, ["roof"]],
  [/\b(doors?)\b/i, ["door"]],
  [/\b(windows?|glazing)\b/i, ["window"]],
  [/\b(stairs?|staircases?)\b/i, ["stairs", "stair"]],
  [/\b(footings?|foundations?|piles?|pile caps?)\b/i, ["footing", "pile"]],
  [/\b(ducts?|hvac|ventilation)\b/i, ["duct"]],
  [/\b(pipes?|piping|plumbing|drainage)\b/i, ["pipe"]],
  [/\b(cable|electrical|conduit|trays?)\b/i, ["cable-tray", "conduit"]],
  [/\b(railings?|balustrades?|handrails?)\b/i, ["railing"]],
  [/\b(ceilings?)\b/i, ["ceiling", "covering"]],
];

const norm = (s: string | undefined) => String(s ?? "").toLowerCase().replace(/^ifc/, "").replace(/[^a-z0-9-]/g, "");

/** Level number named in free text; ground = 0. null when none is named. */
export function levelFromText(text: string): number | null {
  const t = text.toLowerCase();
  if (/\b(ground|gf|g\.f\.?)\b/.test(t) && !/\bground\s+(work|improvement)/.test(t)) return 0;
  let m = /\b(?:level|lvl|floor|storey|story|fl)\s*[-#]?\s*(\d{1,2})\b/.exec(t) || /\bl\s*(\d{1,2})\b/.exec(t);
  if (m) return +m[1];
  m = /\b(\d{1,2})(?:st|nd|rd|th)\s+(?:floor|level|storey|story)\b/.exec(t);
  if (m) return +m[1];
  const words: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  m = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:floor|level|storey|story)\b/.exec(t);
  return m ? words[m[1]] : null;
}

export function levelNumber(levelName: string | undefined): number | null {
  if (!levelName) return null;
  if (/\b(ground|gf)\b/i.test(levelName)) return 0;
  const m = /(-?\d+)\s*$/.exec(levelName.trim()) ?? /(-?\d+)/.exec(levelName);
  return m ? +m[1] : null;
}

export function linkTasksToElements(tasks: SchedTask[], elements: LinkElement[]): LinkResult {
  const byTask = new Map<string, string[]>(), byElement = new Map<string, string>(), how = new Map<string, "id" | "wbs" | "vocabulary">();
  const assign = (tid: string, e: LinkElement, h: "id" | "wbs" | "vocabulary") => {
    if (byElement.has(e.id)) return;
    byElement.set(e.id, tid); how.set(e.id, h);
    const a = byTask.get(tid) ?? []; a.push(e.id); byTask.set(tid, a);
  };
  const taskById = new Map(tasks.map((t) => [t.id.toLowerCase(), t]));

  // 1. explicit ids
  for (const e of elements) {
    const a = e.activityId?.trim().toLowerCase();
    if (a && taskById.has(a)) { assign(taskById.get(a)!.id, e, "id"); continue; }
    const w = e.wbs?.trim().toLowerCase();
    if (w) {
      // longest WBS match wins; element wbs may be deeper than the activity's WBS
      let best: SchedTask | null = null;
      for (const t of tasks) {
        const tw = t.wbs.toLowerCase();
        if (tw && (w === tw || w.startsWith(tw + ".")) && (!best || tw.length > best.wbs.length)) best = t;
      }
      if (best) assign(best.id, e, "wbs");
    }
  }
  // 2. vocabulary + level
  for (const t of tasks) {
    const text = `${t.name} ${t.wbsName ?? ""}`;
    const cats = new Set<string>();
    for (const [re, kinds] of VOCAB) if (re.test(text)) for (const k of kinds) cats.add(k);
    if (!cats.size) continue;
    const lvl = levelFromText(text);
    for (const e of elements) {
      if (byElement.has(e.id)) continue;
      if (!cats.has(norm(e.type))) continue;
      if (lvl != null && levelNumber(e.level) !== lvl) continue;
      assign(t.id, e, "vocabulary");
    }
  }
  return {
    byTask, byElement, how,
    unlinkedTasks: tasks.filter((t) => !byTask.has(t.id)).map((t) => t.id),
    unlinkedElements: elements.filter((e) => !byElement.has(e.id)).map((e) => e.id),
  };
}
