/**
 * CAD Dimension engine — geometry, formatting, and markup builders for every
 * AutoCAD-style dimension tool used by the 2D CAD editor.
 *
 * Supported tools / scenarios:
 *   DIMLINEAR     — horizontal or vertical (forced axis) linear dimension
 *   DIMALIGNED    — aligned to the two pick points
 *   DIMANGULAR    — 3-point (vertex + two rays) or 2-line angle
 *   DIMRADIUS     — radius on circle / arc
 *   DIMDIAMETER   — diameter on circle
 *   DIMARC        — arc-length dimension
 *   DIMORDINATE   — X or Y ordinate from UCS origin
 *   DIMCONTINUE   — continue from last dimension's second extension line
 *   DIMBASELINE   — baseline from last dimension's first extension line
 *   DIMCENTER     — center mark (cross) on circle / arc
 *
 * Pure module — no DOM. Markups are plain data for the viewer to paint.
 */

export type Pt = { x: number; y: number };

export type CadDimKind =
  | "linear"
  | "aligned"
  | "angular"
  | "radius"
  | "diameter"
  | "arc"
  | "ordinate"
  | "center-mark";

export interface CadDimStyle {
  id: string;
  name: string;
  /** Text height in drawing units. */
  textHeight: number;
  /** Arrow / tick size. */
  arrowSize: number;
  /** Extension line offset from origin. */
  extOffset: number;
  /** Extension line extension past dimension line. */
  extExtend: number;
  /** Gap between dimension line and text. */
  textGap: number;
  /** Decimal precision. */
  precision: number;
  /** Unit suffix appended to text ("" | "mm" | "m" | "in" …). */
  unitSuffix: string;
  /** Scale factor applied to measured value before formatting. */
  linearScale: number;
  color: string;
  textColor: string;
  /** "arrow" | "tick" | "dot" | "none" */
  arrowType: "arrow" | "tick" | "dot" | "none";
  /** Suppress extension lines. */
  suppressExt1?: boolean;
  suppressExt2?: boolean;
}

export const DEFAULT_CAD_DIM_STYLE: CadDimStyle = {
  id: "Standard",
  name: "Standard",
  textHeight: 2.5,
  arrowSize: 2.0,
  extOffset: 1.0,
  extExtend: 1.0,
  textGap: 0.8,
  precision: 2,
  unitSuffix: "",
  linearScale: 1,
  color: "#e2e8f0",
  textColor: "#f8fafc",
  arrowType: "arrow",
};

export interface CadDimMarkup {
  kind: CadDimKind;
  /** Geometry points used for reconstruction / continue / baseline. */
  pts: Pt[];
  /** Formatted measurement text. */
  text: string;
  /** Numeric value in drawing units (before linearScale display). */
  value: number;
  /** Optional override style id. */
  styleId?: string;
  /** For linear: "x" | "y" | "aligned". */
  axis?: "x" | "y" | "aligned";
  /** For ordinate: "x" | "y". */
  ordinateAxis?: "x" | "y";
  /** Center of circle/arc for radial tools. */
  center?: Pt;
  /** Arc sweep data. */
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  /** Dimension line offset side (user third click projected). */
  offset?: number;
}

export interface DimLineGeometry {
  /** Extension line 1: from origin1 to dim line. */
  ext1: [Pt, Pt];
  /** Extension line 2. */
  ext2: [Pt, Pt];
  /** Dimension line segment. */
  dimLine: [Pt, Pt];
  /** Text anchor (mid of dim line, offset by textGap). */
  textPos: Pt;
  /** Text rotation degrees (0 = horizontal). */
  textRot: number;
  arrows: Array<{ tip: Pt; dir: Pt }>;
}

export interface RadialGeometry {
  leader: [Pt, Pt];
  textPos: Pt;
  textRot: number;
  centerMark?: [Pt, Pt][];
}

/* ── math ──────────────────────────────────────────────────────────────── */

const EPS = 1e-12;

export function formatDimValue(metersOrUnits: number, style: CadDimStyle): string {
  const v = metersOrUnits * style.linearScale;
  const s = v.toFixed(style.precision);
  return style.unitSuffix ? `${s} ${style.unitSuffix}` : s;
}

export function angleDeg(a: Pt, b: Pt): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

