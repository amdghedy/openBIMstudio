/** Open BIM Studio Project Center — enterprise-style local project launcher. */
import * as store from "../modules/projects/store";
import { createProject, openProject, deleteProjectById, getCurrentProject, onProjectChanged } from "../modules/projects/projects";
import type { ProjectTemplate } from "../modules/projects/types";

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

function emitWorkspace(id: string) {
  window.dispatchEvent(new CustomEvent("obs-workspace", { detail: { id } }));
  hideHome();
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
        <span class="obs-center-version">v52</span>
      </div>
    </header>

    <section class="obs-kpi-grid" id="obs-kpis"></section>

    <section class="obs-command-grid">
      <div class="obs-command-card obs-command-card--primary">
        <div class="obs-command-eyebrow">START A PROJECT</div>
        <h2>Set up a BIM workspace</h2>
        <p>Choose a delivery template. Project data stays in your browser unless you explicitly export it.</p>
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
      <div class="obs-command-card">
        <div class="obs-command-eyebrow">FAST ACCESS</div>
        <h2>Open BIM workflows</h2>
        <div class="obs-workspace-grid" id="obs-workspaces"></div>
      </div>
    </section>

    <section>
      <div class="obs-home__section-title">
        <span>Recent projects</span>
        <span class="obs-home__section-count" id="obs-count"></span>
      </div>
      <div class="obs-home__grid" id="obs-grid"></div>
    </section>

    <footer class="obs-home__footer">
      <span>Open BIM Studio · local project database · browser-first delivery</span>
      <span><kbd>Ctrl</kbd> <kbd>O</kbd> Open &nbsp;·&nbsp; <kbd>Ctrl</kbd> <kbd>S</kbd> Save &nbsp;·&nbsp; <kbd>Ctrl</kbd> <kbd>P</kbd> Commands</span>
    </footer>`;

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
  ws.innerHTML = WORKSPACES.map(([id, label, description]) => `
    <button class="obs-workspace-card" data-workspace="${id}">
      <span class="obs-workspace-card__marker"></span>
      <span class="obs-workspace-card__content">
        <b>${esc(label)}</b>
        <small>${esc(description)}</small>
      </span>
      <span class="obs-workspace-card__arrow">→</span>
    </button>`).join("");
  ws.querySelectorAll<HTMLButtonElement>("[data-workspace]").forEach((button) => {
    button.onclick = () => emitWorkspace(button.dataset.workspace ?? "coordination");
  });
}

function renderKpis(docs: any[]) {
  const kpi = inner.querySelector("#obs-kpis") as HTMLElement | null;
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
    if (!confirm(`Delete “${s.name}” and its stored models? This cannot be undone.`)) return;
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
  overlay.classList.add("is-open");
}
export function hideHome() { overlay.classList.remove("is-open"); }
export function setupHomeScreen() {
  buildStatic();
  document.body.appendChild(overlay);
  onProjectChanged(() => { if (getCurrentProject()) hideHome(); });
}
