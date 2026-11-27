// new.family parity Phase 1, Item 1 — Family Gallery.
//
// A card-grid view over the REAL family store (seed catalog + built-ins
// + user families), mirroring new.family's Gallery: search, group /
// category / hosting filters, sort, Show-more pagination, a status badge
// and a local upvote per card. Cards open the family in the Family
// Browser (detail + Place), via openFamilyBrowserWithFamily.
//
// Honesty notes (see also modules/families/gallery.ts):
// - Hosting is derived (door/window = Wall, else Unhosted); no Face /
//   Ceiling / Floor hosting is shown because no family carries it.
// - "Ready" means placeable in openBIMstudio (geometry + >=1 type).
//   It is NOT a Revit / .rfa claim — the badge tooltip says so.
// - Sort offers only fields that exist (name / group / type count /
//   parameter count). No download-count or creation-date sort exists,
//   because the store carries neither.
// - Upvotes are this browser only (localStorage), 1 or 0 — never a
//   community total.
// - Card thumbnails are a real isometric wireframe of the family's
//   built geometry (same projection as the Browser preview), not a
//   stock image. A family whose geometry fails to build shows
//   "(no preview)" instead of a fake render.

import { ctx } from "../core/context";
import { setupFamilies, isFamilySystemReady } from "../modules/families";
import type { FamilyDefinition, FamilyService } from "../modules/families";
import {
  EMPTY_GALLERY_FILTERS,
  GALLERY_PAGE_SIZE,
  GALLERY_UPVOTES_KEY,
  createGalleryUpvotes,
  deriveHosting,
  filterGalleryFamilies,
  galleryStatus,
  paginateGalleryFamilies,
  sortGalleryFamilies,
  type GallerySort,
  type GalleryUpvotes,
} from "../modules/families/gallery";
import { buildFamilyConnectorPreviewLayout } from "../modules/families/connector-preview";
import { openFamilyBrowserWithFamily } from "./family-browser";

const PANEL_ID = "obs-family-gallery";
const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------------
// Panel shell (fixed centred overlay — not docked, so it never fights the
// Family Browser for the right dock; opening a family closes it first).
// ---------------------------------------------------------------------------
const panel = document.createElement("div");
panel.id = PANEL_ID;
panel.style.cssText =
  "display:none;flex-direction:column;position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);" +
  "width:min(980px,94vw);max-height:88vh;z-index:8700;" +
  "background:var(--bg-floating,#1c1e28);border:1px solid var(--border-default,#2a2e3a);border-radius:12px;" +
  "box-shadow:0 24px 70px rgba(0,0,0,.65);color:var(--text-primary,#e8eaf0);" +
  "font:12px system-ui,sans-serif;overflow:hidden";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:8px;padding:10px 12px;" +
  "border-bottom:1px solid var(--border-subtle,#1e2029);background:var(--bg-elevated,#181a23)";

const title = document.createElement("div");
title.textContent = "Family Gallery";
title.style.cssText = "font-weight:700;flex:1;letter-spacing:.2px;font-size:13px";

const countLabel = document.createElement("div");
countLabel.style.cssText = "font:11px ui-monospace,monospace;color:#94a3b8";

const closeBtn = document.createElement("button");
closeBtn.type = "button";
closeBtn.textContent = "✕";
closeBtn.title = "Close gallery (Esc)";
closeBtn.style.cssText =
  "padding:3px 9px;background:transparent;color:var(--text-secondary,#a0a6b5);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:5px;cursor:pointer;font:11px system-ui";
closeBtn.onclick = () => closeFamilyGallery();
header.append(title, countLabel, closeBtn);

// --- Toolbar ---------------------------------------------------------------
const toolbar = document.createElement("div");
toolbar.style.cssText =
  "display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;" +
  "border-bottom:1px solid var(--border-subtle,#1e2029);background:var(--bg-inset,#0e1017)";

