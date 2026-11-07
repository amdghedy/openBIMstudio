/** Open BIM Studio Project Center — enterprise-style local project launcher. */
import { confirmDialog } from "../features/form-modal";
import * as store from "../modules/projects/store";
import { createProject, openProject, deleteProjectById, getCurrentProject, onProjectChanged } from "../modules/projects/projects";
import type { ProjectTemplate } from "../modules/projects/types";
import { mountLanguageButton } from "../features/language-button";
import { mountAccountButton } from "../features/cloud-account";
import { clearRecentDrawings, getRecentDrawingBlob, listRecentDrawings, type RecentDrawing } from "../features/cad-recent";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>\"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" } as Record<string, string>)[c],
);

const overlay = document.createElement("div");
overlay.className = "obs-home";
overlay.dataset.role = "home";

const inner = document.createElement("div");
inner.className = "obs-home__inner obs-project-center";
overlay.appendChild(inner);

const TEMPLATE_LABELS: Record<ProjectTemplate, { label: string; note: string }> = {
  blank: { label: "Blank BIM", note: "Clean authoring and open coordination workspace" },
  coordination: { label: "Coordination", note: "Federation, alignment, clash and BCF review" },
  "mep-delivery": { label: "MEP Delivery", note: "MEP authoring, systems and coordination" },
  documentation: { label: "Documentation", note: "Views, sheets, schedules and production" },
  construction: { label: "Construction", note: "4D sequencing, 5D quantities and automation" },
};

const WORKSPACES = [
  ["coordination", "Coordination", "Federate models, align origins, detect clashes and manage BCF issues."],
  ["authoring", "Authoring", "Create and edit architectural, structural and MEP elements with snaps."],
  ["documentation", "Documentation", "Create production sheets, plan views, schedules and saved views."],
  ["mep", "MEP Delivery", "Focus the workspace on duct, pipe, tray, conduit and equipment delivery."],
  ["construction", "Construction", "Simulate 4D, calculate 5D takeoff and run delivery automation."],
  ["qa", "QA / QC", "Run clash detection, IDS validation, issue review and model health checks."],
] as const;

/* ── Welcome-screen showcase ────────────────────────────────────────────────
   Three marketing-style pages that surface the platform's strongest tools.
   Every claim here is backed by real modules/commands in this repository. */
