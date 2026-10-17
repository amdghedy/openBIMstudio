/** Project control center — professional project metadata and delivery settings. */
import { getCurrentProject, isDirty, saveProject, updateProjectMeta } from "../modules/projects/projects";
import type { ProjectStatus, ProjectUnits } from "../modules/projects/types";

let open = false;
let overlay: HTMLDivElement | null = null;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>\"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" } as Record<string, string>)[c],
);

function field(label: string, id: string, value: string, placeholder = ""): string {
  return `
    <label class="obs-meta-field">
      <span>${esc(label)}</span>
      <input id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" />
    </label>`;
}

function build(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "obs-modal-overlay";
  el.innerHTML = `
    <div class="obs-modal obs-project-info" role="dialog" aria-modal="true" aria-labelledby="obs-project-info-title">
      <div class="obs-modal__header">
        <div>
          <div class="obs-modal__eyebrow">PROJECT CONTROL CENTER</div>
          <h2 id="obs-project-info-title">Project Information</h2>
          <p>Keep project identity, delivery stage and model units consistent across the BIM workspace.</p>
        </div>
        <button class="obs-modal__close" id="obs-project-info-close" aria-label="Close">×</button>
      </div>
      <div class="obs-modal__body">
        <section class="obs-meta-section">
          <div class="obs-meta-section__title">Project identity</div>
          <div class="obs-meta-grid obs-meta-grid--2">
            ${field("Project name", "obs-meta-name", "", "e.g. HSR PK3 MEP Stations")}
            ${field("Project number", "obs-meta-number", "", "e.g. PK3-MEP-001")}
            ${field("Client / owner", "obs-meta-client", "", "Client or JV")}
            ${field("Delivery phase", "obs-meta-phase", "", "Design / Construction / As-built")}
          </div>
          <label class="obs-meta-field">
            <span>Project description</span>
            <textarea id="obs-meta-description" rows="3" placeholder="Purpose, scope and key delivery notes"></textarea>
          </label>
        </section>
        <section class="obs-meta-section">
          <div class="obs-meta-section__title">Delivery settings</div>
          <div class="obs-meta-grid obs-meta-grid--2">
            <label class="obs-meta-field">
              <span>Status</span>
              <select id="obs-meta-status">
                <option value="active">Active</option>
                <option value="on-hold">On hold</option>
                <option value="complete">Complete</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <label class="obs-meta-field">
              <span>Project units</span>
              <select id="obs-meta-units">
                <option value="metric">Metric (m / mm)</option>
                <option value="imperial">Imperial (ft / in)</option>
              </select>
            </label>
            ${field("Project owner", "obs-meta-owner", "", "Team / company")}
            <div class="obs-meta-facts" id="obs-meta-facts"></div>
          </div>
        </section>
      </div>
      <div class="obs-modal__footer">
        <span class="obs-modal__dirty" id="obs-meta-dirty"></span>
        <div class="obs-modal__actions">
          <button class="obs-btn" id="obs-project-info-cancel">Cancel</button>
          <button class="obs-btn obs-btn--primary" id="obs-project-info-save">Save project settings</button>
        </div>
      </div>
    </div>`;

  el.addEventListener("click", (e) => {
    if (e.target === el) closeProjectInfo();
  });
  el.querySelector("#obs-project-info-close")?.addEventListener("click", closeProjectInfo);
  el.querySelector("#obs-project-info-cancel")?.addEventListener("click", closeProjectInfo);
  el.querySelector("#obs-project-info-save")?.addEventListener("click", () => {
    const project = getCurrentProject();
    if (!project) return;
    updateProjectMeta({
      name: value("obs-meta-name"),
      projectNumber: value("obs-meta-number"),
      client: value("obs-meta-client"),
      phase: value("obs-meta-phase"),
      description: value("obs-meta-description"),
      owner: value("obs-meta-owner"),
      status: selectValue("obs-meta-status") as ProjectStatus,
      units: selectValue("obs-meta-units") as ProjectUnits,
    });
    void saveProject();
    closeProjectInfo();
  });
  return el;
}

function value(id: string): string {
  return String((document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "");
}
function selectValue(id: string): string {
  return String((document.getElementById(id) as HTMLSelectElement | null)?.value ?? "");
}

function refresh(): void {
  const project = getCurrentProject();
  if (!project || !overlay) return;
  (overlay.querySelector("#obs-meta-name") as HTMLInputElement).value = project.name ?? "";
  (overlay.querySelector("#obs-meta-number") as HTMLInputElement).value = project.projectNumber ?? "";
  (overlay.querySelector("#obs-meta-client") as HTMLInputElement).value = project.client ?? "";
  (overlay.querySelector("#obs-meta-phase") as HTMLInputElement).value = project.phase ?? "";
  (overlay.querySelector("#obs-meta-owner") as HTMLInputElement).value = project.owner ?? "";
  (overlay.querySelector("#obs-meta-description") as HTMLTextAreaElement).value = project.description ?? "";
  (overlay.querySelector("#obs-meta-status") as HTMLSelectElement).value = project.status ?? "active";
  (overlay.querySelector("#obs-meta-units") as HTMLSelectElement).value = project.units ?? "metric";

  const facts = overlay.querySelector("#obs-meta-facts");
  if (facts) {
    const models = project.models?.length ?? 0;
    const elements = project.elements?.length ?? 0;
    const issues = project.issues?.length ?? 0;
    facts.innerHTML = `
      <div><span>Linked models</span><b>${models}</b></div>
      <div><span>Authored elements</span><b>${elements}</b></div>
      <div><span>Coordination issues</span><b>${issues}</b></div>`;
  }

  const dirty = overlay.querySelector("#obs-meta-dirty");
  if (dirty) dirty.textContent = isDirty() ? "Unsaved project changes" : "All project data saved";
}

export function openProjectInfo(): void {
  if (!getCurrentProject()) return;
  if (!overlay) {
    overlay = build();
    document.body.appendChild(overlay);
  }
  refresh();
  overlay.classList.add("is-open");
  open = true;
  const input = overlay.querySelector("#obs-meta-name") as HTMLInputElement | null;
  input?.focus();
  input?.select();
}

export function closeProjectInfo(): void {
  overlay?.classList.remove("is-open");
  open = false;
}

export function isProjectInfoOpen(): boolean { return open; }
