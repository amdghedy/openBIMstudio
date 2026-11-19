/** Open BIM Studio Project Center — enterprise-style local project launcher. */
import { confirmDialog } from "../features/form-modal";
import * as store from "../modules/projects/store";
import { createProject, openProject, deleteProjectById, getCurrentProject, onProjectChanged } from "../modules/projects/projects";
import type { ProjectTemplate } from "../modules/projects/types";
import { mountLanguageButton } from "../features/language-button";
import { mountAccountButton } from "../features/cloud-account";
import { clearRecentDrawings, getRecentDrawingBlob, listRecentDrawings, type RecentDrawing } from "../features/cad-recent";
import { fmtNumber } from "../core/region";

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
    eyebrow: "2D DRAWING & DRAFTING",
    title: "A native drawing engine — front and center.",
    copy:
      "No more hunting through tabs: the drafting engine is one click from this screen. " +
      "200+ keyboard-first commands, file-faithful layer and style handling, and a LibreDWG-grade " +
      "DWG/DXF pipeline that reads r13–r2018 and writes back in the version you choose.",
    cards: [
      {
        icon: "C>_", title: "200+ command line",
        desc: "standard drafting commands, type-ahead, custom aliases and dynamic input at the cursor.",
        detailTitle: "Command-line drafting engine",
        detailBody:
          "Open BIM Studio’s 2D engine is keyboard-first, like AutoCAD. Type a command anywhere on the canvas, " +
          "use aliases (L, PL, TR, F…), and press Esc to cancel. Dynamic input and OSNAP keep geometry accurate " +
          "without leaving the drawing.",
        bullets: [
          "200+ commands with type-ahead and customizable aliases (KS)",
          "Direct distance entry and polar / ortho tracking",
          "Enter ends the command; Space repeats the last one",
          "Esc cancels tools; double-Esc resets the editor",
        ],
        howTo: "Launch the 2D engine → start typing LINE or L → pick points → Enter.",
      },
      {
        icon: "LAY", title: "Layers, linetypes & styles",
        desc: "Layer manager, linetype scale, and text/dim styles adopted straight from the file.",
        detailTitle: "Layers, linetypes & text styles",
        detailBody:
          "Layers control visibility, colour, freeze and lock — just like a production CAD workflow. " +
          "Linetypes and text styles travel with the DWG/DXF so drawings stay file-faithful when you reopen them.",
        bullets: [
          "Layer Properties Manager (LA) with on/off, freeze, lock, colour",
          "Hide Multi / Isolate / Filter patterns for multi-layer review",
          "Linetype Manager and global LTSCALE",
          "Text Style Manager for fonts, heights and presets",
        ],
        howTo: "Open a DWG → Home → Layers → Manager, or type LA / LAYHIDEM.",
      },
      {
        icon: "HAT", title: "Hatches & dimensions",
        desc: "Associative hatches, dimension chains, leaders and automatic dimensioning.",
        detailTitle: "Hatches, dimensions & markup",
        detailBody:
          "Document drawings with hatches, linear and aligned dimensions, leaders and revision clouds. " +
          "Dimension styles control tick size, precision and suffixes for consistent sheets.",
        bullets: [
          "HATCH with pattern scale/angle and boundary pick",
          "DIMLINEAR, DIMALIGNED, DIMANGULAR, diameter and radius",
          "MLEADER / QLEADER annotation leaders",
          "REVCLOUD for review markups",
        ],
        howTo: "In 2D engine type HATCH or DIMALIGNED, or use the Annotate ribbon.",
      },
      {
        icon: "DWG", title: "DWG & DXF, r13–r2018",
        desc: "Open legacy and current drawings; export DXF or native DWG 2000–2018.",
        detailTitle: "DWG / DXF read & write",
        detailBody:
          "OpenBIM Studio reads DWG and DXF across common AutoCAD versions and can write DXF or DWG back. " +
          "When a large or complex DWG fails the built-in reader, SAVEAS to DXF (ASCII R2013/R2018) is the reliable path; " +
          "LibreDWG is used as an optional fallback when bundled.",
        bullets: [
          "Open DWG/DXF from the welcome page or DWGOPEN",
          "QSAVE (DXF) and DWGSAVE for round-trip edits",
          "Session restore: last view, off and frozen layers",
          "Batch publish of open drawings",
        ],
        howTo: "Welcome → Open DWG / DXF / PDF… or 2D engine → File → Open.",
      },
      {
        icon: "AUD", title: "Audit, tables & census",
        desc: "Drawing audit, layer/table browser, entity census and thumbnail previews.",
        detailTitle: "Audit, tables & drawing health",
        detailBody:
          "Keep drawings clean with audit tools, layer statistics, entity census and table browsers. " +
          "Purge empty layers and zero-length geometry before handoff.",
        bullets: [
          "AUDIT and OVERKILL for cleanup",
          "LAYERSTATS / DWGCENSUS for counts by type and layer",
          "PURGELAYERS and AUDITZL (zero-length lines)",
          "Embedded DWG thumbnail while parsing large files",
        ],
        howTo: "Type AUDIT, LAYERSTATS or OVERKILL in the 2D command line.",
      },
      {
        icon: "PLT", title: "Batch plot & register",
        desc: "Plot sets to PDF in batch and track issues in the drawing register.",
        detailTitle: "Plot, publish & drawing register",
        detailBody:
          "Plot the current view or sheet to PDF, run batch publish across open tabs, and keep a drawing register " +
          "for issue tracking during documentation.",
        bullets: [
          "PLOT / PRINT to PDF with lineweight floor for readable sheets",
          "PUBLISH all open drawings",
          "Page setup and layout support",
          "Drawing register for coordination notes",
        ],
        howTo: "Type PLOT or use File → Plot… in the 2D engine.",
      },
    ],
    chips: ["LINE", "PLINE", "OFFSET", "TRIM", "FILLET", "ARRAY", "HATCH", "MTEXT", "OSNAP", "ORTHO", "MATCHPROP", "PURGE", "QSAVE", "PLOT"],
    cta: ["data-open2d", "Launch the 2D engine"],
    overviewTitle: "Topic 01 — 2D Drawing & Drafting",
    overviewBody:
      "This topic is the full CAD drafting workspace: open DWG/DXF, draw and edit with AutoCAD-like commands, " +
      "manage layers and styles, dimension and hatch, then plot or export. Click any card below for a deeper guide.",
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
      {
        icon: "BLD", title: "Author everything",
        desc: "Walls, slabs, stairs, roofs, curtain wall, railings, ramps, rooms and site topography.",
        detailTitle: "Architectural & site authoring",
        detailBody:
          "Model buildings directly in the browser: walls with hosts and openings, floors, roofs, stairs, " +
          "curtain systems, rooms and topography. Reference tracking helps close rectangular wall chains accurately.",
        bullets: [
          "Walls, slabs, columns, beams, doors and windows",
          "Stairs between levels, roofs and ceilings from walls",
          "Rooms / spaces with detection helpers",
          "Grids, levels and work planes for control",
        ],
        howTo: "Enter 3D → BIM Toolbox → Wall / Floor / Level, or use authoring tools on the ribbon.",
      },
      {
        icon: "REB", title: "Rebar & structure",
        desc: "Rebar authoring with lap splices, structural connections, loads and trusses.",
        detailTitle: "Structure & reinforcement",
        detailBody:
          "Structural framing, connections, loads and rebar tools support concrete and steel workflows " +
          "alongside architectural models in the same federated view.",
        bullets: [
          "Structural members and trusses",
          "Connections and load placement",
          "Rebar with lap awareness",
          "Align and constraint helpers for frames",
        ],
        howTo: "3D platform → structural tools in the authoring toolbox.",
      },
      {
        icon: "MEP", title: "MEP systems",
        desc: "Duct, pipe, tray and fabrication parts with sizing and balance reviews.",
        detailTitle: "MEP systems & fabrication",
        detailBody:
          "Route duct, pipe, cable tray and conduit; review system colours and fabrication parts. " +
          "MEP sits in the same 3D scene as architecture for coordination.",
        bullets: [
          "Duct, pipe, tray, conduit tools",
          "MEP discipline colouring",
          "Fabrication-oriented parts",
          "Clash against architecture and structure",
        ],
        howTo: "BIM Toolbox → Duct / Pipe / Cable Tray.",
      },
      {
        icon: "CLS", title: "Clash detection & BCF",
        desc: "BVH/GJK clash engine with reports and BCF issue round-trip to other tools.",
        detailTitle: "Clashes, issues & BCF",
        detailBody:
          "Run clash detection on federated models, review hits in context, and exchange issues via BCF " +
          "with other BIM tools on the project.",
        bullets: [
          "BVH/GJK clash tests between categories/models",
          "Clash review UI in the 3D view",
          "BCF import/export for issue round-trips",
          "Isolate and section around clash locations",
        ],
        howTo: "3D → Clash tools / Issues panel; open BCF from collaboration menus.",
      },
      {
        icon: "4D5", title: "4D & 5D delivery",
        desc: "Sequencing timelines and cost takeoff computed from model elements.",
        detailTitle: "4D sequencing & 5D quantities",
        detailBody:
          "Link model elements to time and cost: simulate construction sequences and extract quantities " +
          "for takeoff without leaving the federated model.",
        bullets: [
          "4D timeline / simulation panel",
          "Element phasing and visibility by phase",
          "Quantity takeoff and schedules from the model",
          "Export tables for cost workflows",
        ],
        howTo: "Open 4D Simulation and Schedules from the BIM Toolbox or Project Browser.",
      },
      {
        icon: "ENV", title: "Analysis & environment",
        desc: "Sun settings, daylighting and energy analysis on the analytical model.",
        detailTitle: "Environment & analysis",
        detailBody:
          "Study sun position, shading and environmental context on the model. Visual styles (shaded, " +
          "wireframe, hidden line) and section box support design review.",
        bullets: [
          "Sun / lighting controls",
          "Visual styles: shaded, edges, wireframe",
          "Section box and section plane",
          "Walk mode for experiential review",
        ],
        howTo: "View bar → visual style; Section Box / Walk from tools or Command Center (3D:).",
      },
    ],
    chips: ["IFC", "FEDERATION", "SECTION BOX", "WALK MODE", "VIEWCUBE", "SCHEDULES", "SHEETS", "IDS", "WORKSETS", "DESIGN OPTIONS", "POINT CLOUD"],
    cta: ["data-open3d", "Enter the 3D BIM platform"],
    overviewTitle: "Topic 02 — 3D BIM & Coordination",
    overviewBody:
      "Author, link IFC/FRAG models, coordinate disciplines, run clashes and deliver 4D/5D views. " +
      "Click a card for a focused explanation of each capability.",
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
      {
        icon: "CLD", title: "Cloud projects",
        desc: "Email or Google sign-in; the same vault opens from desktop, tablet or phone.",
        detailTitle: "Cloud projects & account",
        detailBody:
          "Stay local-first for files on disk, or sign in to open the same project vault from another device. " +
          "Projects and recent drawings stay within your control.",
        bullets: [
          "Account button on the welcome header",
          "Open the same vault across devices when signed in",
          "Local-first storage when offline",
          "Recent projects list on the home screen",
        ],
        howTo: "Use the account control on the welcome page, then create or open a project.",
      },
      {
        icon: "FMT", title: "Every format in, out",
        desc: "IFC, BCF, IDS, DWG/DXF, NWC bridge, SVG, JSON, GeoJSON and PostScript.",
        detailTitle: "Interoperability formats",
        detailBody:
          "Exchange open and industry formats without locking the team to one desktop suite. " +
          "IFC for BIM, DWG/DXF for CAD, BCF for issues, IDS for information requirements.",
        bullets: [
          "IFC link / native twin and federated export",
          "DWG/DXF 2D engine round-trip",
          "BCF and IDS validation",
          "SVG, JSON, GeoJSON and more export paths",
        ],
        howTo: "Link IFC from 3D; open DWG from 2D; use Output / Collaborate menus for BCF and exports.",
      },
      {
        icon: "SCH", title: "Schedules & sheets",
        desc: "Live schedules, sheet sets and drawing production with batch plot.",
        detailTitle: "Schedules, sheets & documentation",
        detailBody:
          "Produce documentation from the live model: schedules update with elements, sheets organize views, " +
          "and batch plot pushes sets to PDF.",
        bullets: [
          "Live schedules panel",
          "Sheets / documentation browser",
          "Batch plot and publish",
          "Drawing production tied to model views",
        ],
        howTo: "BIM Toolbox → Schedules / Sheets, or Project Browser.",
      },
      {
        icon: "AUT", title: "Automation & plugins",
        desc: "Generative design, automation pipelines and an installable plugin marketplace.",
        detailTitle: "Automation & plugins",
        detailBody:
          "Extend the platform with plugins and automation pipelines for repetitive tasks and generative design experiments.",
        bullets: [
          "Plugin system bootstrapped at startup",
          "Marketplace-style install path for extensions",
          "Automation hooks for batch workflows",
          "Agent bridge for external AI clients",
        ],
        howTo: "Manage plugins from the app shell; open Agent Bridge for external AI control.",
      },
      {
        icon: "AI", title: "AI command bar",
        desc: "Ask about the model in plain language — query, filter and navigate results.",
        detailTitle: "AI command bar & copilot",
        detailBody:
          "Ask questions in plain language about the open model or drawing. The AI panel helps query, " +
          "summarize and navigate without memorizing every command id.",
        bullets: [
          "AI chat panel docked in the shell",
          "Model-aware prompts for summaries and filters",
          "Command Center search for every registered tool",
          "Agent bridge for AlphaCLI-style external control",
        ],
        howTo: "Open the AI panel from the shell or type in the command palette (Ctrl+P).",
      },
      {
        icon: "L10", title: "10 languages · offline",
        desc: "Full UI translation incl. RTL Arabic; installable PWA that works offline.",
        detailTitle: "Languages & offline PWA",
        detailBody:
          "Switch the UI language from the welcome header. Arabic uses right-to-left layout. " +
          "Install as a PWA to keep working with local projects offline.",
        bullets: [
          "Ten UI languages including Arabic (RTL)",
          "Language button on the home header",
          "Installable progressive web app",
          "Local-first projects when the network is down",
        ],
        howTo: "Click the language control on the welcome page; use the browser install/PWA prompt if available.",
      },
    ],
    chips: ["IFC", "BCF", "IDS", "CLOUD", "PWA", "PLUGINS", "AI", "SCHEDULES", "SHEETS", "i18n"],
    cta: ["data-open3d", "Open the full platform"],
    overviewTitle: "Topic 03 — Deliver, Automate & Scale",
    overviewBody:
      "Handover, formats, cloud, automation, AI and localization. Click any card for a guided explanation " +
      "of how that capability fits your delivery workflow.",
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
   2D → full-screen drawing editor; opens a blank drawing, no BIM project needed.
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
      ["Commands", "169", "drafting command line"],
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
            <b class="obs-mega__title">Drawing Engine</b>
            <span class="obs-mega__desc">Draw, annotate and plot in a full-screen drafting session — opens instantly, even without a project.</span>
            <span class="obs-mega__specs">200+ COMMANDS · DWG/DXF r13–r2018 · LAYERS · HATCHES · PLOT</span>
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
          <button class="obs-btn" id="obs-2d-open" type="button" title="Open a DWG, DXF, PDF or LandXML file in the drafting engine">Open DWG / DXF / PDF\u2026</button>
          <input id="obs-2d-file" type="file" accept=".dwg,.dxf,.bak,.sv$,*.xml,.pdf" multiple hidden />
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
          <button type="button" class="obs-page__head obs-page__head--btn" data-topic-overview="${p.num}" title="Open topic ${p.num} overview">
            <span class="obs-page__num">${p.num}</span><span class="obs-page__eyebrow">${esc(p.eyebrow)}</span>
          </button>
          <h3 class="obs-page__title">${esc(p.title)}</h3>
          <p class="obs-page__copy">${esc(p.copy)}</p>
          <div class="obs-fgrid">
            ${p.cards.map((c, i) => `
            <button type="button" class="obs-fcard" data-topic="${p.num}" data-card="${i}" title="Learn more: ${esc(c.title)}">
              <span class="obs-fcard__icon" aria-hidden="true">${esc(c.icon)}</span>
              <span class="obs-fcard__body"><b>${esc(c.title)}</b><small>${esc(c.desc)}</small></span>
              <span class="obs-fcard__more" aria-hidden="true">Learn more →</span>
            </button>`).join("")}
          </div>
          <div class="obs-chiprow">${p.chips.map((c) => `<span class="obs-chip">${esc(c)}</span>`).join("")}</div>
          <button class="obs-page__cta" ${p.cta[0]} type="button">${esc(p.cta[1])} <span aria-hidden="true">→</span></button>
        </div>
        <div class="obs-page__visual" aria-hidden="true">
          ${p.cls === "obs-page--2d" ? VISUAL_2D : p.cls === "obs-page--3d" ? VISUAL_3D : VISUAL_DEL}
        </div>
      </article>`).join("")}
    </div>

    <div id="obs-topic-detail" class="obs-topic-detail" hidden></div>

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


  /* Topic explain pages — 01 / 02 / 03 cards & section headers */
  const topicHost = inner.querySelector("#obs-topic-detail") as HTMLElement | null;
  function closeTopicPage(): void {
    if (!topicHost) return;
    topicHost.hidden = true;
    topicHost.innerHTML = "";
    topicHost.classList.remove("is-open");
  }
  function openTopicPage(num: string, cardIndex: number | null): void {
    if (!topicHost) return;
    const page = SHOWCASE.find((s) => s.num === num);
    if (!page) return;
    const card = cardIndex != null ? page.cards[cardIndex] : null;
    const title = card ? card.detailTitle : page.overviewTitle;
    const body = card ? card.detailBody : page.overviewBody;
    const bullets = card ? card.bullets : page.cards.map((c) => `${c.title}: ${c.desc}`);
    const howTo = card ? card.howTo : "Pick a feature card on the welcome page for a step-by-step guide.";
    const visual = page.cls === "obs-page--2d" ? VISUAL_2D : page.cls === "obs-page--3d" ? VISUAL_3D : VISUAL_DEL;
    topicHost.hidden = false;
    topicHost.classList.add("is-open");
    topicHost.innerHTML = `
      <div class="obs-topic-detail__panel ${page.cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="obs-topic-detail__bar">
          <button type="button" class="obs-btn" data-topic-back>← Back to welcome</button>
          <span class="obs-topic-detail__num">${esc(page.num)}</span>
          <span class="obs-topic-detail__eye">${esc(page.eyebrow)}</span>
        </div>
        <div class="obs-topic-detail__grid">
          <div class="obs-topic-detail__text">
            <h2 class="obs-topic-detail__title">${esc(title)}</h2>
            <p class="obs-topic-detail__body">${esc(body)}</p>
            <ul class="obs-topic-detail__bullets">${bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
            <div class="obs-topic-detail__how"><strong>How to try it</strong><span>${esc(howTo)}</span></div>
            <div class="obs-topic-detail__actions">
              <button type="button" class="obs-page__cta" ${page.cta[0]}>${esc(page.cta[1])} <span aria-hidden="true">→</span></button>
              ${cardIndex == null ? page.cards.map((c, i) =>
                `<button type="button" class="obs-btn" data-topic="${page.num}" data-card="${i}">${esc(c.title)}</button>`
              ).join("") : `<button type="button" class="obs-btn" data-topic-overview="${page.num}">All of topic ${page.num}</button>`}
            </div>
          </div>
          <div class="obs-topic-detail__visual" aria-hidden="true">${visual}</div>
        </div>
      </div>`;
    topicHost.querySelector("[data-topic-back]")?.addEventListener("click", () => closeTopicPage());
    topicHost.querySelectorAll<HTMLElement>("[data-topic][data-card]").forEach((b) => {
      b.addEventListener("click", () => openTopicPage(b.dataset.topic!, Number(b.dataset.card)));
    });
    topicHost.querySelectorAll<HTMLElement>("[data-topic-overview]").forEach((b) => {
      b.addEventListener("click", () => openTopicPage(b.dataset.topicOverview!, null));
    });
    // re-bind CTA launchers inside detail
    topicHost.querySelectorAll<HTMLElement>("[data-open2d]").forEach((el) => {
      el.addEventListener("click", () => { closeTopicPage(); open2dEngine(); });
    });
    topicHost.querySelectorAll<HTMLElement>("[data-open3d]").forEach((el) => {
      el.addEventListener("click", () => { closeTopicPage(); open3dPlatform(); });
    });
    topicHost.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  inner.querySelectorAll<HTMLElement>("[data-topic][data-card]").forEach((b) => {
    b.addEventListener("click", () => openTopicPage(b.dataset.topic!, Number(b.dataset.card)));
  });
  inner.querySelectorAll<HTMLElement>("[data-topic-overview]").forEach((b) => {
    b.addEventListener("click", () => openTopicPage(b.dataset.topicOverview!, null));
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
      <span>${fmtNumber(s.elementCount)} objects</span><span class="sep">·</span>
      <span>${fmtNumber(s.modelCount)} model(s)</span><span class="sep">·</span>
      <span>${fmtNumber(s.issueCount)} issue(s)</span>
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