const searchInput = document.createElement("input");
searchInput.type = "text";
searchInput.placeholder = "Search gallery — name, group, category, IFC, type…";
searchInput.setAttribute("aria-label", "Search gallery");
searchInput.style.cssText =
  "flex:1;min-width:180px;padding:5px 9px;background:#0f1118;border:1px solid var(--border-default,#2a2e3a);" +
  "border-radius:5px;color:var(--text-primary,#e8eaf0);font:11.5px system-ui;outline:none";

function mkSelect(titleText: string): HTMLSelectElement {
  const s = document.createElement("select");
  s.title = titleText;
  s.style.cssText =
    "padding:5px 8px;background:#0f1118;border:1px solid var(--border-default,#2a2e3a);" +
    "border-radius:5px;color:var(--text-primary,#e8eaf0);font:11px system-ui;cursor:pointer";
  return s;
}
const groupFilter = mkSelect("Filter by group");
const categoryFilter = mkSelect("Filter by category");
const hostingFilter = mkSelect("Filter by hosting");
const sortSelect = mkSelect("Sort gallery");
sortSelect.innerHTML =
  `<option value="name">Sort: Name A–Z</option>` +
  `<option value="group">Sort: Group</option>` +
  `<option value="types">Sort: Most types</option>` +
  `<option value="parameters">Sort: Most parameters</option>`;

const readyOnlyLabel = document.createElement("label");
readyOnlyLabel.style.cssText =
  "display:flex;align-items:center;gap:5px;color:#94a3b8;font-size:11px;cursor:pointer;white-space:nowrap";
const readyOnlyBox = document.createElement("input");
readyOnlyBox.type = "checkbox";
readyOnlyBox.title = "Show only families ready to place";
const readyOnlyText = document.createElement("span");
readyOnlyText.textContent = "Ready only";
readyOnlyLabel.append(readyOnlyBox, readyOnlyText);

toolbar.append(searchInput, groupFilter, categoryFilter, hostingFilter, sortSelect, readyOnlyLabel);

// --- Grid ------------------------------------------------------------------
const grid = document.createElement("div");
grid.style.cssText =
  "flex:1;min-height:0;overflow-y:auto;padding:10px;" +
  "display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;align-content:start";

const emptyMsg = document.createElement("div");
emptyMsg.textContent = "No families match these filters.";
emptyMsg.style.cssText = "padding:24px;color:#6b7280;font-size:12px;text-align:center;grid-column:1/-1";

// --- Footer ----------------------------------------------------------------
const footer = document.createElement("div");
footer.style.cssText =
  "display:flex;align-items:center;gap:10px;padding:9px 12px;" +
  "border-top:1px solid var(--border-subtle,#1e2029);background:var(--bg-elevated,#181a23)";

const showingLabel = document.createElement("div");
showingLabel.style.cssText = "flex:1;font:11px ui-monospace,monospace;color:#94a3b8";

const showMoreBtn = document.createElement("button");
showMoreBtn.type = "button";
showMoreBtn.textContent = "Show more";
showMoreBtn.style.cssText =
  "padding:6px 16px;background:var(--bg-elevated,#181a23);color:var(--text-primary,#e8eaf0);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:6px;cursor:pointer;font:600 11.5px system-ui";
showMoreBtn.onclick = () => {
  visibleCount += GALLERY_PAGE_SIZE;
  render();
};
footer.append(showingLabel, showMoreBtn);

panel.append(header, toolbar, grid, footer);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let visible = false;
let installed = false;
let searchQuery = "";
let groupValue = "all";
let categoryValue = "all";
let hostingValue = "all";
let readyOnly = false;
let sortValue: GallerySort = "name";
let visibleCount = GALLERY_PAGE_SIZE;

function galleryUpvotes(): GalleryUpvotes {
  // localStorage may be unavailable (private mode, quota) — fall back
  // to an in-memory store so the Gallery still works this session.
  try {
    const storage = {
      getItem: (k: string) => window.localStorage.getItem(k),
      setItem: (k: string, v: string) => window.localStorage.setItem(k, v),
    };
    // Probe once: a throwing getItem must not break the panel.
    storage.getItem(GALLERY_UPVOTES_KEY);
    return createGalleryUpvotes(storage);
  } catch {
    const mem = new Map<string, string>();
    return createGalleryUpvotes({
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => { mem.set(k, v); },
    });
  }
}
let upvotes: GalleryUpvotes | null = null;

