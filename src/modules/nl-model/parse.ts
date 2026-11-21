/**
 * Natural-language room parser — keyless, deterministic, no LLM.
 *
 * Turns a sentence such as "draw a 4×6 room with a door and two windows"
 * into a {@link RoomRequest}. The grammar is deliberately small and the
 * parser is honest about it: anything outside the grammar is a clear
 * error naming what was missing, never a hallucinated room.
 *
 * Supported (case-insensitive, metres assumed unless a unit is given):
 *   - dimensions: "4x6", "4×6", "4 by 6", "4m x 6m", "4000mm x 6000mm"
 *   - "room" is required — the sentence must describe a room.
 *   - openings: "a door", "two windows", "3 doors", "1 window";
 *     a bare mention ("with windows") means one of that opening.
 *   - opening width: "1.2m wide windows", "0.9 m door", "windows 1.2 m wide".
 *   - wall height: "3 m high", "2.7m tall" (default 3.0 m).
 *   - origin: "at 10, 5" (default 0, 0 — the room's south-west corner).
 *
 * Defaults match the authoring engine: wall 3.0 m high × 0.255 m thick,
 * door 0.9 × 2.1 m, window 1.2 × 1.4 m with a 0.9 m sill.
 * Pure — no DOM, no THREE, no context — so the node suite can import it.
 */

export interface OpeningRequest {
  /** How many of this opening. */
  count: number;
  /** Clear width in metres. */
  width: number;
  /** Height in metres. */
  height: number;
  /** Sill height in metres (0 for doors). */
  sillHeight: number;
}

export interface RoomRequest {
  /** Plan width (X) in metres. */
  width: number;
  /** Plan depth (Z) in metres. */
  depth: number;
  /** Wall height in metres. */
  wallHeight: number;
  /** Wall thickness in metres. */
  wallThickness: number;
  /** South-west corner [x, z] in metres. */
  origin: [number, number];
  doors: OpeningRequest;
  windows: OpeningRequest;
  /** The sentence this was parsed from. */
  source: string;
}

export const DEFAULT_WALL_HEIGHT = 3.0;
export const DEFAULT_WALL_THICKNESS = 0.255;
export const DEFAULT_DOOR: OpeningRequest = { count: 0, width: 0.9, height: 2.1, sillHeight: 0 };
export const DEFAULT_WINDOW: OpeningRequest = { count: 0, width: 1.2, height: 1.4, sillHeight: 0.9 };

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function toMetres(value: number, unit: string | undefined): number {
  if (unit === "mm") return value / 1000;
  if (unit === "cm") return value / 100;
  return value;
}

function countToken(token: string | undefined): number | undefined {
  if (!token) return undefined;
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return NUMBER_WORDS[token.toLowerCase()];
}

function parseOpening(
  lower: string,
  singular: "door" | "window",
  fallback: OpeningRequest,
): OpeningRequest {
  const plural = `${singular}s`;
  const req: OpeningRequest = { ...fallback, count: 0 };

  // Count: "two windows", "3 doors", "a door", or a bare mention.
  const counted = lower.match(
    new RegExp(`\\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\s+${plural}\\b`),
  );
  const single = lower.match(new RegExp(`\\b(a|an|one)\\s+${singular}\\b`));
  const bare = lower.match(new RegExp(`\\b${plural}\\b`)) ?? lower.match(new RegExp(`\\b${singular}\\b`));
  if (counted) req.count = countToken(counted[1]) ?? 0;
  else if (single) req.count = 1;
  else if (bare) req.count = 1;
  if (req.count === 0) return req;

  // Width, written before the noun ("1.2m wide windows", "0.9 m door") …
  // A bare number before the noun is a COUNT ("25 windows"), not a width,
  // so the before-form requires a unit or the word "wide".
  const before =
    lower.match(
      new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(mm|cm|m)\\s*(?:wide\\s+)?${plural}\\b`),
    ) ??
    lower.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(mm|cm|m)\\s*(?:wide\\s+)?${singular}\\b`)) ??
    lower.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*wide\\s+${plural}\\b`)) ??
    lower.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*wide\\s+${singular}\\b`));
  // … or after it ("windows 1.2 m wide").
  const after = lower.match(
    new RegExp(`${plural}\\s+(\\d+(?:\\.\\d+)?)\\s*(mm|cm|m)?\\s*wide\\b`),
  ) ?? lower.match(new RegExp(`${singular}\\s+(\\d+(?:\\.\\d+)?)\\s*(mm|cm|m)?\\s*wide\\b`));
  const sized = before ?? after;
  if (sized) req.width = toMetres(parseFloat(sized[1]), sized[2]);
  if (!(req.width > 0) || req.width > 5) {
    throw new Error(
      `The ${singular} width (${sized ? sized[1] : "?"}) is not a usable size — give a width between 0.1 m and 5 m, e.g. "a 0.9 m door".`,
    );
  }
  if (req.count < 1 || req.count > 20) {
    throw new Error(`Cannot place ${req.count} ${plural} — say between 1 and 20.`);
  }
  return req;
}

export function parseRoomCommand(text: string): RoomRequest {
  const source = String(text ?? "").trim();
  if (!source) throw new Error("Describe a room first, e.g. \"draw a 4×6 room with a door and two windows\".");
  const lower = source.toLowerCase();
  if (!/\broom\b/.test(lower)) {
    throw new Error(
      `Could not model "${source}": it does not describe a room. Say e.g. "draw a 4×6 room with a door and two windows".`,
    );
  }

  const dim = lower.match(
    /(\d+(?:\.\d+)?)\s*(mm|cm|m)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)?/,
  );
  if (!dim) {
    throw new Error(
      `Could not model "${source}": no room size found. Give two dimensions, e.g. "a 4×6 room" or "a 4 m by 6 m room".`,
    );
  }
  const width = toMetres(parseFloat(dim[1]), dim[2]);
  const depth = toMetres(parseFloat(dim[3]), dim[4]);
  if (!(width >= 0.5 && width <= 100) || !(depth >= 0.5 && depth <= 100)) {
    throw new Error(
      `Room size ${width} × ${depth} m is outside the supported range (0.5–100 m per side).`,
    );
  }

  let wallHeight = DEFAULT_WALL_HEIGHT;
  const tall = lower.match(/(\d+(?:\.\d+)?)\s*(mm|cm|m)?\s*(?:high|tall)\b/);
  if (tall) wallHeight = toMetres(parseFloat(tall[1]), tall[2]);
  if (!(wallHeight >= 0.5 && wallHeight <= 10)) {
    throw new Error(`Wall height ${wallHeight} m is outside the supported range (0.5–10 m).`);
  }

  let origin: [number, number] = [0, 0];
  const at = lower.match(/at\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (at) origin = [parseFloat(at[1]), parseFloat(at[2])];

  const doors = parseOpening(lower, "door", DEFAULT_DOOR);
  const windows = parseOpening(lower, "window", DEFAULT_WINDOW);

  return {
    width,
    depth,
    wallHeight,
    wallThickness: DEFAULT_WALL_THICKNESS,
    origin,
    doors,
    windows,
    source,
  };
}
