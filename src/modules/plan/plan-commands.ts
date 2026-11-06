/**
 * Command table and direct-entry parser for the 2D plan command line.
 * Pure TypeScript (no DOM) so it can be unit-tested.
 */

export type PlanAction =
  | "zoom-extents" | "pan" | "select" | "undo" | "redo" | "delete" | "cancel" | "repeat"
  | "regen" | "select-all" | "close-plan" | "help" | "finish";

export interface PlanCommand {
  name: string;
  aliases: string[];
  description: string;
  /** Tool name understood by setPlanToolFromRibbon, or ... */
  tool?: string;
  /** ... a built-in action. */
  action?: PlanAction;
  group: "Place" | "Annotate" | "Modify" | "View" | "Session";
}

const c = (group: PlanCommand["group"], name: string, aliases: string[], description: string, run: { tool?: string; action?: PlanAction }): PlanCommand =>
  ({ group, name, aliases, description, ...run });

export const PLAN_COMMANDS: readonly PlanCommand[] = [
  c("Place", "WALL", ["WA"], "Place walls (click start, click end, Enter to finish)", { tool: "wall" }),
  c("Place", "BEAM", ["BM"], "Place beams", { tool: "beam" }),
  c("Place", "BRACE", ["BR"], "Place braces", { tool: "brace" }),
  c("Place", "TRUSS", ["TR"], "Place trusses", { tool: "truss" }),
  c("Place", "STRIP", ["SF", "STRIPFOOTING"], "Place wall (strip) foundations", { tool: "strip" }),
  c("Place", "DUCT", ["DU"], "Place ducts", { tool: "duct" }),
  c("Place", "PIPE", ["PP"], "Place pipes", { tool: "pipe" }),
  c("Place", "TRAY", ["CT", "CABLETRAY"], "Place cable trays", { tool: "cable-tray" }),
  c("Place", "CONDUIT", ["CD"], "Place conduits", { tool: "conduit" }),
  c("Place", "LINE", ["L", "ML", "MLINE"], "Place model lines", { tool: "mline" }),
  c("Place", "COLUMN", ["CM", "COL"], "Place columns", { tool: "column" }),
  c("Place", "FOOTING", ["FT", "PILE"], "Place isolated foundations", { tool: "footing" }),
  c("Place", "EQUIPMENT", ["EQ"], "Place equipment", { tool: "equipment" }),
  c("Place", "DOOR", ["DR"], "Place doors", { tool: "door" }),
  c("Place", "WINDOW", ["WN"], "Place windows", { tool: "window" }),
  c("Annotate", "DIMALIGNED", ["DIM", "DI", "DAL"], "Aligned dimension", { tool: "dim-aligned" }),
  c("Annotate", "DIMLINEAR", ["DLI"], "Linear dimension", { tool: "dim-linear" }),
  c("Annotate", "DIMANGULAR", ["DAN"], "Angular dimension", { tool: "dim-angular" }),
  c("Annotate", "DIMRADIUS", ["DRA", "RADIUS"], "Radial dimension", { tool: "dim-radial" }),
  c("Annotate", "DIMDIAMETER", ["DDI"], "Diameter dimension", { tool: "dim-diameter" }),
  c("Annotate", "AUTODIM", ["AD"], "Dimension a run of edges", { tool: "auto-dim" }),
  c("Annotate", "AUTODIMALL", ["ADA"], "Auto-dimension the whole plan", { tool: "auto-dim-all" }),
  c("Annotate", "TAG", ["TG"], "Tag elements by category", { tool: "tag" }),
  c("Annotate", "TAGALL", ["TAL"], "Tag all elements", { tool: "tag-all" }),
  c("Annotate", "ROOMTAG", ["RT"], "Tag rooms", { tool: "room-tag" }),
  c("Annotate", "TEXT", ["T", "DT", "MT", "MTEXT"], "Place text", { tool: "text" }),
  c("Annotate", "SPOTELEV", ["SE"], "Spot elevation", { tool: "spot-elev" }),
  c("Modify", "SELECT", ["SEL"], "Select elements (box: left-to-right window, right-to-left crossing)", { action: "select" }),
  c("Modify", "SELECTALL", ["SA", "AL"], "Select every authored element (all levels)", { action: "select-all" }),
  c("Modify", "MOVE", ["M", "MV"], "Move the selected elements", { tool: "move" }),
  c("Modify", "ERASE", ["E", "DEL", "DELETE"], "Delete the selected elements", { action: "delete" }),
  c("Modify", "UNDO", ["U"], "Undo the last change", { action: "undo" }),
  c("Modify", "REDO", ["RED"], "Redo", { action: "redo" }),
  c("View", "PAN", ["P"], "Pan the view", { action: "pan" }),
  c("View", "ZOOM", ["Z"], "Zoom: ZOOM E (extents) or ZOOM A (all)", { action: "zoom-extents" }),
  c("View", "REGEN", ["R", "REGENALL"], "Regenerate the plan from the model", { action: "regen" }),
  c("Session", "FINISH", ["FIN", "ENTER"], "Finish the current path / chain", { action: "finish" }),
  c("Session", "CANCEL", ["ESC"], "Cancel every active command", { action: "cancel" }),
  c("Session", "REPEAT", ["RP"], "Repeat the last command (also Enter or Space on an empty line)", { action: "repeat" }),
  c("Session", "CLOSE", ["EXIT", "QUIT"], "Close the 2D plan and return to 3D", { action: "close-plan" }),
  c("Session", "HELP", ["?", "H"], "List all commands", { action: "help" }),
];

