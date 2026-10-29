/**
 * 2D Detail Hatch Pattern Library — ANSI/ISO standard fill patterns
 * for BIM drafting sections, plans, and detail views.
 *
 * Patterns are defined as procedural line generators that return
 * sets of line segments within a bounding region. Each pattern is
 * parameterized by scale and rotation for view-specific tuning.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

export interface HatchLine {
  x1: number; y1: number;
  x2: number; y2: number;
}

export interface HatchPatternDef {
  id: string;
  name: string;
  description: string;
  /** Generate pattern lines within the given rectangular bounds. */
  generate(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    scale: number,
    rotationDeg: number,
  ): HatchLine[];
}

// ── Utility ──────────────────────────────────────────────────────────────

function rotatePoint(
  x: number, y: number, cx: number, cy: number, rad: number,
): [number, number] {
  const dx = x - cx, dy = y - cy;
  const c = Math.cos(rad), s = Math.sin(rad);
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

function parallelLines(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  spacing: number,
  angleDeg: number,
  rotationDeg: number,
): HatchLine[] {
  const totalAngle = ((angleDeg + rotationDeg) * Math.PI) / 180;
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const diag = Math.hypot(w, h);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  const lines: HatchLine[] = [];
  const count = Math.ceil(diag / spacing) + 2;

  for (let i = -count; i <= count; i++) {
    const offset = i * spacing;
    // Horizontal line at offset, then rotate by totalAngle around center
    const x1 = cx - diag;
    const x2 = cx + diag;
    const y = cy + offset;
    const [rx1, ry1] = rotatePoint(x1, y, cx, cy, totalAngle);
    const [rx2, ry2] = rotatePoint(x2, y, cx, cy, totalAngle);

    // Clip to bounds (simple rejection)
    if (
      (rx1 < bounds.minX && rx2 < bounds.minX) ||
      (rx1 > bounds.maxX && rx2 > bounds.maxX) ||
      (ry1 < bounds.minY && ry2 < bounds.minY) ||
      (ry1 > bounds.maxY && ry2 > bounds.maxY)
    ) continue;

    lines.push({ x1: rx1, y1: ry1, x2: rx2, y2: ry2 });
  }
  return lines;
}

function stippleDots(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  spacing: number,
  dotRadius: number,
  rotationDeg: number,
): HatchLine[] {
  const lines: HatchLine[] = [];
  const rad = (rotationDeg * Math.PI) / 180;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  // Pseudo-random stipple using grid offsets
  let row = 0;
  for (let y = bounds.minY; y <= bounds.maxY; y += spacing) {
    const xOff = (row % 2) * spacing * 0.5;
    for (let x = bounds.minX + xOff; x <= bounds.maxX; x += spacing) {
      const [rx, ry] = rotatePoint(x, y, cx, cy, rad);
      if (rx < bounds.minX || rx > bounds.maxX || ry < bounds.minY || ry > bounds.maxY) continue;
      // Represent dot as a tiny cross
      lines.push({ x1: rx - dotRadius, y1: ry, x2: rx + dotRadius, y2: ry });
      lines.push({ x1: rx, y1: ry - dotRadius, x2: rx, y2: ry + dotRadius });
    }
    row++;
  }
  return lines;
}

// ── ANSI31 — Steel / General Diagonal Hatch (45° lines) ──────────────

export const ANSI31: HatchPatternDef = {
  id: "ANSI31",
  name: "ANSI31 — Steel / General",
  description: "Standard 45° diagonal hatching per ANSI Y14.2 (steel, general material)",
  generate(bounds, scale = 1, rotationDeg = 0) {
    const spacing = 3.0 * scale; // 3mm at 1:1
    return parallelLines(bounds, spacing, 45, rotationDeg);
  },
};

// ── Concrete — Stipple Dots + Random Triangle Aggregates ─────────────

export const CONCRETE: HatchPatternDef = {
  id: "CONCRETE",
  name: "Concrete (ACI / Section Cut)",
  description: "Concrete section fill: stipple dots with triangular aggregate symbols",
  generate(bounds, scale = 1, rotationDeg = 0) {
    const spacing = 4.0 * scale;
    const dotR = 0.3 * scale;
    const dots = stippleDots(bounds, spacing, dotR, rotationDeg);

    // Add triangular aggregate symbols at larger spacing
    const aggSpacing = spacing * 3;
    const aggSize = 1.5 * scale;
    const rad = (rotationDeg * Math.PI) / 180;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    let row = 0;

    for (let y = bounds.minY + aggSpacing; y <= bounds.maxY - aggSpacing; y += aggSpacing) {
      const xOff = (row % 2) * aggSpacing * 0.6;
      for (let x = bounds.minX + xOff + aggSpacing; x <= bounds.maxX - aggSpacing; x += aggSpacing) {
        const [rx, ry] = rotatePoint(x, y, cx, cy, rad);
        if (rx < bounds.minX || rx > bounds.maxX || ry < bounds.minY || ry > bounds.maxY) continue;

        // Small irregular triangle
        const a: [number, number] = [rx - aggSize * 0.5, ry - aggSize * 0.3];
        const b: [number, number] = [rx + aggSize * 0.5, ry - aggSize * 0.2];
        const c: [number, number] = [rx + aggSize * 0.1, ry + aggSize * 0.4];
        dots.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
        dots.push({ x1: b[0], y1: b[1], x2: c[0], y2: c[1] });
        dots.push({ x1: c[0], y1: c[1], x2: a[0], y2: a[1] });
      }
      row++;
    }

    return dots;
  },
};

// ── Earth — Diagonal crosshatch at 45° and 135° ─────────────────────

export const EARTH: HatchPatternDef = {
  id: "EARTH",
  name: "Earth / Soil Section",
  description: "Earth fill: diagonal crosshatch (45° + 135°) per ISO 128",
  generate(bounds, scale = 1, rotationDeg = 0) {
    const spacing = 4.0 * scale;
    const lines45 = parallelLines(bounds, spacing, 45, rotationDeg);
    const lines135 = parallelLines(bounds, spacing, 135, rotationDeg);
    return [...lines45, ...lines135];
  },
};

// ── Additional Patterns ──────────────────────────────────────────────

export const BRICK: HatchPatternDef = {
  id: "BRICK",
  name: "Brick / Masonry Section",
  description: "Horizontal lines with staggered vertical joints",
  generate(bounds, scale = 1, rotationDeg = 0) {
    const courseH = 3.0 * scale;
    const brickW = 7.0 * scale;
    const lines: HatchLine[] = [];
    const rad = (rotationDeg * Math.PI) / 180;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;

    let row = 0;
    for (let y = bounds.minY; y <= bounds.maxY; y += courseH) {
      // Horizontal course line
      const [hx1, hy1] = rotatePoint(bounds.minX, y, cx, cy, rad);
      const [hx2, hy2] = rotatePoint(bounds.maxX, y, cx, cy, rad);
      lines.push({ x1: hx1, y1: hy1, x2: hx2, y2: hy2 });

      // Vertical joints (staggered per course)
      const xOff = (row % 2) * brickW * 0.5;
      for (let x = bounds.minX + xOff; x <= bounds.maxX; x += brickW) {
        const [vx1, vy1] = rotatePoint(x, y, cx, cy, rad);
        const [vx2, vy2] = rotatePoint(x, y + courseH, cx, cy, rad);
        lines.push({ x1: vx1, y1: vy1, x2: vx2, y2: vy2 });
      }
      row++;
    }
    return lines;
  },
};

export const INSULATION: HatchPatternDef = {
  id: "INSULATION",
  name: "Insulation Section",
  description: "Sinusoidal wave pattern representing insulation batt fill",
  generate(bounds, scale = 1, _rotationDeg = 0) {
    const waveH = 5.0 * scale;
    const step = 1.5 * scale;
    const amp = waveH * 0.3;
    const lines: HatchLine[] = [];

    for (let y = bounds.minY; y <= bounds.maxY; y += waveH) {
      let prevX = bounds.minX;
      let prevY = y + amp * Math.sin(0);
      for (let x = bounds.minX + step; x <= bounds.maxX; x += step) {
        const phase = ((x - bounds.minX) / (waveH * 0.8)) * Math.PI * 2;
        const curY = y + amp * Math.sin(phase);
        lines.push({ x1: prevX, y1: prevY, x2: x, y2: curY });
        prevX = x;
        prevY = curY;
      }
    }
    return lines;
  },
};

// ── Registry ─────────────────────────────────────────────────────────

const patternRegistry = new Map<string, HatchPatternDef>();

export function registerPattern(pat: HatchPatternDef): void {
  patternRegistry.set(pat.id, pat);
}

export function getPattern(id: string): HatchPatternDef | undefined {
  return patternRegistry.get(id);
}

export function listPatterns(): HatchPatternDef[] {
  return Array.from(patternRegistry.values());
}

// Register built-in patterns
registerPattern(ANSI31);
registerPattern(CONCRETE);
registerPattern(EARTH);
registerPattern(BRICK);
registerPattern(INSULATION);