function svc(): FamilyService | null {
  const s = (ctx.features as any).family as FamilyService | undefined;
  return s ?? null;
}

function currentFamilies(): FamilyDefinition[] {
  const s = svc();
  if (!s) return [];
  const filtered = filterGalleryFamilies(s.list(), {
    ...EMPTY_GALLERY_FILTERS,
    query: searchQuery,
    group: groupValue,
    category: categoryValue,
    hosting: hostingValue,
    readyOnly,
  });
  return sortGalleryFamilies(filtered, sortValue);
}

function rebuildFilterOptions(list: FamilyDefinition[]): void {
  const groups = [...new Set(list.map((f) => f.group ?? "").filter(Boolean))].sort();
  const categories = [...new Set(list.map((f) => f.category))].sort();
  const setOptions = (sel: HTMLSelectElement, allLabel: string, values: string[], cur: string) => {
    const prev = sel.value || cur;
    sel.innerHTML =
      `<option value="all">${allLabel}</option>` +
      values.map((v) => `<option value="${v}">${v}</option>`).join("");
    sel.value = values.includes(prev) ? prev : "all";
  };
  setOptions(groupFilter, "All groups", groups, groupValue);
  setOptions(categoryFilter, "All categories", categories, categoryValue);
  groupValue = groupFilter.value;
  categoryValue = categoryFilter.value;
  const hostPrev = hostingFilter.value || hostingValue;
  hostingFilter.innerHTML =
    `<option value="all">All hosting</option>` +
    `<option value="Wall">Wall-hosted</option>` +
    `<option value="Unhosted">Unhosted</option>`;
  hostingFilter.value = ["all", "Wall", "Unhosted"].includes(hostPrev) ? hostPrev : "all";
  hostingValue = hostingFilter.value;
}

// --- Card thumbnail: real isometric wireframe of the built geometry --------
function buildThumbnail(fam: FamilyDefinition): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "height:110px;display:flex;align-items:center;justify-content:center;" +
    "background:#0b0d12;border-bottom:1px solid #1e2029;overflow:hidden";
  const s = svc();
  try {
    const obj = s?.buildGeometry(fam.id, fam.types[0]?.id ?? null);
    const layout = obj ? buildFamilyConnectorPreviewLayout(obj, [], 200, 110, 10) : null;
    if (!layout) throw new Error("no layout");
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("xmlns", SVG_NS);
    svg.setAttribute("viewBox", "0 0 200 110");
    svg.setAttribute("width", "200");
    svg.setAttribute("height", "110");
    svg.style.cssText = "display:block;max-width:100%";
    const edges: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    for (const [a, b] of edges) {
      const pa = layout.geometryCorners[a];
      const pb = layout.geometryCorners[b];
      if (!pa || !pb) continue;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", pa.x.toFixed(2));
      line.setAttribute("y1", pa.y.toFixed(2));
      line.setAttribute("x2", pb.x.toFixed(2));
      line.setAttribute("y2", pb.y.toFixed(2));
      line.setAttribute("stroke", "#38bdf8");
      line.setAttribute("stroke-width", "1.2");
      line.setAttribute("stroke-linecap", "round");
      svg.appendChild(line);
    }
    wrap.appendChild(svg);
  } catch {
    const em = document.createElement("div");
    em.textContent = "(no preview)";
    em.style.cssText = "color:#6b7280;font-size:11px";
    wrap.appendChild(em);
  }
  return wrap;
}