export interface Resolved { command: PlanCommand; arg: string }

/** Exact match on a command name or alias (first word). Returns null for unknown input. */
export function resolveCommand(input: string): Resolved | null {
  const text = input.trim();
  if (!text) return null;
  const [first, ...rest] = text.split(/\s+/);
  const key = first.toUpperCase();
  const command = PLAN_COMMANDS.find((x) => x.name === key || x.aliases.includes(key));
  if (!command) return null;
  let arg = rest.join(" ");
  // "ZOOM E" -> arg "E" ; "ZE" style is not an alias, keep it simple.
  if (command.name === "ZOOM" && !/^(E|EXTENTS|A|ALL)?$/i.test(arg)) arg = arg.toUpperCase();
  return { command, arg };
}

/** Commands whose name or alias starts with the typed prefix (exact alias first). */
export function suggest(prefix: string, limit = 8): PlanCommand[] {
  const p = prefix.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (!p) return [];
  const exact: PlanCommand[] = [], starts: PlanCommand[] = [];
  for (const cmd of PLAN_COMMANDS) {
    if (cmd.name === p || cmd.aliases.includes(p)) exact.push(cmd);
    else if (cmd.name.startsWith(p) || cmd.aliases.some((a) => a.startsWith(p))) starts.push(cmd);
  }
  return [...exact, ...starts].slice(0, limit);
}

export type PointEntry =
  | { kind: "point"; x: number; z: number }
  | { kind: "distance"; value: number };

const NUM = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)";

/**
 * Direct coordinate entry while drawing, like a CAD command line.
 *   "5,3"       absolute point (x east, z north)
 *   "@2,0"      relative to the last point
 *   "4<30"      polar from the last point: distance 4 at 30 degrees (counter-clockwise from east)
 *   "@4<30"     same
 *   "2500"      a distance (the tool applies it along the current direction)
 * `last` is the previous point (or the origin when there is none).
 */
export function parsePointEntry(text: string, last: { x: number; z: number } | null): PointEntry | null {
  const t = text.trim().replace(/\s+/g, "");
  if (!t) return null;
  const base = last ?? { x: 0, z: 0 };
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^@?(${NUM})<(${NUM})$`).exec(t))) {
    const d = Number(m[1]), a = (Number(m[2]) * Math.PI) / 180;
    return { kind: "point", x: base.x + d * Math.cos(a), z: base.z + d * Math.sin(a) };
  }
  if ((m = new RegExp(`^(@)?(${NUM}),(${NUM})$`).exec(t))) {
    const x = Number(m[2]), z = Number(m[3]);
    return m[1] ? { kind: "point", x: base.x + x, z: base.z + z } : { kind: "point", x, z };
  }
  if ((m = new RegExp(`^(${NUM})$`).exec(t))) return { kind: "distance", value: Number(m[1]) };
  return null;
}