const SHOWCASE = [
  {
    cls: "obs-page--2d",
    num: "01",
    eyebrow: "2D DRAFTING & CAD",
    title: "A real CAD engine — front and center.",
    copy:
      "No more hunting through tabs: the drafting engine is one click from this screen. " +
      "116 keyboard-first commands, file-faithful layer and style handling, and a LibreDWG-grade " +
      "DWG/DXF pipeline that reads r13–r2018 and writes back in the version you choose.",
    cards: [
      ["C>_", "116-command line", "AutoCAD-style commands, type-ahead, custom aliases and dynamic input at the cursor."],
      ["LAY", "Layers, linetypes & styles", "Layer manager, linetype scale, and text/dim styles adopted straight from the file."],
      ["HAT", "Hatches & dimensions", "Associative hatches, dimension chains, leaders and automatic dimensioning."],
      ["DWG", "DWG & DXF, r13–r2018", "Open legacy and current drawings; export DXF or native DWG 2000–2018."],
      ["AUD", "Audit, tables & census", "Drawing audit, layer/table browser, entity census and thumbnail previews."],
      ["PLT", "Batch plot & register", "Plot sets to PDF in batch and track issues in the drawing register."],
    ],
    chips: ["LINE", "PLINE", "OFFSET", "TRIM", "FILLET", "ARRAY", "HATCH", "MTEXT", "OSNAP", "ORTHO", "MATCHPROP", "PURGE", "QSAVE", "PLOT"],
    cta: ["data-open2d", "Launch the 2D engine"],
  },
  {
    cls: "obs-page--3d",
    num: "02",
    eyebrow: "3D BIM & COORDINATION",
    title: "Author, federate and coordinate in one 3D environment.",
    copy:
      "The 3D platform covers the full delivery arc: architectural and structural authoring, MEP " +
      "fabrication, federation, clash detection and issue round-trips — with 4D sequencing and 5D " +
      "quantities tied directly to the model you are looking at.",
    cards: [
      ["BLD", "Author everything", "Walls, slabs, stairs, roofs, curtain wall, railings, ramps, rooms and site topography."],
      ["REB", "Rebar & structure", "Rebar authoring with lap splices, structural connections, loads and trusses."],
      ["MEP", "MEP systems", "Duct, pipe, tray and fabrication parts with sizing and balance reviews."],
      ["CLS", "Clash detection & BCF", "BVH/GJK clash engine with reports and BCF issue round-trip to other tools."],
      ["4D5", "4D & 5D delivery", "Sequencing timelines and cost takeoff computed from model elements."],
      ["ENV", "Analysis & environment", "Sun settings, daylighting and energy analysis on the analytical model."],
    ],
    chips: ["IFC", "FEDERATION", "SECTION BOX", "WALK MODE", "VIEWCUBE", "SCHEDULES", "SHEETS", "IDS", "WORKSETS", "DESIGN OPTIONS", "POINT CLOUD"],
    cta: ["data-open3d", "Enter the 3D BIM platform"],
  },
  {
    cls: "obs-page--del",
    num: "03",
    eyebrow: "DELIVER, AUTOMATE & SCALE",
    title: "From model to deliverable — and to every device you own.",
    copy:
      "Local-first by design, cloud-connected when you want it. Sign in from any device and open the " +
      "same project vault, exchange every AEC format, automate the repetitive work and run the whole " +
      "interface in ten languages including right-to-left Arabic.",
    cards: [
      ["CLD", "Cloud projects", "Email or Google sign-in; the same vault opens from desktop, tablet or phone."],
      ["FMT", "Every format in, out", "IFC, BCF, IDS, DWG/DXF, NWC bridge, SVG, JSON, GeoJSON and PostScript."],
      ["SCH", "Schedules & sheets", "Live schedules, sheet sets and drawing production with batch plot."],
      ["AUT", "Automation & plugins", "Generative design, automation pipelines and an installable plugin marketplace."],
      ["AI", "AI command bar", "Ask about the model in plain language — query, filter and navigate results."],
      ["L10", "10 languages · offline", "Full UI translation incl. RTL Arabic; installable PWA that works offline."],
    ],
    chips: ["IFC", "BCF", "IDS", "DWG/DXF", "NWC", "SVG", "JSON", "GeoJSON", "PS", ".obsproj", "PWA"],
    cta: ["data-focus-create", "Start a project below"],
  },
] as const;

/* Decorative product visuals, pure inline SVG (no assets, aria-hidden). */
const VISUAL_2D = `
<svg viewBox="0 0 340 212" role="presentation" focusable="false">
  <defs>
    <pattern id="obsp-grid" width="15" height="15" patternUnits="userSpaceOnUse">
      <path d="M15 0H0V15" fill="none" stroke="rgba(56,189,248,.10)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="340" height="212" fill="url(#obsp-grid)"/>
  <rect x="40" y="34" width="148" height="90" fill="none" stroke="#38BDF8" stroke-width="1.6"/>
  <circle cx="114" cy="79" r="29" fill="none" stroke="#7DD3FC" stroke-width="1.3"/>
  <path d="M188 34 L262 34 L262 124 L296 124" fill="none" stroke="#7DD3FC" stroke-width="1.3"/>
  <path d="M40 158 H296" stroke="#F59E0B" stroke-width="1"/>
  <path d="M40 154 v8 M296 154 v8" stroke="#F59E0B" stroke-width="1"/>
  <path d="M44 155.6 40 158 44 160.4 M292 155.6 296 158 292 160.4" fill="none" stroke="#F59E0B" stroke-width="1"/>
  <text x="150" y="152" fill="#F59E0B" font-family="monospace" font-size="10">25600</text>
  <g class="obsp-cross">
    <path d="M236 64 v-18 M236 64 v18 M236 64 h-18 M236 64 h18" stroke="rgba(232,234,240,.75)" stroke-width="1"/>
    <rect x="232.5" y="60.5" width="7" height="7" fill="none" stroke="#38BDF8" stroke-width="1.2"/>
  </g>
  <rect x="22" y="180" width="296" height="21" rx="4" fill="rgba(11,13,18,.85)" stroke="#1E2029"/>
  <text x="32" y="194" fill="#6B7280" font-family="monospace" font-size="9.5">Command: _line 25600,18400&#8250;</text>
  <rect class="obsp-caret" x="238" y="185" width="6" height="11" fill="#38BDF8"/>
</svg>`;

