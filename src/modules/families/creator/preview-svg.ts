// Free family creator, slice 2: three-view outline drawing of the parts.
//
// Pure function: resolved parts in, SVG text out. No WebGL, no DOM. Front is
// X by Y (width by height), side is Z by Y (depth by height), top is X by Z.
// It draws what the engine resolved, so it shows a change as soon as a
// parameter changes.

import type { ResolvedPart } from "./layout";

interface Box { x0: number; x1: number; y0: number; y1: number }

function partBoxes(p: ResolvedPart): { x: [number, number]; y: [number, number]; z: [number, number] } {
  const hx = p.shape === "cylinder" ? p.r : p.w / 2;
  const hz = p.shape === "cylinder" ? p.r : p.d / 2;
  return { x: [p.cx - hx, p.cx + hx], y: [p.cy - p.h / 2, p.cy + p.h / 2], z: [p.cz - hz, p.cz + hz] };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);

export function renderThreeViews(
  parts: ResolvedPart[],
  dims: { w: number; d: number; h: number },
  titles: { front: string; side: string; top: string } = { front: "Front", side: "Side", top: "Top" },
): string {
  const W = 360, H = 190, pad = 22;
  const scale = Math.min((W / 3 - pad) / Math.max(dims.w, dims.d), (H - 2 * pad) / dims.h);
  const views: Array<{ title: string; wm: number; hm: number; pick: (b: ReturnType<typeof partBoxes>) => Box }> = [
    { title: titles.front, wm: dims.w, hm: dims.h, pick: (b) => ({ x0: b.x[0], x1: b.x[1], y0: b.y[0], y1: b.y[1] }) },
    { title: titles.side, wm: dims.d, hm: dims.h, pick: (b) => ({ x0: b.z[0], x1: b.z[1], y0: b.y[0], y1: b.y[1] }) },
    { title: titles.top, wm: dims.w, hm: dims.d, pick: (b) => ({ x0: b.x[0], x1: b.x[1], y0: b.z[0], y1: b.z[1] }) },
  ];
  const cell = W / 3;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Front, side and top views">`;
  views.forEach((v, i) => {
    const ox = i * cell + cell / 2, oy = H - pad;
    const flipY = i !== 2;
    out += `<text x="${ox}" y="12" fill="#94a3b8" font-size="10" text-anchor="middle">${esc(v.title)}</text>`;
    for (const p of parts) {
      const b = v.pick(partBoxes(p));
      const x = ox + b.x0 * scale, w = (b.x1 - b.x0) * scale;
      const h = (b.y1 - b.y0) * scale;
      const y = flipY ? oy - b.y1 * scale : (H - pad - v.hm * scale) + (b.y0 + v.hm / 2) * scale;
      const cls = p.shape === "cylinder" ? "#f59e0b" : "#60a5fa";
      out += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${cls}" fill-opacity="0.25" stroke="${cls}" stroke-width="1"><title>${esc(p.name)}</title></rect>`;
    }
  });
  return out + "</svg>";
}
