/**
 * Clash Review — a dedicated floating window for fast clash navigation.
 *
 * Opens over the viewport, focuses the first clash automatically, and lets
 * you walk through every clash with:
 *
 *   ▼ Next (or ↓ / J / PageDown)
 *   ▲ Previous (or ↑ / K / PageUp)
 *   I       → isolate the current pair
 *   F       → re-focus the current pair
 *   Space   → cycle the current clash's status
 *   Esc     → close the window
 *
 * The current pair is highlighted, cropped, and (optionally) isolated in the
 * viewport every time you navigate. The cursor is fully synced with
 * clash.ts's `activeClash`, so clicking a row in the left-panel list also
 * moves the review cursor.
 */
import { inputRouter } from "../core/input-router";
import { ctx } from "../core/context";
import {
  listClashes,
  getActiveClashIndex,
  focusClashByIndex,
  isolateClashPair,
  getClashState,
  setClashStatus,
  addClashComment,
  type ClashStatus,
} from "./clash";
import type { ElementClash, ClashKind } from "./clash-engine";

/* ═════════════════════════════════════════════════════════════════════════
   Constants
   ═════════════════════════════════════════════════════════════════════════ */
const POS_KEY = "obs.clashReview.position";
const ISO_KEY = "obs.clashReview.autoIsolate";

const STATUS_ORDER: ClashStatus[] = ["new", "active", "reviewed", "approved", "resolved"];

const STATUS_COLOR: Record<ClashStatus, string> = {
  new: "#38bdf8",
  active: "#f59e0b",
  reviewed: "#c084fc",
  approved: "#22c55e",
  resolved: "#6b7280",
};

const STATUS_LABEL: Record<ClashStatus, string> = {
  new: "New",
  active: "Active",
  reviewed: "Reviewed",
  approved: "Approved",
  resolved: "Resolved",
};

const KIND_COLOR: Record<ClashKind, string> = {
  intersect: "#ef4444",
  touching: "#f59e0b",
  clearance: "#38bdf8",
  duplicate: "#a855f7",
};

/* ═════════════════════════════════════════════════════════════════════════
   State
   ═════════════════════════════════════════════════════════════════════════ */
let panel: HTMLDivElement | null = null;
let navLock = false;
let autoIsolate = true;
let pollTimer: number | null = null;
let lastRenderedIndex = -1;

try {
  const v = localStorage.getItem(ISO_KEY);
  if (v != null) autoIsolate = v === "1";
} catch { /* */ }

/* ═════════════════════════════════════════════════════════════════════════
   Utilities
   ═════════════════════════════════════════════════════════════════════════ */
const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);

function shortCat(cat: string): string {
  return cat.replace(/^IFC/i, "").replace(/STANDARDCASE$/i, "") || cat;
}

function fmtMetric(c: ElementClash): string {
  if (c.kind === "intersect") {
    const cm3 = c.depthVol * 1e6;
    if (cm3 >= 1000) return `${(cm3 / 1000).toFixed(2)} dm³ overlap`;
    return `${cm3.toFixed(1)} cm³ overlap`;
  }
  if (c.kind === "duplicate") {
    return `Identical bounding box (Δ ≤ ${(c.minGap * 1000).toFixed(1)} mm)`;
  }
  const mm = c.minGap * 1000;
  if (mm >= 1000) return `Gap ${(mm / 1000).toFixed(2)} m`;
  return `Gap ${mm.toFixed(0)} mm`;
}

/* ═════════════════════════════════════════════════════════════════════════
   Panel construction
   ═════════════════════════════════════════════════════════════════════════ */
