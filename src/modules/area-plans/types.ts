/**
 * Area plans & color fill — types + color scheme engine.
 *
 * Enables spatial analysis: color rooms by department, occupancy,
 * area type, or custom property. Matches BIM's "Color Schemes"
 * feature (Analyze > Color Fill Plans).
 *
 * The color fill is rendered as a semi-transparent polygon overlay
 * in the 2D plan view, drawn BEHIND the wall outlines so the
 * architecture stays visible.
 */

/** What property to color rooms by. */
export type ColorSchemeMode =
  | "department"
  | "occupancy"
  | "area-type"
  | "name"
  | "phase"
  | "custom";

/** A single color entry in a scheme (maps a property value → color). */
export interface ColorEntry {
  /** The property value this color applies to (e.g. "Office", "Residential"). */
  value: string;
  /** Fill color (hex). */
  color: string;
}

/** A complete color scheme. */
export interface ColorScheme {
  id: string;
  name: string;
  mode: ColorSchemeMode;
  /** Custom property name (only used when mode = "custom"). */
  customField?: string;
  /** Color entries — one per distinct property value. */
  entries: ColorEntry[];
  /** Opacity for the fill (0-1). */
  opacity: number;
}

/** A colored room polygon ready for rendering. */
export interface ColorFillPolygon {
  /** Room/area boundary in world [x, z] points. */
  boundary: Array<[number, number]>;
  /** Fill color (hex). */
  color: string;
  /** Opacity (0-1). */
  opacity: number;
  /** Label text to display at the room center. */
  label: string;
  /** Room name for tooltip. */
  roomName: string;
  /** Property value being colored (e.g. "Office"). */
  value: string;
}

/** Default color palette (distinct, accessible colors). */
export const DEFAULT_COLORS = [
  "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1",
  "#14b8a6", "#e11d48", "#a855f7", "#eab308", "#10b981",
  "#0ea5e9", "#f43f5e", "#8b5cf6", "#64748b", "#d946ef",
];

/** Built-in color schemes. */
export const DEFAULT_SCHEMES: ColorScheme[] = [
  {
    id: "by-department",
    name: "By Department",
    mode: "department",
    entries: [],
    opacity: 0.35,
  },
  {
    id: "by-occupancy",
    name: "By Occupancy",
    mode: "occupancy",
    entries: [],
    opacity: 0.35,
  },
  {
    id: "by-area-type",
    name: "By Area Type",
    mode: "area-type",
    entries: [],
    opacity: 0.35,
  },
  {
    id: "by-name",
    name: "By Room Name",
    mode: "name",
    entries: [],
    opacity: 0.3,
  },
];

/** Get the property value to color a room by, based on the scheme mode. */
export function getRoomValue(
  room: any,
  scheme: ColorScheme,
): string {
  switch (scheme.mode) {
    case "department": return room.department ?? "Unassigned";
    case "occupancy": return room.occupancy ?? "Unassigned";
    case "area-type": return room.areaType ?? "gross";
    case "name": return room.name ?? "Unnamed";
    case "phase": return room.phaseId ?? "New Construction";
    case "custom":
      return String((room.properties ?? {})[scheme.customField ?? ""] ?? "N/A");
    default: return "Unknown";
  }
}

/**
 * Auto-assign colors to all distinct values in a scheme.
 * Uses the DEFAULT_COLORS palette, cycling if there are more values than colors.
 */
export function autoAssignColors(
  scheme: ColorScheme,
  rooms: any[],
): ColorScheme {
  // Collect all distinct values.
  const values = new Set<string>();
  for (const room of rooms) {
    values.add(getRoomValue(room, scheme));
  }

  const entries: ColorEntry[] = [];
  let i = 0;
  for (const value of [...values].sort()) {
    entries.push({
      value,
      color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    });
    i++;
  }

  return { ...scheme, entries };
}

/**
 * Generate color-fill polygons for a set of rooms using a color scheme.
 *
 * @param rooms - array of room objects (must have boundary + properties)
 * @param scheme - color scheme to use
 * @returns array of ColorFillPolygon for rendering
 */
export function generateColorFill(
  rooms: any[],
  scheme: ColorScheme,
): ColorFillPolygon[] {
  if (!scheme.entries.length) {
    // Auto-assign if no entries exist.
    scheme = autoAssignColors(scheme, rooms);
  }

  const colorMap = new Map<string, string>();
  for (const entry of scheme.entries) {
    colorMap.set(entry.value, entry.color);
  }

  const result: ColorFillPolygon[] = [];

  for (const room of rooms) {
    if (!room.boundary || room.boundary.length < 3) continue;

    const value = getRoomValue(room, scheme);
    const color = colorMap.get(value) ?? "#94a3b8"; // fallback gray

    // Convert boundary to [x, z] tuples.
    const boundary: Array<[number, number]> = room.boundary.map(
      (b: any) => [b.x, b.z] as [number, number],
    );

    // Compute centroid for label placement.
    let cx = 0, cz = 0;
    for (const [x, z] of boundary) {
      cx += x;
      cz += z;
    }
    cx /= boundary.length;
    cz /= boundary.length;

    result.push({
      boundary,
      color,
      opacity: scheme.opacity,
      label: `${room.name ?? "Room"}${room.number ? " " + room.number : ""}\n${value}`,
      roomName: room.name ?? "Room",
      value,
    });
  }

  return result;
}

/** Get a color scheme by ID. */
export function getScheme(id: string): ColorScheme | null {
  return DEFAULT_SCHEMES.find((s) => s.id === id) ?? null;
}

/** List all scheme options (for UI dropdown). */
export function listSchemeOptions(): Array<{ id: string; label: string }> {
  return DEFAULT_SCHEMES.map((s) => ({ id: s.id, label: s.name }));
}
