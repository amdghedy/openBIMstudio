/**
 * AutoCAD Color Index (ACI) -> RGB.
 *
 * Indices 1-9 are the named colours, 10-249 are 24 hues x 10 shade/tint
 * steps, 250-255 are greys. Index 7 is "white or black" depending on the
 * background, so callers pass `foreground` for it.
 */

const NAMED: Record<number, number> = {
  1: 0xff0000,
  2: 0xffff00,
  3: 0x00ff00,
  4: 0x00ffff,
  5: 0x0000ff,
  6: 0xff00ff,
  8: 0x808080,
  9: 0xc0c0c0,
};

const GREYS = [0x333333, 0x505050, 0x696969, 0x828282, 0xbfbfbf, 0xffffff];

// Per-hue pattern of 10 steps: value and saturation.
const VALUE = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3];
const SAT = [1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5];

function hsv(h: number, s: number, v: number): number {
  const c = v * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = v - c;
  const to = (n: number) => Math.round((n + m) * 255);
  return (to(r) << 16) | (to(g) << 8) | to(b);
}

/** ACI index to 0xRRGGBB. `foreground` is used for index 7. */
export function aciToRgb(aci: number, foreground = 0xffffff): number {
  const i = Math.round(aci);
  if (i === 7) return foreground;
  if (NAMED[i] != null) return NAMED[i];
  if (i >= 10 && i <= 249) {
    const hue = Math.floor((i - 10) / 10) * 15;
    const k = (i - 10) % 10;
    return hsv(hue, SAT[k], VALUE[k]);
  }
  if (i >= 250 && i <= 255) return GREYS[i - 250];
  return foreground;
}

export function rgbToCss(rgb: number): string {
  return "#" + (rgb & 0xffffff).toString(16).padStart(6, "0");
}