function ensurePanel(): HTMLDivElement {
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = "obs-clash-review";
  panel.style.cssText =
    "position:fixed;z-index:8000;width:440px;max-height:82vh;display:none;" +
    "flex-direction:column;background:var(--bg-floating,#1c1e28);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:12px;" +
    "box-shadow:0 24px 60px rgba(0,0,0,.65);" +
    "font:12px system-ui,sans-serif;color:var(--text-primary,#e8eaf0);" +
    "overflow:hidden;user-select:none";
  panel.onmousedown = (e) => e.stopPropagation();

  /* Position */
  let px = 40, py = 120;
  try {
    const stored = localStorage.getItem(POS_KEY);
    if (stored) {
      const p = JSON.parse(stored);
      px = Number(p.x) || px;
      py = Number(p.y) || py;
    }
  } catch { /* */ }
  panel.style.left = `${px}px`;
  panel.style.top = `${py}px`;

  panel.innerHTML = `
    <div id="ocr-header" style="
      display:flex;align-items:center;gap:8px;padding:10px 12px;
      border-bottom:1px solid var(--border-subtle,#1e2029);
      background:var(--bg-elevated,#181a23);cursor:move;user-select:none">
      <span style="display:flex;color:var(--accent,#38bdf8);font-size:14px">◆</span>
      <div style="flex:1;font-weight:700;font-size:13px">Clash Review</div>
      <div id="ocr-count-pill" style="
        padding:2px 10px;border-radius:20px;font:600 11px var(--font-mono,monospace);
        background:var(--accent-dim,rgba(56,189,248,.14));color:var(--accent,#38bdf8)">
        0 / 0
      </div>
      <button id="ocr-close" title="Close (Esc)" style="
        padding:4px 8px;background:transparent;color:var(--text-secondary,#a0a6b5);
        border:1px solid var(--border-default,#2a2e3a);border-radius:5px;
        cursor:pointer;font-size:11px">✕</button>
    </div>

    <div id="ocr-nav" style="display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid var(--border-subtle,#1e2029)">
      <button id="ocr-prev" style="
        flex:1;padding:12px;font:700 14px system-ui;cursor:pointer;
        background:var(--bg-elevated,#181a23);color:var(--text-primary,#e8eaf0);
        border:1px solid var(--border-default,#2a2e3a);border-radius:8px;
        display:flex;align-items:center;justify-content:center;gap:8px;
        transition:background .12s">▲ Previous</button>
      <button id="ocr-next" style="
        flex:1;padding:12px;font:700 14px system-ui;cursor:pointer;
        background:var(--accent,#38bdf8);color:#0b0d12;border:none;
        border-radius:8px;display:flex;align-items:center;justify-content:center;gap:8px;
        transition:background .12s">Next ▼</button>
    </div>

    <div id="ocr-body" style="flex:1;overflow-y:auto;padding:12px"></div>

    <div id="ocr-progress" style="
      padding:8px 12px;border-top:1px solid var(--border-subtle,#1e2029);
      background:var(--bg-elevated,#181a23);display:flex;flex-direction:column;gap:6px">
      <div style="height:4px;background:var(--bg-inset,#0e1017);border-radius:2px;overflow:hidden">
        <div id="ocr-progress-bar" style="height:100%;width:0%;
          background:linear-gradient(90deg,#38bdf8,#818cf8);transition:width .2s"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;
        color:var(--text-tertiary,#6b7280);font-family:var(--font-mono,monospace)">
        <span id="ocr-progress-text">0 / 0</span>
        <span>↑↓ navigate · I isolate · F focus · Space cycle · Esc close</span>
      </div>
    </div>
  `;

  document.body.appendChild(panel);

  /* ── Wire controls ── */
  (panel.querySelector("#ocr-close") as HTMLElement).onclick = () => closeReview();
  (panel.querySelector("#ocr-prev") as HTMLElement).onclick = () => void navigate(-1);
  (panel.querySelector("#ocr-next") as HTMLElement).onclick = () => void navigate(+1);

  /* ── Draggable header ── */
  const header = panel.querySelector("#ocr-header") as HTMLElement;
  let dragging = false;
  let dragOffset = { x: 0, y: 0 };

  header.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).id === "ocr-close") return;
    dragging = true;
    const r = panel!.getBoundingClientRect();
    dragOffset = { x: e.clientX - r.left, y: e.clientY - r.top };
    (e.target as Element).setPointerCapture(e.pointerId);
    header.style.cursor = "grabbing";
  });
  header.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - dragOffset.x));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragOffset.y));
    panel!.style.left = `${x}px`;
    panel!.style.top = `${y}px`;
  });
  header.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    (e.target as Element).releasePointerCapture(e.pointerId);
    header.style.cursor = "move";
    try {
      const r = panel!.getBoundingClientRect();
      localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top }));
    } catch { /* */ }
  });

  return panel;
}

/* ═════════════════════════════════════════════════════════════════════════
   Rendering
   ═════════════════════════════════════════════════════════════════════════ */