const VISUAL_3D = `
<svg viewBox="0 0 340 212" role="presentation" focusable="false">
  <defs>
    <linearGradient id="obsp-fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgba(129,140,248,.16)"/><stop offset="1" stop-color="rgba(129,140,248,0)"/>
    </linearGradient>
  </defs>
  <rect width="340" height="212" fill="url(#obsp-fade)"/>
  <g stroke-width="1.2" stroke-linejoin="round">
    <polygon points="60,84 100,64 140,84 100,104" fill="#4c5270" stroke="#818CF8"/>
    <polygon points="60,84 60,138 100,158 100,104" fill="#262a3e" stroke="#818CF8"/>
    <polygon points="140,84 140,138 100,158 100,104" fill="#313652" stroke="#818CF8"/>
    <polygon points="150,58 196,35 242,58 196,81" fill="#575e85" stroke="#818CF8"/>
    <polygon points="150,58 150,134 196,157 196,81" fill="#2b2f46" stroke="#818CF8"/>
    <polygon points="242,58 242,134 196,157 196,81" fill="#3a3f5e" stroke="#818CF8"/>
    <polygon points="222,112 258,94 294,112 258,130" fill="#4c5270" stroke="#818CF8"/>
    <polygon points="222,112 222,150 258,168 258,130" fill="#262a3e" stroke="#818CF8"/>
    <polygon points="294,112 294,150 258,168 258,130" fill="#313652" stroke="#818CF8"/>
  </g>
  <path d="M36 190 L312 52" stroke="#38BDF8" stroke-width="1.1" stroke-dasharray="5 4"/>
  <polygon points="36,190 312,52 312,38 36,176" fill="rgba(56,189,248,.10)"/>
  <g class="obsp-clash">
    <circle cx="173" cy="120" r="9" fill="rgba(239,68,68,.18)" stroke="#EF4444" stroke-width="1.4"/>
    <circle cx="173" cy="120" r="2.6" fill="#EF4444"/>
    <text x="188" y="116" fill="#EF4444" font-family="monospace" font-size="9">BCF-014</text>
  </g>
</svg>`;

const VISUAL_DEL = `
<svg viewBox="0 0 340 212" role="presentation" focusable="false">
  <defs>
    <linearGradient id="obsp-cloud" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgba(34,197,94,.20)"/><stop offset="1" stop-color="rgba(34,197,94,.04)"/>
    </linearGradient>
  </defs>
  <rect width="340" height="212" fill="url(#obsp-cloud)"/>
  <g class="obsp-float">
    <rect x="52" y="52" width="108" height="132" rx="7" fill="#12141B" stroke="#2A2E3A" transform="rotate(-7 106 118)"/>
    <text x="70" y="98" fill="#22C55E" font-family="monospace" font-size="12" transform="rotate(-7 106 118)">IFC</text>
    <path d="M70 112 h68 M70 124 h68 M70 136 h44" stroke="#2A2E3A" stroke-width="2" transform="rotate(-7 106 118)"/>
  </g>
  <g class="obsp-float obsp-float--d1">
    <rect x="118" y="40" width="108" height="132" rx="7" fill="#12141B" stroke="#2A2E3A" transform="rotate(4 172 106)"/>
    <text x="136" y="86" fill="#38BDF8" font-family="monospace" font-size="12" transform="rotate(4 172 106)">DWG</text>
    <path d="M136 100 h68 M136 112 h68 M136 124 h40" stroke="#2A2E3A" stroke-width="2" transform="rotate(4 172 106)"/>
  </g>
  <g class="obsp-float obsp-float--d2">
    <rect x="186" y="58" width="104" height="128" rx="7" fill="#12141B" stroke="#2A2E3A" transform="rotate(11 238 122)"/>
    <text x="204" y="102" fill="#818CF8" font-family="monospace" font-size="12" transform="rotate(11 238 122)">BCF</text>
    <path d="M204 116 h64 M204 128 h64 M204 140 h38" stroke="#2A2E3A" stroke-width="2" transform="rotate(11 238 122)"/>
  </g>
  <path d="M170 178 c-26 0 -26 -24 -8 -26 c-2 -14 18 -20 26 -10 c16 -8 34 6 26 20 c14 0 12 16 -4 16 z" fill="rgba(34,197,94,.14)" stroke="#22C55E" stroke-width="1.3"/>
  <path d="M120 196 h140" stroke="#2A2E3A" stroke-width="1"/>
  <text x="122" y="208" fill="#6B7280" font-family="monospace" font-size="9">SAME VAULT · EVERY DEVICE</text>
</svg>`;