function badge(text: string, bg: string, fg: string, titleText?: string): HTMLElement {
  const b = document.createElement("span");
  b.textContent = text;
  if (titleText) b.title = titleText;
  b.style.cssText =
    "font:600 9.5px ui-monospace,monospace;letter-spacing:.4px;text-transform:uppercase;" +
    `padding:2px 6px;border-radius:3px;background:${bg};color:${fg}`;
  return b;
}

function render(): void {
  const s = svc();
  const all = s ? s.list() : [];
  rebuildFilterOptions(all);
  const filtered = currentFamilies();
  const page = paginateGalleryFamilies(filtered, visibleCount);
  const seedCount = all.filter((f) => f.origin === "seed-catalog").length;

  countLabel.textContent = `${all.length} families · ${seedCount} from the seed catalog`;
  showingLabel.textContent = `Showing ${page.shown.length} of ${page.total} families`;
  showMoreBtn.disabled = !page.hasMore;
  showMoreBtn.style.opacity = page.hasMore ? "1" : "0.45";
  showMoreBtn.style.cursor = page.hasMore ? "pointer" : "default";

  grid.innerHTML = "";
  if (!page.shown.length) {
    grid.appendChild(emptyMsg);
    return;
  }
  if (!upvotes) upvotes = galleryUpvotes();
  const votes = upvotes;
  for (const fam of page.shown) {
    const card = document.createElement("div");
    card.dataset.familyId = fam.id;
    card.style.cssText =
      "border:1px solid var(--border-default,#2a2e3a);border-radius:8px;overflow:hidden;" +
      "background:#11141d;cursor:pointer;display:flex;flex-direction:column";
    card.onmouseenter = () => { card.style.borderColor = "#38bdf8"; };
    card.onmouseleave = () => { card.style.borderColor = "var(--border-default,#2a2e3a)"; };
    card.onclick = () => openFamily(fam.id);

    card.appendChild(buildThumbnail(fam));

    const body = document.createElement("div");
    body.style.cssText = "padding:8px 10px;display:flex;flex-direction:column;gap:4px;flex:1";

    const name = document.createElement("div");
    name.textContent = fam.name;
    name.style.cssText = "font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    body.appendChild(name);

    const meta = document.createElement("div");
    meta.textContent = `${fam.group ?? "—"} · ${fam.category}`;
    meta.style.cssText = "font-size:10.5px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    body.appendChild(meta);

    const badges = document.createElement("div");
    badges.style.cssText = "display:flex;gap:4px;flex-wrap:wrap";
    const hosting = deriveHosting(fam);
    badges.appendChild(badge(
      hosting === "Wall" ? "Wall-hosted" : "Unhosted",
      "rgba(148,163,184,.14)", "#cbd5e1",
    ));
    const status = galleryStatus(fam);
    badges.appendChild(badge(
      status === "Ready" ? "Ready" : "Draft",
      status === "Ready" ? "rgba(52,211,153,.14)" : "rgba(251,191,36,.14)",
      status === "Ready" ? "#6ee7b7" : "#fcd34d",
      status === "Ready"
        ? "Ready to place in openBIMstudio — not a Revit .rfa"
        : "Draft — needs geometry and at least one type before it can be placed",
    ));
    body.appendChild(badges);

    const stats = document.createElement("div");
    stats.textContent =
      `${fam.types.length} type${fam.types.length === 1 ? "" : "s"} · ` +
      `${fam.parameters.length} parameter${fam.parameters.length === 1 ? "" : "s"}`;
    stats.style.cssText = "font:10.5px ui-monospace,monospace;color:#64748b";
    body.appendChild(stats);

    const foot = document.createElement("div");
    foot.style.cssText = "display:flex;gap:6px;margin-top:auto;padding-top:4px";

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.title = "Upvote — saved in this browser only";
    upBtn.setAttribute("aria-pressed", String(votes.isUpvoted(fam.id)));
    const paintUp = () => {
      upBtn.textContent = `↑ ${votes.count(fam.id)}`;
      upBtn.setAttribute("aria-pressed", String(votes.isUpvoted(fam.id)));
      upBtn.style.background = votes.isUpvoted(fam.id)
        ? "rgba(56,189,248,.18)" : "transparent";
    };
    upBtn.style.cssText =
      "flex:1;padding:4px 8px;color:#7dd3fc;border:1px solid var(--border-default,#2a2e3a);" +
      "border-radius:5px;cursor:pointer;font:600 11px system-ui";
    paintUp();
    upBtn.onclick = (e) => {
      e.stopPropagation();
      votes.toggle(fam.id);
      paintUp();
    };

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = "Open";
    openBtn.style.cssText =
      "flex:1;padding:4px 8px;background:var(--bg-elevated,#181a23);color:var(--text-primary,#e8eaf0);" +
      "border:1px solid var(--border-default,#2a2e3a);border-radius:5px;cursor:pointer;font:600 11px system-ui";
    openBtn.onclick = (e) => {
      e.stopPropagation();
      openFamily(fam.id);
    };

    foot.append(upBtn, openBtn);
    body.appendChild(foot);
    card.appendChild(body);
    grid.appendChild(card);
  }
}