function render(): void {
  if (!panel) return;
  const clashes = listClashes();
  const total = clashes.length;

  if (total === 0) {
    (panel.querySelector("#ocr-body") as HTMLElement).innerHTML =
      `<div style="padding:30px 20px;text-align:center;color:#6b7280;line-height:1.6">
         No clash results.<br>Run a clash test first.
       </div>`;
    (panel.querySelector("#ocr-count-pill") as HTMLElement).textContent = `0 / 0`;
    (panel.querySelector("#ocr-progress-text") as HTMLElement).textContent = `0 / 0`;
    (panel.querySelector("#ocr-progress-bar") as HTMLElement).style.width = "0%";
    return;
  }

  const idx = Math.max(0, getActiveClashIndex());
  const c = clashes[idx];
  if (!c) return;

  lastRenderedIndex = idx;

  (panel.querySelector("#ocr-count-pill") as HTMLElement).textContent =
    `${idx + 1} / ${total}`;
  (panel.querySelector("#ocr-progress-text") as HTMLElement).textContent =
    `${idx + 1} / ${total} · ${((idx + 1) / total * 100).toFixed(0)}%`;
  (panel.querySelector("#ocr-progress-bar") as HTMLElement).style.width =
    `${((idx + 1) / total) * 100}%`;

  const state = getClashState(c);
  const kindColor = KIND_COLOR[c.kind];

  const body = panel.querySelector("#ocr-body") as HTMLElement;
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px">
      <span style="background:${kindColor};color:#0f1117;padding:3px 8px;
        border-radius:4px;font-size:10px;font-weight:800;letter-spacing:.4px">
        ${c.kind.toUpperCase()}
      </span>
      <span style="font-size:10px;padding:2px 6px;border-radius:3px;
        background:rgba(255,255,255,.06);color:#94a3b8;font-family:var(--font-mono,monospace)">
        ${c.method}
      </span>
      <span style="font-size:10px;padding:2px 6px;border-radius:3px;
        background:rgba(255,255,255,.06);color:#94a3b8;font-family:var(--font-mono,monospace)">
        ${c.precision}
      </span>
    </div>

    <div style="font-size:13px;font-weight:700;color:${kindColor};margin-bottom:12px">
      ${fmtMetric(c)}
    </div>

    <div style="border:1px solid var(--border-subtle,#1e2029);border-radius:8px;
      overflow:hidden;margin-bottom:12px">
      <div style="padding:8px 10px;background:rgba(59,130,246,.10);border-bottom:1px solid var(--border-subtle,#1e2029)">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <span style="background:#3b82f6;color:#fff;padding:1px 6px;border-radius:3px;
            font-size:9px;font-weight:800">A</span>
          <span style="font-size:10px;color:#93c5fd;font-family:var(--font-mono,monospace)">
            ${esc(shortCat(c.a.cat))} · #${c.a.localId}
          </span>
        </div>
        <div style="font-weight:600;font-size:12px;line-height:1.4;word-break:break-word">
          ${esc(c.a.name)}
        </div>
      </div>
      <div style="padding:8px 10px;background:rgba(234,179,8,.10)">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <span style="background:#eab308;color:#0f1117;padding:1px 6px;border-radius:3px;
            font-size:9px;font-weight:800">B</span>
          <span style="font-size:10px;color:#fde047;font-family:var(--font-mono,monospace)">
            ${esc(shortCat(c.b.cat))} · #${c.b.localId}
          </span>
        </div>
        <div style="font-weight:600;font-size:12px;line-height:1.4;word-break:break-word">
          ${esc(c.b.name)}
        </div>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#a0a6b5">
        Status
      </label>
      <select id="ocr-status" style="flex:1;padding:5px 8px;background:var(--bg-inset,#0e1017);
        border:1px solid var(--border-default,#2a2e3a);border-radius:5px;
        color:${STATUS_COLOR[state.status]};font:600 11px system-ui;cursor:pointer">
        ${STATUS_ORDER.map((s) =>
          `<option value="${s}" ${state.status === s ? "selected" : ""}>${STATUS_LABEL[s]}</option>`
        ).join("")}
      </select>
      <button id="ocr-isolate" style="padding:5px 12px;background:var(--bg-elevated,#181a23);
        color:var(--text-primary,#e8eaf0);border:1px solid var(--border-default,#2a2e3a);
        border-radius:5px;cursor:pointer;font:600 11px system-ui">🔍 Isolate</button>
      <button id="ocr-showall" style="padding:5px 12px;background:var(--bg-elevated,#181a23);
        color:var(--text-primary,#e8eaf0);border:1px solid var(--border-default,#2a2e3a);
        border-radius:5px;cursor:pointer;font:600 11px system-ui">👁 Show all</button>
      <button id="ocr-bcf" style="padding:5px 12px;background:#2563eb;color:#fff;
        border:none;border-radius:5px;cursor:pointer;font:600 11px system-ui">📋 Create Issue</button>
    </div>

    <label style="display:flex;align-items:center;gap:6px;font-size:11px;
      color:#a0a6b5;margin-bottom:12px;cursor:pointer">
      <input type="checkbox" id="ocr-auto-iso" ${autoIsolate ? "checked" : ""}
        style="cursor:pointer;margin:0">
      Auto-isolate each clash when navigating
    </label>

    ${state.comments.length ? `
      <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;
        color:#6b7280;margin-bottom:6px">Comments (${state.comments.length})</div>
      <div style="border-left:2px solid var(--border-subtle,#1e2029);padding-left:8px;
        margin-bottom:12px;display:flex;flex-direction:column;gap:6px">
        ${state.comments.map((cm) => `
          <div style="background:var(--bg-inset,#0e1017);border-radius:5px;padding:6px 8px">
            <div style="font-size:9.5px;color:#6b7280;margin-bottom:3px">
              <b style="color:#a0a6b5">${esc(cm.author)}</b> · ${new Date(cm.date).toLocaleString()}
            </div>
            <div style="font-size:11px;line-height:1.4;word-break:break-word">${esc(cm.text)}</div>
          </div>
        `).join("")}
      </div>
    ` : ""}

    <div style="display:flex;gap:6px;margin-top:4px">
      <input id="ocr-comment-input" type="text" placeholder="Add comment…"
        style="flex:1;padding:6px 9px;background:var(--bg-inset,#0e1017);
        border:1px solid var(--border-default,#2a2e3a);border-radius:5px;
        color:var(--text-primary,#e8eaf0);font:12px system-ui">
      <button id="ocr-comment-add" style="padding:6px 14px;background:#2563eb;color:#fff;
        border:none;border-radius:5px;cursor:pointer;font:600 11px system-ui">Add</button>
    </div>
  `;

  /* ── Body event wiring ── */
  (body.querySelector("#ocr-status") as HTMLSelectElement).onchange = (e) => {
    const v = (e.target as HTMLSelectElement).value as ClashStatus;
    setClashStatus(c, v);
    render();
  };
  (body.querySelector("#ocr-isolate") as HTMLElement).onclick = async () => {
    await isolateClashPair(c);
  };
  (body.querySelector("#ocr-bcf") as HTMLElement).onclick = async () => {
    try {
      const { createIssue, captureViewpoint } = await import("../modules/issues/issues");
      
      // Capture the current view
      const vp = captureViewpoint();
      
      // Override the selection to highlight the two clashing elements
      vp.selection = {
        [c.a.modelId]: [c.a.localId],
        [c.b.modelId]: [c.b.localId]
      };

      // Create the issue
      createIssue(
        `Clash: ${c.a.name} vs ${c.b.name}`,
        `Auto-generated from Clash Detective.\n\nElement A: ${c.a.name} (${c.a.cat})\nElement B: ${c.b.name} (${c.b.cat})\nOverlap: ${c.depthVol > 0 ? (c.depthVol * 1e6).toFixed(1) + ' cm³' : (c.minGap * 1000).toFixed(1) + ' mm'}`,
        vp
      );

      // Notify the user and open the Issues panel
      window.dispatchEvent(new CustomEvent("obs-toast", {
        detail: { message: "BCF Issue created successfully", kind: "success" }
      }));

      const issuesPanel = (ctx.features as any).issuesPanel;
      if (issuesPanel && !issuesPanel.isVisible()) {
        issuesPanel.toggle();
      }
    } catch (err) {
      console.error("[clash-review] Failed to create BCF issue", err);
      alert("Failed to create BCF issue. Check the console.");
    }
  };

  (body.querySelector("#ocr-showall") as HTMLElement).onclick = async () => {
    try {
      const hider: any = (await import("../core/context")).ctx.hider;
      if (typeof hider.show === "function") await hider.show();
      else if (typeof hider.set === "function") await hider.set(true);
    } catch { /* */ }
  };
  (body.querySelector("#ocr-auto-iso") as HTMLInputElement).onchange = (e) => {
    autoIsolate = (e.target as HTMLInputElement).checked;
    try { localStorage.setItem(ISO_KEY, autoIsolate ? "1" : "0"); } catch { /* */ }
  };
  (body.querySelector("#ocr-comment-add") as HTMLElement).onclick = () => {
    const inp = body.querySelector("#ocr-comment-input") as HTMLInputElement;
    if (!inp.value.trim()) return;
    addClashComment(c, inp.value);
    inp.value = "";
    render();
  };
  (body.querySelector("#ocr-comment-input") as HTMLInputElement).onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (body.querySelector("#ocr-comment-add") as HTMLElement).click();
    }
    e.stopPropagation();
  };
}

/* ═════════════════════════════════════════════════════════════════════════
   Navigation
   ═════════════════════════════════════════════════════════════════════════ */
async function navigate(delta: number): Promise<void> {
  if (navLock) return;
  const clashes = listClashes();
  if (!clashes.length) return;

  navLock = true;
  try {
    const idx = Math.max(0, getActiveClashIndex());
    const next = ((idx + delta) % clashes.length + clashes.length) % clashes.length;
    await focusClashByIndex(next);

    const c = clashes[next];
    if (autoIsolate && c) {
      try { await isolateClashPair(c); } catch { /* */ }
    }
    render();
  } catch (err) {
    console.warn("[clash-review] navigate failed", err);
  } finally {
    navLock = false;
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Keyboard
   ═════════════════════════════════════════════════════════════════════════ */
function isOpen(): boolean {
  return !!panel && panel.style.display === "flex";
}

function onKeyDown(e: KeyboardEvent): void {
  if (!isOpen()) return;

  // Don't steal keys while typing.
  const t = e.target as HTMLElement | null;
  if (t) {
    const tag = t.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || t.isContentEditable) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        (t as HTMLElement).blur();
        closeReview();
      }
      return;
    }
  }

  const k = e.key.toLowerCase();

  if (k === "escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeReview();
    return;
  }
  if (k === "arrowdown" || k === "j" || k === "pagedown") {
    e.preventDefault();
    e.stopImmediatePropagation();
    void navigate(+1);
    return;
  }
  if (k === "arrowup" || k === "k" || k === "pageup") {
    e.preventDefault();
    e.stopImmediatePropagation();
    void navigate(-1);
    return;
  }
  if (k === "i") {
    e.preventDefault();
    e.stopImmediatePropagation();
    const c = listClashes()[getActiveClashIndex()];
    if (c) void isolateClashPair(c);
    return;
  }
  if (k === "f") {
    e.preventDefault();
    e.stopImmediatePropagation();
    const idx = Math.max(0, getActiveClashIndex());
    void focusClashByIndex(idx);
    return;
  }
  if (k === " ") {
    e.preventDefault();
    e.stopImmediatePropagation();
    const c = listClashes()[getActiveClashIndex()];
    if (c) {
      const s = getClashState(c);
      const i = STATUS_ORDER.indexOf(s.status);
      const next = STATUS_ORDER[(i + 1) % STATUS_ORDER.length];
      setClashStatus(c, next);
      render();
    }
    return;
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Public API
   ═════════════════════════════════════════════════════════════════════════ */
export function openReview(): void {
  ensurePanel();
  if (!panel) return;
  panel.style.display = "flex";

  // Focus the first clash if nothing is active yet.
  if (getActiveClashIndex() < 0 && listClashes().length) {
    void focusClashByIndex(0).then(() => {
      const c = listClashes()[0];
      if (autoIsolate && c) void isolateClashPair(c).catch(() => {});
      render();
    });
  } else {
    render();
  }

  // Poll for changes to activeClash coming from elsewhere (left-panel list).
  if (pollTimer == null) {
    pollTimer = window.setInterval(() => {
      if (!isOpen()) return;
      const idx = getActiveClashIndex();
      if (idx !== lastRenderedIndex) render();
    }, 300);
  }
}

export function closeReview(): void {
  if (panel) panel.style.display = "none";
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function toggleReview(): void {
  isOpen() ? closeReview() : openReview();
}

export function isReviewVisible(): boolean {
  return isOpen();
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup
   ═════════════════════════════════════════════════════════════════════════ */
export function setupClashReview(): void {
  // Escape goes through the input-router cancel stack (LIFO, first-consume-wins).
  const unsubCancel = inputRouter.registerCancel(() => {
    if (!isOpen()) return false;
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      active.blur();
    }
    closeReview();
    return true;
  });

  // Remaining navigation keys stay local — they only act when the review
  // panel is open, so they don't conflict with the router.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return; // owned by registerCancel
    onKeyDown(e);
  }, true);

  // Expose for the panel button and shortcuts.
  (window as any).__obs_openClashReview = openReview;
  (window as any).__obs_closeClashReview = closeReview;
  (window as any).__obs_toggleClashReview = toggleReview;

  (ctx.features as any).clashReview = { dispose: unsubCancel };

  console.log("[clash-review] ready");
}