export function angleAt(vertex: Pt, p1: Pt, p2: Pt): number {
  const a1 = Math.atan2(p1.y - vertex.y, p1.x - vertex.x);
  const a2 = Math.atan2(p2.y - vertex.y, p2.x - vertex.x);
  let d = ((a2 - a1) * 180) / Math.PI;
  while (d < 0) d += 360;
  if (d > 180) d = 360 - d;
  return d;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function unit(dx: number, dy: number): Pt {
  const L = Math.hypot(dx, dy) || 1;
  return { x: dx / L, y: dy / L };
}

function perp(d: Pt): Pt {
  return { x: -d.y, y: d.x };
}

/**
 * Build linear / aligned dimension geometry.
 * p1, p2 = definition points; offsetPt = third click that places the dim line.
 * axis: "x" forces horizontal measure, "y" vertical, "aligned" uses p1→p2.
 */
export function buildLinearGeometry(
  p1: Pt,
  p2: Pt,
  offsetPt: Pt,
  style: CadDimStyle,
  axis: "x" | "y" | "aligned" = "aligned",
): { geom: DimLineGeometry; value: number } {
  let a = { ...p1 },
    b = { ...p2 };
  if (axis === "x") {
    // horizontal measure: project onto constant Y of offset
    const y = offsetPt.y;
    a = { x: p1.x, y };
    b = { x: p2.x, y };
  } else if (axis === "y") {
    const x = offsetPt.x;
    a = { x, y: p1.y };
    b = { x, y: p2.y };
  } else {
    // aligned: dim line parallel to p1-p2, offset by signed distance from offsetPt
    const d = unit(p2.x - p1.x, p2.y - p1.y);
    const n = perp(d);
    const side = (offsetPt.x - p1.x) * n.x + (offsetPt.y - p1.y) * n.y;
    a = { x: p1.x + n.x * side, y: p1.y + n.y * side };
    b = { x: p2.x + n.x * side, y: p2.y + n.y * side };
  }

  const value =
    axis === "x" ? Math.abs(p2.x - p1.x) : axis === "y" ? Math.abs(p2.y - p1.y) : dist(p1, p2);

  const d = unit(b.x - a.x, b.y - a.y);
  const n = perp(d);
  // extension lines from original points toward dim line
  const ext1: [Pt, Pt] = [
    {
      x: p1.x + (a.x - p1.x === 0 && a.y - p1.y === 0 ? 0 : unit(a.x - p1.x, a.y - p1.y).x * style.extOffset),
      y: p1.y + (a.x - p1.x === 0 && a.y - p1.y === 0 ? 0 : unit(a.x - p1.x, a.y - p1.y).y * style.extOffset),
    },
    {
      x: a.x + (a.x - p1.x === 0 && a.y - p1.y === 0 ? 0 : unit(a.x - p1.x, a.y - p1.y).x * style.extExtend),
      y: a.y + (a.x - p1.x === 0 && a.y - p1.y === 0 ? 0 : unit(a.x - p1.x, a.y - p1.y).y * style.extExtend),
    },
  ];
  // simpler extension endpoints
  const e1a = p1;
  const e1b = {
    x: a.x + (Math.hypot(a.x - p1.x, a.y - p1.y) > EPS ? unit(a.x - p1.x, a.y - p1.y).x * style.extExtend : n.x * style.extExtend),
    y: a.y + (Math.hypot(a.x - p1.x, a.y - p1.y) > EPS ? unit(a.x - p1.x, a.y - p1.y).y * style.extExtend : n.y * style.extExtend),
  };
  const e2a = p2;
  const e2b = {
    x: b.x + (Math.hypot(b.x - p2.x, b.y - p2.y) > EPS ? unit(b.x - p2.x, b.y - p2.y).x * style.extExtend : n.x * style.extExtend),
    y: b.y + (Math.hypot(b.x - p2.x, b.y - p2.y) > EPS ? unit(b.x - p2.x, b.y - p2.y).y * style.extExtend : n.y * style.extExtend),
  };

  const mid: Pt = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const textPos: Pt = {
    x: mid.x + n.x * style.textGap,
    y: mid.y + n.y * style.textGap,
  };
  let textRot = angleDeg(a, b);
  if (textRot > 90 || textRot < -90) textRot += 180;

  return {
    value,
    geom: {
      ext1: [e1a, e1b],
      ext2: [e2a, e2b],
      dimLine: [a, b],
      textPos,
      textRot,
      arrows: [
        { tip: a, dir: d },
        { tip: b, dir: { x: -d.x, y: -d.y } },
      ],
    },
  };
}

/** Angular dimension from vertex + two ray points. */
export function buildAngularMarkup(
  vertex: Pt,
  p1: Pt,
  p2: Pt,
  style: CadDimStyle,
): CadDimMarkup {
  const value = angleAt(vertex, p1, p2);
  return {
    kind: "angular",
    pts: [vertex, p1, p2],
    text: `${value.toFixed(style.precision)}°`,
    value,
    styleId: style.id,
  };
}

/** Radius dimension. center + point on circle (or pick on arc). */
export function buildRadiusMarkup(center: Pt, onCircle: Pt, style: CadDimStyle): CadDimMarkup {
  const r = dist(center, onCircle);
  return {
    kind: "radius",
    pts: [center, onCircle],
    text: `R${formatDimValue(r, style)}`,
    value: r,
    center,
    radius: r,
    styleId: style.id,
  };
}

/** Diameter dimension. */
export function buildDiameterMarkup(center: Pt, onCircle: Pt, style: CadDimStyle): CadDimMarkup {
  const r = dist(center, onCircle);
  const d = r * 2;
  // opposite point
  const opp: Pt = { x: center.x - (onCircle.x - center.x), y: center.y - (onCircle.y - center.y) };
  return {
    kind: "diameter",
    pts: [opp, onCircle],
    text: `Ø${formatDimValue(d, style)}`,
    value: d,
    center,
    radius: r,
    styleId: style.id,
  };
}

/** Arc-length dimension. */
export function buildArcLengthMarkup(
  center: Pt,
  radius: number,
  startAngleDeg: number,
  endAngleDeg: number,
  style: CadDimStyle,
): CadDimMarkup {
  let sweep = endAngleDeg - startAngleDeg;
  while (sweep < 0) sweep += 360;
  if (sweep > 360) sweep %= 360;
  const value = (sweep / 360) * 2 * Math.PI * radius;
  const mid = startAngleDeg + sweep / 2;
  const rad = (mid * Math.PI) / 180;
  const onArc: Pt = {
    x: center.x + radius * Math.cos(rad),
    y: center.y + radius * Math.sin(rad),
  };
  return {
    kind: "arc",
    pts: [center, onArc],
    text: formatDimValue(value, style),
    value,
    center,
    radius,
    startAngle: startAngleDeg,
    endAngle: endAngleDeg,
    styleId: style.id,
  };
}

/** Ordinate dimension from origin. */
export function buildOrdinateMarkup(
  origin: Pt,
  point: Pt,
  axis: "x" | "y",
  style: CadDimStyle,
): CadDimMarkup {
  const value = axis === "x" ? point.x - origin.x : point.y - origin.y;
  return {
    kind: "ordinate",
    pts: [origin, point],
    text: formatDimValue(Math.abs(value), style),
    value,
    ordinateAxis: axis,
    styleId: style.id,
  };
}

/** Center mark cross. */
export function buildCenterMarkMarkup(center: Pt, radius: number, style: CadDimStyle): CadDimMarkup {
  const s = Math.max(style.arrowSize, radius * 0.05);
  return {
    kind: "center-mark",
    pts: [
      { x: center.x - s, y: center.y },
      { x: center.x + s, y: center.y },
      { x: center.x, y: center.y - s },
      { x: center.x, y: center.y + s },
    ],
    text: "",
    value: 0,
    center,
    radius,
    styleId: style.id,
  };
}

/** Linear / aligned markup from two definition points + offset point. */
export function buildLinearMarkup(
  p1: Pt,
  p2: Pt,
  offsetPt: Pt,
  style: CadDimStyle,
  axis: "x" | "y" | "aligned" = "aligned",
): CadDimMarkup {
  const { value } = buildLinearGeometry(p1, p2, offsetPt, style, axis);
  return {
    kind: axis === "aligned" ? "aligned" : "linear",
    pts: [p1, p2, offsetPt],
    text: formatDimValue(value, style),
    value,
    axis,
    styleId: style.id,
    offset: axis === "aligned" ? undefined : axis === "x" ? offsetPt.y : offsetPt.x,
  };
}

/**
 * Continue: next dim shares the previous dim's second point as new first point.
 * Returns new markup and the chain anchor for the next continue.
 */
export function continueDimension(
  last: CadDimMarkup,
  nextPt: Pt,
  offsetPt: Pt,
  style: CadDimStyle,
): { markup: CadDimMarkup; chainFrom: Pt } | null {
  if (last.pts.length < 2) return null;
  const p1 = last.pts[1];
  const axis = last.axis ?? "aligned";
  const markup = buildLinearMarkup(p1, nextPt, offsetPt, style, axis);
  return { markup, chainFrom: nextPt };
}

/**
 * Baseline: next dim shares the previous dim's first point as origin.
 */
export function baselineDimension(
  last: CadDimMarkup,
  nextPt: Pt,
  offsetPt: Pt,
  style: CadDimStyle,
  baselineSpacing = 5,
): { markup: CadDimMarkup; origin: Pt } | null {
  if (last.pts.length < 2) return null;
  const p1 = last.pts[0];
  const axis = last.axis ?? "aligned";
  // Push offset further out for baseline spacing
  let off = { ...offsetPt };
  if (last.pts[2]) {
    const d = unit(offsetPt.x - last.pts[0].x, offsetPt.y - last.pts[0].y);
    off = {
      x: last.pts[2].x + d.x * baselineSpacing,
      y: last.pts[2].y + d.y * baselineSpacing,
    };
  }
  const markup = buildLinearMarkup(p1, nextPt, off, style, axis);
  return { markup, origin: p1 };
}

/** Tool scenario descriptors for UI / command help / testing. */
export interface DimScenario {
  command: string;
  aliases: string[];
  tool: string;
  picks: string[];
  description: string;
  example: string;
}

export const DIM_SCENARIOS: DimScenario[] = [
  {
    command: "DIMLINEAR",
    aliases: ["DLI", "DIMLIN"],
    tool: "dimlinear",
    picks: ["first extension origin", "second extension origin", "dimension line location"],
    description: "Creates a horizontal or vertical linear dimension (axis chosen by offset side).",
    example: "DIMLINEAR → pick wall start → pick wall end → click above to place",
  },
  {
    command: "DIMALIGNED",
    aliases: ["DAL", "DIMALI"],
    tool: "dimaligned",
    picks: ["first extension origin", "second extension origin", "dimension line location"],
    description: "Creates a linear dimension aligned with the two definition points.",
    example: "DIMALIGNED → pick two endpoints of a diagonal line → place offset",
  },
  {
    command: "DIMANGULAR",
    aliases: ["DAN", "DIMANG"],
    tool: "dimang",
    picks: ["vertex", "first ray point", "second ray point"],
    description: "Measures the angle at a vertex between two rays.",
    example: "DIMANGULAR → pick corner → pick point on first edge → pick point on second edge",
  },
  {
    command: "DIMRADIUS",
    aliases: ["DRA", "DIMRAD"],
    tool: "dimradius",
    picks: ["circle or arc (or center)", "point on circumference"],
    description: "Creates a radius dimension for a circle or arc.",
    example: "DIMRADIUS → pick circle → confirm radial point",
  },
  {
    command: "DIMDIAMETER",
    aliases: ["DDI", "DIMDIA"],
    tool: "dimdia",
    picks: ["circle", "point on circumference"],
    description: "Creates a diameter dimension for a circle.",
    example: "DIMDIAMETER → pick circle edge",
  },
  {
    command: "DIMARC",
    aliases: ["DAR"],
    tool: "dimarc",
    picks: ["arc"],
    description: "Creates an arc-length dimension.",
    example: "DIMARC → pick arc entity",
  },
  {
    command: "DIMORDINATE",
    aliases: ["DOR", "DIMORD"],
    tool: "dimordinate",
    picks: ["feature location", "leader end (X or Y inferred by drag)"],
    description: "Creates an ordinate dimension measuring X or Y from the UCS origin.",
    example: "DIMORDINATE → pick point → drag horizontally for Y or vertically for X",
  },
  {
    command: "DIMCONTINUE",
    aliases: ["DCO", "DIMCONT"],
    tool: "dimcont",
    picks: ["next extension origin", "(optional) dim line location"],
    description: "Continues a linear dimension from the second extension line of the previous dimension.",
    example: "After DIMLINEAR, DIMCONTINUE → pick next point → places chained dim",
  },
  {
    command: "DIMBASELINE",
    aliases: ["DBA", "DIMBASE"],
    tool: "dimbase",
    picks: ["next extension origin"],
    description: "Creates a baseline dimension from the first extension line of the previous dimension.",
    example: "After DIMLINEAR, DIMBASELINE → pick next point",
  },
  {
    command: "DIMCENTER",
    aliases: ["DCE"],
    tool: "dimcenter",
    picks: ["circle or arc"],
    description: "Places a center mark (cross) at the center of a circle or arc.",
    example: "DIMCENTER → pick circle",
  },
];

/** Map command token → tool id. */
export function resolveDimCommand(token: string): string | null {
  const t = token.trim().toUpperCase();
  for (const s of DIM_SCENARIOS) {
    if (s.command === t || s.aliases.some((a) => a === t)) return s.tool;
  }
  // legacy generic
  if (t === "DIM" || t === "DIMSTYLE") return "dim";
  return null;
}
