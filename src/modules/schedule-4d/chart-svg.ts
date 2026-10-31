/** Large dual-axis S-curve chart (5D cost + 6D carbon) as an SVG string. Pure. */
export interface Pt { t: number; value: number }
export interface ChartOpts { width: number; height: number; nowMs: number | null; costLabel: string; carbonLabel: string }

const fmt = (n: number) => (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(0) + "k" : n.toFixed(0));
const d10 = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function chartGeometry(o: ChartOpts) {
  const m = { l: 64, r: 64, t: 18, b: 34 };
  return { m, iw: o.width - m.l - m.r, ih: o.height - m.t - m.b };
}

/** Time (epoch ms) under an x pixel of the chart; clamps to the plot area. */
export function timeAtX(x: number, t0: number, t1: number, o: ChartOpts): number {
  const { m, iw } = chartGeometry(o);
  const f = Math.max(0, Math.min(1, (x - m.l) / iw));
  return t0 + f * (t1 - t0);
}

export function scurveSvg(cost: Pt[], carbon: Pt[], o: ChartOpts): string {
  const base = cost.length >= 2 ? cost : carbon;
  if (base.length < 2) return `<svg viewBox="0 0 ${o.width} ${o.height}" width="100%" height="100%"><text x="20" y="30" fill="#94a3b8">No cost or carbon data yet.</text></svg>`;
  const { m, iw, ih } = chartGeometry(o);
  const t0 = base[0].t, t1 = base[base.length - 1].t, span = Math.max(1, t1 - t0);
  const cmax = Math.max(1e-9, ...cost.map((p) => p.value)), kmax = Math.max(1e-9, ...carbon.map((p) => p.value));
  const X = (t: number) => m.l + ((t - t0) / span) * iw;
  const path = (pts: Pt[], vmax: number) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${(m.t + ih - (p.value / vmax) * ih).toFixed(1)}`).join("");
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const y = m.t + (ih * i) / 4;
    g += `<line x1="${m.l}" x2="${m.l + iw}" y1="${y}" y2="${y}" stroke="#1e293b"/>`;
    g += `<text x="${m.l - 6}" y="${y + 4}" text-anchor="end" fill="#22c55e" font-size="11">${fmt(cmax * (1 - i / 4))}</text>`;
    g += `<text x="${m.l + iw + 6}" y="${y + 4}" fill="#f97316" font-size="11">${fmt(kmax * (1 - i / 4))}</text>`;
  }
  for (let i = 0; i <= 5; i++) {
    const t = t0 + (span * i) / 5, x = X(t);
    g += `<line x1="${x}" x2="${x}" y1="${m.t}" y2="${m.t + ih}" stroke="#1e293b"/><text x="${x}" y="${m.t + ih + 18}" text-anchor="middle" fill="#94a3b8" font-size="11">${d10(t)}</text>`;
  }
  const now = o.nowMs == null ? "" : `<line x1="${X(Math.max(t0, Math.min(t1, o.nowMs)))}" x2="${X(Math.max(t0, Math.min(t1, o.nowMs)))}" y1="${m.t}" y2="${m.t + ih}" stroke="#fbbf24" stroke-width="2"/>`;
  return `<svg viewBox="0 0 ${o.width} ${o.height}" width="100%" height="100%" data-t0="${t0}" data-t1="${t1}" font-family="system-ui,sans-serif">
    <rect width="${o.width}" height="${o.height}" fill="#0b1220"/>${g}
    ${cost.length >= 2 ? `<path d="${path(cost, cmax)}" fill="none" stroke="#22c55e" stroke-width="2.4"/>` : ""}
    ${carbon.length >= 2 ? `<path d="${path(carbon, kmax)}" fill="none" stroke="#f97316" stroke-width="2.4"/>` : ""}
    ${now}
    <text x="${m.l}" y="12" fill="#22c55e" font-size="12">● ${o.costLabel} (left)</text>
    <text x="${m.l + 220}" y="12" fill="#f97316" font-size="12">● ${o.carbonLabel} (right)</text></svg>`;
}
