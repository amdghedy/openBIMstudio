import { ctx } from "../core/context";

type Any = Record<string, any>;

function getAuthoring(): Any | null {
  const c = ctx as Any;
  return (c.features as Any)?.authoring as Any ?? (window as Any).__obsAuthoring ?? null;
}

function getElements(): Any[] {
  const a = getAuthoring();

  if (!a) {
    return [];
  }

  if (typeof a.getElements === "function") {
    try {
      return a.getElements() ?? [];
    } catch {
      return [];
    }
  }

  if (Array.isArray(a.elements)) {
    return a.elements;
  }

  return [];
}

function pair(v: Any): [number, number] | null {
  if (Array.isArray(v) && v.length >= 2) {
    return [Number(v[0]), Number(v[1])];
  }

  if (v && typeof v === "object") {
    if ("x" in v && "z" in v) {
      return [Number(v.x), Number(v.z)];
    }

    if ("x" in v && "y" in v) {
      return [Number(v.x), Number(v.y)];
    }
  }

  return null;
}

function refreshDownstream(): void {
  // hosted-openings: data-only refresh
  // 3D openings come from authoring.openingsForWall() at read time; this data
  // layer only refreshes schedules / cost / IFC events. It must NOT rebuild
  // geometry, or it races the placement commit (hollow wall / floating door).
  try {
    (window as Any).__obsProjects?.markDirty?.();
  } catch {
    // ignore
  }
  try {
    (window as Any).__obsSchedules?.refresh?.();
  } catch {
    // ignore
  }
  try {
    (window as Any).__obsCost?.refresh?.();
  } catch {
    // ignore
  }

  try {
    window.dispatchEvent(new CustomEvent("obs:authoring-changed", {
      detail: { reason: "hosted-openings" },
    }));

    window.dispatchEvent(new CustomEvent("obs:schedule-refresh"));
    window.dispatchEvent(new CustomEvent("obs:cost-refresh"));
    window.dispatchEvent(new CustomEvent("obs:ifc-export-refresh"));
  } catch {
    // ignore
  }
}

export function recomputeHostedOpenings(): number {
  const elements = getElements();

  if (!elements.length) {
    return 0;
  }

  const hosts = new Map<string, Any>();

  for (const el of elements) {
    if (!el || !el.id || !el.params) {
      continue;
    }

    const t = String(el.type ?? "");

    if (
      (t === "wall" || t === "beam" || t === "line" || t === "mline") &&
      el.params.start &&
      el.params.end
    ) {
      hosts.set(String(el.id), el);
    }
  }

  const derivedByHost = new Map<string, Any[]>();

  for (const el of elements) {
    if (!el || !el.hostId || !el.params) {
      continue;
    }

    const t = String(el.type ?? "");

    if (
      t !== "door" &&
      t !== "window" &&
      t !== "opening" &&
      t !== "fitting"
    ) {
      continue;
    }

    const host = hosts.get(String(el.hostId));

    if (!host || !host.params) {
      continue;
    }

    const start = pair(host.params.start);
    const end = pair(host.params.end);

    if (!start || !end) {
      continue;
    }

    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const L = Math.hypot(dx, dz);

    if (!Number.isFinite(L) || L < 0.05) {
      continue;
    }

    const p = el.params as Any;
    const width = Number(p.width ?? 0.9);
    const height = Number(p.height ?? 2.1);
    const sill = Number(p.sill ?? 0);
    const offset = Number(p.offsetAlongHost ?? L / 2);
    const half = width / 2;

    const clamped = Math.max(
      Math.min(half, L / 2),
      Math.min(Math.max(L - half, L / 2), offset),
    );

    const op = {
      offset: Math.round(clamped * 1000) / 1000,
      width: Math.round(width * 1000) / 1000,
      height: Math.round(height * 1000) / 1000,
      sill: Math.round(sill * 1000) / 1000,
      hosted: true,
      hostElement: String(el.id),
      kind: t,
    };

    const list = derivedByHost.get(String(host.id)) ?? [];
    list.push(op);
    derivedByHost.set(String(host.id), list);
  }

  let changed = 0;

  for (const [hostId, derived] of derivedByHost.entries()) {
    const host = hosts.get(hostId);

    if (!host || !host.params) {
      continue;
    }

    const existing = Array.isArray(host.params.openings)
      ? host.params.openings
      : [];

    const manual = existing.filter((op: Any) => !op?.hosted);
    const next = [...manual, ...derived].sort(
      (a: Any, b: Any) => Number(a.offset ?? 0) - Number(b.offset ?? 0),
    );

    const before = JSON.stringify(existing);
    const after = JSON.stringify(next);

    if (before !== after) {
      host.params.openings = next;
      changed++;
    }
  }

  if (changed) {
    refreshDownstream();
  }

  return changed;
}

export function setupHostedOpenings(): void {
  (window as Any).__obsRecomputeHostedOpenings = recomputeHostedOpenings;
  console.log("[hosted-openings] ready");
}