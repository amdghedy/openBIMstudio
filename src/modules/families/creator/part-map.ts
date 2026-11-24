/**
 * Match the nodes of a built preview object to the template's resolved parts.
 * The match is by order and is only accepted when every node sits exactly at its
 * part's centre. Anything else returns a reason, so callers can refuse instead
 * of hiding or exporting the wrong subset.
 */
export interface MapPart { name: string; cx: number; cy: number; cz: number }
export interface MapNode { position: { x: number; y: number; z: number } }

export type PartMapResult =
  | { ok: true; nodes: number }
  | { ok: false; reason: "count" | "position"; detail: string };

export function checkPartMap(nodes: MapNode[], parts: MapPart[], tol = 1e-6): PartMapResult {
  if (nodes.length !== parts.length) return { ok: false, reason: "count", detail: `${nodes.length} nodes, ${parts.length} parts` };
  for (let i = 0; i < parts.length; i++) {
    const k = nodes[i].position, q = parts[i];
    if (Math.hypot(k.x - q.cx, k.y - q.cy, k.z - q.cz) >= tol) return { ok: false, reason: "position", detail: q.name };
  }
  return { ok: true, nodes: nodes.length };
}