/** Close the Gallery and open the family in the Family Browser. */
function openFamily(familyId: string): void {
  closeFamilyGallery();
  try {
    openFamilyBrowserWithFamily(familyId);
  } catch (err) {
    console.warn("[family-gallery] could not open family in browser", err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function openFamilyGallery(): void {
  if (!isFamilySystemReady()) {
    try { setupFamilies(); } catch (err) { console.warn("[family-gallery] boot failed", err); }
  }
  if (!panel.parentElement) document.body.appendChild(panel);
  visible = true;
  panel.style.display = "flex";
  render();
}

export function closeFamilyGallery(): void {
  visible = false;
  panel.style.display = "none";
}

export function toggleFamilyGallery(): void {
  visible ? closeFamilyGallery() : openFamilyGallery();
}

export function isFamilyGalleryVisible(): boolean {
  return visible;
}

export function setupFamilyGallery(): void {
  if (installed) return;
  installed = true;

  if (!isFamilySystemReady()) {
    try { setupFamilies(); } catch (err) { console.warn("[family-gallery] boot failed", err); }
  }

  const api = {
    open: openFamilyGallery,
    close: closeFamilyGallery,
    toggle: toggleFamilyGallery,
    isVisible: isFamilyGalleryVisible,
    render,
  };
  (ctx.features as any).familyGallery = api;
  (window as any).__obsFamilyGallery = api;

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    visibleCount = GALLERY_PAGE_SIZE;
    render();
  });
  groupFilter.addEventListener("change", () => {
    groupValue = groupFilter.value;
    visibleCount = GALLERY_PAGE_SIZE;
    render();
  });
  categoryFilter.addEventListener("change", () => {
    categoryValue = categoryFilter.value;
    visibleCount = GALLERY_PAGE_SIZE;
    render();
  });
  hostingFilter.addEventListener("change", () => {
    hostingValue = hostingFilter.value;
    visibleCount = GALLERY_PAGE_SIZE;
    render();
  });
  sortSelect.addEventListener("change", () => {
    sortValue = sortSelect.value as GallerySort;
    render();
  });
  readyOnlyBox.addEventListener("change", () => {
    readyOnly = readyOnlyBox.checked;
    visibleCount = GALLERY_PAGE_SIZE;
    render();
  });

  // A save in the Family Creator (or any store change) refreshes the
  // open Gallery live; filters and the page are preserved.
  try {
    svc()?.onChange?.(() => {
      if (visible) render();
    });
  } catch { /* the gallery keeps its open-time render */ }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && visible) closeFamilyGallery();
  });

  void import("./command-palette").then(({ registerCommand }) => {
    registerCommand({
      id: "family.gallery",
      label: "Family Gallery",
      category: "Families",
      hint: "Browse the family gallery — search, filter, sort, open in the editor",
      run: () => openFamilyGallery(),
    });
  }).catch(() => { /* palette optional at boot */ });

  console.log("[family-gallery] ready. Open from the command palette or the Family Browser.");
}