function emitWorkspace(id: string) {
  window.dispatchEvent(new CustomEvent("obs-workspace", { detail: { id } }));
  hideHome();
}

/* The two headline entries of the welcome screen.
   2D → full-screen CAD editor; opens a blank drawing, no BIM project needed.
   3D → the BIM platform: with a project, just leave the landing screen;
   without one, enter the default Coordination workspace (same path as the
   workspace cards, so behavior stays consistent). */
function open2dEngine(): void {
  void import("../features/cad-viewer").then((m) => m.openCadViewer());
}
function open3dPlatform(): void {
  if (getCurrentProject()) {
    hideHome();
    return;
  }
  emitWorkspace("coordination");
}

/* ── 2D drafting-zone history (left file zone of the welcome screen) ────────
   The 2D counterpart of “Recent projects”: every drawing the engine opens or
   saves is recorded (with its bytes) by cad-recent, so this list reopens a
   drawing with one click. Fails soft when storage is unavailable. */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function ago(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

async function render2dHistory(): Promise<void> {
  const list = inner.querySelector("#obs-2d-history") as HTMLElement | null;
  const stats = inner.querySelector("#obs-2d-stats") as HTMLElement | null;
  if (!list) return;
  let recent: RecentDrawing[] = [];
  try {
    recent = await listRecentDrawings();
  } catch {
    recent = [];
  }
  if (!recent.length) {
    list.innerHTML = `<div class="obs-2d-empty"><strong>No drawings yet</strong>Open a DWG / DXF file or start a new drawing — everything you open or save shows up here for one-click reopen.</div>`;
  } else {
    list.innerHTML = recent.map((r) => `
      <div class="obs-2d-row" data-name="${esc(r.name)}">
        <span class="obs-2d-row__fmt${r.format === "DWG" ? " obs-2d-row__fmt--dwg" : ""}">${esc(r.format)}</span>
        <span class="obs-2d-row__body">
          <b>${esc(r.name)}</b>
          <small>${fmtBytes(r.size)} · ${ago(r.ts)}${r.hasBytes ? "" : " · reopen from your original file"}</small>
        </span>
        ${r.hasBytes
          ? `<button class="obs-btn obs-btn--sm obs-2d-row__open" type="button">Open</button>`
          : `<span class="obs-2d-row__stale">bytes evicted</span>`}
      </div>`).join("");
  }
  list.querySelectorAll<HTMLButtonElement>(".obs-2d-row__open").forEach((btn) => {
    btn.onclick = () => {
      const name = (btn.closest(".obs-2d-row") as HTMLElement | null)?.dataset.name ?? "";
      void getRecentDrawingBlob(name).then((blob) => {
        if (!blob) {
          void render2dHistory();
          return;
        }
        void import("../features/cad-viewer").then((m) => m.openCadViewer(new File([blob], name)));
      });
    };
  });
  if (stats) {
    const cards = [
      ["Drawings on device", String(recent.length), "Reopen with one click"],
      ["Commands", "116", "AutoCAD-style command line"],
      ["Read / write", "DWG · DXF", "r13–r2018 in · 2000–2018 out"],
      ["Plot", "PDF", "Single sheet or batch sets"],
    ];
    stats.innerHTML = cards.map(([label, value, note]) => `
      <div class="obs-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join("");
  }
}

/* Cumulative visit counter. Counting happens server-side on the Cloudflare
   edge (Durable Object): one visit per visitor per 30-min session window,
   identical for every visitor on every device — never a per-PC number.
   Static deployments (e.g. Vercel) ship no /api backend, so the client falls
   back to the canonical counter API. Every copy of the site therefore feeds
   and displays the SAME global count. Hidden silently when unreachable. */
const COUNTER_PATH = "/api/visits";
const COUNTER_FALLBACK = "https://openbimstudio.amdghedy.workers.dev/api/visits";

let visitRequest: Promise<number | null> | null = null;

async function postVisit(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) return null;
    const data = (await res.json()) as { visits?: number | null };
    return typeof data.visits === "number" && Number.isFinite(data.visits) ? data.visits : null;
  } catch {
    return null;
  }
}

async function fetchVisitTotal(): Promise<number | null> {
  const local = await postVisit(COUNTER_PATH);
  if (local !== null) return local;
  if (new URL(COUNTER_FALLBACK).origin === location.origin) return null;
  return postVisit(COUNTER_FALLBACK);
}

function trackVisit(): Promise<number | null> {
  visitRequest ??= fetchVisitTotal();
  return visitRequest;
}

function renderVisits(): void {
  const el = inner.querySelector("#obs-visits") as HTMLElement | null;
  if (!el) return;
  void trackVisit().then((total) => {
    if (total === null) {
      el.style.display = "none";
      return;
    }
    el.textContent = `${total.toLocaleString("en-US")} ${total === 1 ? "visit" : "visits"}`;
  });
}

function buildStatic() {
  inner.innerHTML = `
    <header class="obs-center-header">
      <div class="obs-center-brand">
        <div class="obs-center-mark" aria-hidden="true"></div>
        <div>
          <div class="obs-center-title">Open BIM Studio</div>
          <div class="obs-center-subtitle">Professional openBIM project environment</div>
        </div>
      </div>
      <div class="obs-center-header-meta">
        <span class="obs-center-badge">LOCAL-FIRST</span>
        <span class="obs-center-badge obs-center-badge--muted">IFC · BCF · IDS</span>
        <span class="obs-center-version">v54</span>
      </div>
    </header>

    <section class="obs-hero" aria-label="Quick launch">
      <div class="obs-hero__eyebrow">ONE PLATFORM · 2D + 3D · OPEN STANDARDS</div>
      <h1 class="obs-hero__title">Your <em>CAD engine</em> and your <em>BIM platform</em> — one click from here.</h1>
      <p class="obs-hero__sub">No more buried tools. Launch a full drafting session or the complete 3D BIM environment straight from the welcome screen — no project setup required.</p>
      <div class="obs-hero__cta-row">
        <button class="obs-mega obs-mega--2d" id="obs-hero-2d" type="button">
          <span class="obs-mega__glyph" aria-hidden="true">2D</span>
          <span class="obs-mega__body">
            <b class="obs-mega__title">CAD Drafting Engine</b>
            <span class="obs-mega__desc">Draw, annotate and plot in a full-screen drafting session — opens instantly, even without a project.</span>
            <span class="obs-mega__specs">116 COMMANDS · DWG/DXF r13–r2018 · LAYERS · HATCHES · PLOT</span>
          </span>
          <span class="obs-mega__go" aria-hidden="true">→</span>
        </button>
        <button class="obs-mega obs-mega--3d" id="obs-hero-3d" type="button">
          <span class="obs-mega__glyph" aria-hidden="true">3D</span>
          <span class="obs-mega__body">
            <b class="obs-mega__title">3D BIM Platform</b>
            <span class="obs-mega__desc">Author, federate, clash-check and deliver — the complete openBIM environment.</span>
            <span class="obs-mega__specs">IFC · BCF · IDS · 4D/5D · MEP &amp; REBAR · SHEETS</span>
          </span>
          <span class="obs-mega__go" aria-hidden="true">→</span>
        </button>
      </div>
      <div class="obs-hero__trust" aria-label="Supported standards">
        <span class="obs-trust-chip">IFC</span>
        <span class="obs-trust-chip">DWG / DXF r13–r2018</span>
        <span class="obs-trust-chip">BCF</span>
        <span class="obs-trust-chip">IDS</span>
        <span class="obs-trust-chip">NWC</span>
        <span class="obs-trust-chip">SVG · JSON · PS</span>
        <span class="obs-trust-chip">10 LANGUAGES</span>
        <span class="obs-trust-chip obs-trust-chip--hot">LOCAL-FIRST</span>
      </div>
    </section>

    <!-- ═══ File zones: 2D (left) and 3D (right) — each with its own
         options, history and info, mirroring the two hero buttons. ═══ -->
    <section class="obs-zones" aria-label="2D and 3D files">
      <!-- ── 2D drafting zone — drawing files · history · engine info ── -->
      <div class="obs-zone obs-zone--2d">
        <div class="obs-zone__head">
          <span class="obs-zone__glyph" aria-hidden="true">2D</span>
          <div class="obs-zone__headtext">
            <div class="obs-zone__eyebrow">2D DRAWING FILES</div>
            <h2>Drafting drawings</h2>
            <p>Open a drawing straight into the full-screen drafting engine — no project setup, no hunting through tabs.</p>
          </div>
        </div>
        <div class="obs-zone__options">
          <button class="obs-btn obs-btn--primary" id="obs-2d-new" type="button">New drawing</button>
          <button class="obs-btn" id="obs-2d-open" type="button" title="Open a DWG, DXF or LandXML file in the drafting engine">Open DWG / DXF\u2026</button>
          <input id="obs-2d-file" type="file" accept=".dwg,.dxf,.bak,.sv$,*.xml" multiple hidden />
        </div>
        <div class="obs-zone__block">
          <div class="obs-zone__sub"><span>History — recent drawings</span><button class="obs-zone__linkbtn" id="obs-2d-clear" type="button">Clear</button></div>
          <div class="obs-2d-history" id="obs-2d-history"></div>
        </div>
        <div class="obs-zone__block">
          <div class="obs-zone__sub"><span>Engine info</span></div>
          <div class="obs-zone__stats" id="obs-2d-stats"></div>
          <div class="obs-chiprow">
            <span class="obs-chip">DWG / DXF r13–r2018</span>
            <span class="obs-chip">LAYERS · LTYPES · STYLES</span>
            <span class="obs-chip">HATCH · DIMS · LEADERS</span>
            <span class="obs-chip">BATCH PLOT → PDF</span>
            <span class="obs-chip">AUDIT · TABLES · CENSUS</span>
          </div>
        </div>
      </div>

      <!-- ── 3D BIM zone — project files · history · platform info ── -->
      <div class="obs-zone obs-zone--3d">
        <div class="obs-zone__head">
          <span class="obs-zone__glyph obs-zone__glyph--3d" aria-hidden="true">3D</span>
          <div class="obs-zone__headtext">
            <div class="obs-zone__eyebrow">3D BIM PROJECT FILES</div>
            <h2>BIM projects</h2>
            <p>Create a workspace or reopen a project — data stays in your browser unless you explicitly export it.</p>
          </div>
        </div>
        <div class="obs-zone__options">
          <div class="obs-create-row">
            <input id="obs-new-name" autocomplete="off" placeholder="Project name — e.g. HSR PK3 MEP Stations" aria-label="Project name" />
            <select id="obs-template" aria-label="Project template">
              ${Object.entries(TEMPLATE_LABELS).map(([id, t]) => `<option value="${id}">${esc(t.label)}</option>`).join("")}
            </select>
            <button class="obs-btn obs-btn--primary" id="obs-create-project">Create project</button>
            <button class="obs-btn" id="obs-open-file" title="Open a .obsproj project file from your computer">Open file\u2026</button>
          </div>
          <div class="obs-create-hint" id="obs-template-note"></div>
        </div>
        <div class="obs-zone__block">
          <div class="obs-zone__sub"><span>History — recent projects</span><span class="obs-home__section-count" id="obs-count"></span></div>
          <div class="obs-home__grid obs-home__grid--inzone" id="obs-grid"></div>
        </div>
        <div class="obs-zone__block">
          <div class="obs-zone__sub"><span>Platform info</span></div>
          <div class="obs-zone__stats" id="obs-3d-stats"></div>
          <div class="obs-workspace-grid" id="obs-workspaces"></div>
        </div>
      </div>
    </section>

    <div class="obs-pages" id="obs-pages">
      ${SHOWCASE.map((p) => `
      <article class="obs-page ${p.cls}">
        <div class="obs-page__text">
          <div class="obs-page__head"><span class="obs-page__num">${p.num}</span><span class="obs-page__eyebrow">${esc(p.eyebrow)}</span></div>
          <h3 class="obs-page__title">${esc(p.title)}</h3>
          <p class="obs-page__copy">${esc(p.copy)}</p>
          <div class="obs-fgrid">
            ${p.cards.map(([icon, title, desc]) => `
            <div class="obs-fcard">
              <span class="obs-fcard__icon" aria-hidden="true">${esc(icon)}</span>
              <span class="obs-fcard__body"><b>${esc(title)}</b><small>${esc(desc)}</small></span>
            </div>`).join("")}
          </div>
          <div class="obs-chiprow">${p.chips.map((c) => `<span class="obs-chip">${esc(c)}</span>`).join("")}</div>
          <button class="obs-page__cta" ${p.cta[0]} type="button">${esc(p.cta[1])} <span aria-hidden="true">→</span></button>
        </div>
        <div class="obs-page__visual" aria-hidden="true">
          ${p.cls === "obs-page--2d" ? VISUAL_2D : p.cls === "obs-page--3d" ? VISUAL_3D : VISUAL_DEL}
        </div>
      </article>`).join("")}
    </div>

    <footer class="obs-home__footer">
      <span>Open BIM Studio · local-first · <a href="https://github.com/amdghedy/openBIMstudio" target="_blank" rel="noopener noreferrer" style="color:#93c5fd;text-decoration:none">GitHub</a> · <a href="https://github.com/amdghedy/openBIMstudio" target="_blank" rel="noopener noreferrer" style="color:#fbbf24;text-decoration:none">⭐ Star</a> · <a href="https://github.com/amdghedy/openBIMstudio/issues/new/choose" target="_blank" rel="noopener noreferrer" style="color:#93c5fd;text-decoration:none">Report issue</a></span>
      <span class="obs-home__visits" id="obs-visits" aria-live="polite"></span>
      <span><kbd>Ctrl</kbd> <kbd>O</kbd> Open &nbsp;·&nbsp; <kbd>Ctrl</kbd> <kbd>S</kbd> Save &nbsp;·&nbsp; <kbd>Ctrl</kbd> <kbd>P</kbd> Commands</span>
    </footer>`;

  mountLanguageButton(inner.querySelector(".obs-center-header"));
  mountAccountButton(inner.querySelector(".obs-center-header") as HTMLElement);
  const nameInput = inner.querySelector("#obs-new-name") as HTMLInputElement;
  const template = inner.querySelector("#obs-template") as HTMLSelectElement;
  const note = inner.querySelector("#obs-template-note") as HTMLElement;
  const createBtn = inner.querySelector("#obs-create-project") as HTMLButtonElement;
  (inner.querySelector("#obs-open-file") as HTMLButtonElement | null)?.addEventListener("click", () => {
    void import("../modules/projects/project-file-io").then((m) => m.openProjectFromFile());
  });

  const updateTemplateNote = () => {
    note.textContent = TEMPLATE_LABELS[template.value as ProjectTemplate]?.note ?? "";
  };
  template.addEventListener("change", updateTemplateNote);
  updateTemplateNote();
  renderVisits();
  createBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    void createProject(name, { template: template.value as ProjectTemplate });
    nameInput.value = "";
  };
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createBtn.click();
  });

  const ws = inner.querySelector("#obs-workspaces") as HTMLElement;
  ws.innerHTML = `
    ${WORKSPACES.map(([id, label, description]) => `
    <button class="obs-workspace-card" data-workspace="${id}">
      <span class="obs-workspace-card__marker"></span>
      <span class="obs-workspace-card__content">
        <b>${esc(label)}</b>
        <small>${esc(description)}</small>
      </span>
      <span class="obs-workspace-card__arrow">→</span>
    </button>`).join("")}`;
  ws.querySelectorAll<HTMLButtonElement>("[data-workspace]").forEach((button) => {
    button.onclick = () => emitWorkspace(button.dataset.workspace ?? "coordination");
  });

  /* ── 2D drafting zone: file options + drawing history ── */
  const file2d = inner.querySelector("#obs-2d-file") as HTMLInputElement | null;
  (inner.querySelector("#obs-2d-new") as HTMLButtonElement | null)?.addEventListener("click", open2dEngine);
  (inner.querySelector("#obs-2d-open") as HTMLButtonElement | null)?.addEventListener("click", () => file2d?.click());
  file2d?.addEventListener("change", () => {
    const files = [...(file2d.files ?? [])];
    file2d.value = "";
    if (!files.length) return;
    void import("../features/cad-viewer").then((m) => {
      for (const f of files) m.openCadViewer(f);
    });
  });
  (inner.querySelector("#obs-2d-clear") as HTMLButtonElement | null)?.addEventListener("click", () => {
    void confirmDialog("Clear drawing history", "Remove the recent-drawings list from this browser? Your drawing files are not touched.").then(async (ok) => {
      if (!ok) return;
      await clearRecentDrawings();
      void render2dHistory();
    });
  });

  /* Welcome-screen headline CTAs + showcase page CTAs */
  (inner.querySelector("#obs-hero-2d") as HTMLButtonElement | null)?.addEventListener("click", open2dEngine);
  (inner.querySelector("#obs-hero-3d") as HTMLButtonElement | null)?.addEventListener("click", open3dPlatform);
  inner.querySelectorAll<HTMLButtonElement>("[data-open2d]").forEach((b) => { b.onclick = open2dEngine; });
  inner.querySelectorAll<HTMLButtonElement>("[data-open3d]").forEach((b) => { b.onclick = open3dPlatform; });
  inner.querySelectorAll<HTMLButtonElement>("[data-focus-create]").forEach((b) => {
    b.onclick = () => {
      nameInput.scrollIntoView({ behavior: "smooth", block: "center" });
      nameInput.focus({ preventScroll: true });
    };
  });
}

function renderKpis(docs: any[]) {
  const kpi = inner.querySelector("#obs-3d-stats") as HTMLElement | null;
  if (!kpi) return;
  const models = docs.reduce((sum, d) => sum + (d.models?.length ?? 0), 0);
  const elements = docs.reduce((sum, d) => sum + (d.elements?.length ?? 0), 0);
  const issues = docs.reduce((sum, d) => sum + (d.issues?.length ?? 0), 0);
  const active = docs.filter((d) => (d.status ?? "active") === "active").length;
  const cards = [
    ["Projects", docs.length, "Local project records"],
    ["Linked models", models, "IFC / Fragments / references"],
    ["Authored objects", elements, "Native authored BIM elements"],
    ["Open issues", issues, active ? `${active} active project${active === 1 ? "" : "s"}` : "No active projects"],
  ];
  kpi.innerHTML = cards.map(([label, value, note]) => `
    <div class="obs-kpi">
      <span>${esc(label)}</span>
      <strong>${Number(value).toLocaleString()}</strong>
      <small>${esc(note)}</small>
    </div>`).join("");
}

function projectCard(doc: any): HTMLElement {
  const s = store.summarize(doc);
  const card = document.createElement("article");
  card.className = "obs-card obs-project-card";
  const status = s.status ?? "active";
  const template = TEMPLATE_LABELS[s.template ?? "blank"]?.label ?? "BIM";
  const meta = [s.projectNumber, s.client, s.phase].filter(Boolean).join(" · ");
  card.innerHTML = `
    <div class="obs-project-card__top">
      <div class="obs-card__icon">BIM</div>
      <span class="obs-project-status obs-project-status--${esc(status)}">${esc(status.replace("-", " ").toUpperCase())}</span>
    </div>
    <div class="obs-card__title">${esc(s.name)}</div>
    <div class="obs-project-card__template">${esc(template)}</div>
    <div class="obs-card__meta">
      <span>${s.elementCount.toLocaleString()} objects</span><span class="sep">·</span>
      <span>${s.modelCount.toLocaleString()} model(s)</span><span class="sep">·</span>
      <span>${s.issueCount.toLocaleString()} issue(s)</span>
    </div>
    <div class="obs-project-card__identity">${esc(meta || "No project metadata yet")}</div>
    <div class="obs-card__actions"></div>`;

  const actions = card.querySelector(".obs-card__actions") as HTMLElement;
  const openBtn = document.createElement("button");
  openBtn.className = "obs-btn obs-btn--primary obs-btn--sm";
  openBtn.textContent = "Open";
  openBtn.onclick = (e) => { e.stopPropagation(); void openProject(s.id); };
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "obs-btn obs-btn--sm";
  deleteBtn.textContent = "Delete";
  deleteBtn.onclick = async (e) => {
    e.stopPropagation();
    if (!(await confirmDialog("Delete project", `Delete “${s.name}” and its stored models? This cannot be undone.`))) return;
    await deleteProjectById(s.id);
    void renderList();
  };
  actions.append(openBtn, deleteBtn);
  card.onclick = () => void openProject(s.id);
  return card;
}

async function renderList() {
  const grid = inner.querySelector("#obs-grid") as HTMLElement | null;
  const count = inner.querySelector("#obs-count") as HTMLElement | null;
  if (!grid || !count) return;
  const docs = (await store.listProjectDocs()).sort((a, b) => b.updatedAt - a.updatedAt);
  renderKpis(docs);
  count.textContent = docs.length ? `${docs.length} project${docs.length === 1 ? "" : "s"}` : "";
  grid.innerHTML = "";
  if (!docs.length) {
    grid.innerHTML = `<div class="obs-empty" style="grid-column:1/-1"><strong>No project workspace yet</strong>Create a project above, then link IFC/FRAG models and begin coordination.</div>`;
    return;
  }
  for (const doc of docs) grid.appendChild(projectCard(doc));
}

export function showHome() {
  void renderList();
  void render2dHistory();
  overlay.classList.add("is-open");
}
export function hideHome() { overlay.classList.remove("is-open"); }
export function setupHomeScreen() {
  buildStatic();
  document.body.appendChild(overlay);
  onProjectChanged(() => { if (getCurrentProject()) hideHome(); });
}
