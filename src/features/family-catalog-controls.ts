import { services } from "../core/services";
import { openFormModal } from "./form-modal";
import type { SharedParameterType } from "../modules/families/shared-parameters";
import type { TypeCatalog } from "../modules/families/type-catalog";

let observer: MutationObserver | null = null;
let installed = false;

function notify(message: string, kind: "success" | "error" | "warn" = "success"): void {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind, timeout: 3500 } }));
  } catch (error) {
    console.warn("[family-catalog] notification unavailable:", error);
  }
}

function createButton(label: string, action: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pf-btn";
  button.dataset.catalogAction = action;
  button.textContent = label;
  return button;
}

function renderSharedParameterManager(root: HTMLElement): void {
  root.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = "Shared Parameters";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.textContent = "Add parameter";
  addButton.addEventListener("click", () => {
    const allowed: SharedParameterType[] = ["number", "string", "boolean", "length", "area"];
    void openFormModal({
      title: "Add shared parameter",
      subtitle: "Create a reusable parameter definition.",
      width: 480,
      submitLabel: "Create parameter",
      fields: [
        {
          kind: "text",
          key: "name",
          label: "Parameter name",
          placeholder: "e.g. Fire Rating",
          validate: (value) => typeof value !== "string" || !value.trim()
            ? "Enter a parameter name."
            : null,
        },
        {
          kind: "text",
          key: "group",
          label: "Parameter group",
          default: "General",
          placeholder: "General",
        },
        {
          kind: "select",
          key: "type",
          label: "Data type",
          default: "string",
          options: allowed.map((type) => [type, type] as [string, string]),
        },
      ],
      onSubmit: (values) => {
        const name = String(values.name ?? "").trim();
        const group = String(values.group ?? "General").trim() || "General";
        const typeInput = String(values.type ?? "string");
        if (!allowed.includes(typeInput as SharedParameterType)) {
          notify(`Unsupported parameter type: ${typeInput}`, "error");
          return false;
        }
        try {
          services.use("sharedParameters").create({
            name,
            group,
            type: typeInput as SharedParameterType,
            defaultValue: "",
            isInstance: true,
          });
          renderSharedParameterManager(root);
          notify(`Created shared parameter "${name}".`);
          return true;
        } catch (error) {
          notify(error instanceof Error ? error.message : String(error), "error");
          return false;
        }
      },
    });
  });
  root.append(heading, addButton);
  try {
    for (const parameter of services.use("sharedParameters").list()) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #2a2e3a";
      const label = document.createElement("span");
      label.textContent = `${parameter.name} · ${parameter.group} · ${parameter.type}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => {
        services.use("sharedParameters").delete(parameter.guid);
        renderSharedParameterManager(root);
      });
      row.append(label, remove);
      root.appendChild(row);
    }
  } catch (error) {
    console.warn("[family-catalog] could not list parameters:", error);
  }
}

function openSharedParameters(): void {
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "max-width:600px;width:calc(100vw - 32px);max-height:80vh;overflow:auto;background:#181a23;color:#e8eaf0;border:1px solid #2a2e3a;border-radius:10px;padding:16px";
  const list = document.createElement("div");
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());
  dialog.append(list, close);
  document.body.appendChild(dialog);
  renderSharedParameterManager(list);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
}

function mountControls(): void {
  const familyPanel = document.querySelector<HTMLElement>("#obs-param-family-panel .pf-body");
  if (!familyPanel || familyPanel.querySelector("[data-family-catalog-controls]")) return;

  const controls = document.createElement("div");
  controls.dataset.familyCatalogControls = "true";
  controls.className = "pf-actions";
  const manage = createButton("Manage Shared Parameters", "manage-shared-parameters");
  const importButton = createButton("Import Type Catalog", "import-type-catalog");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".txt,.csv,text/plain,text/csv";
  fileInput.hidden = true;
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void services.use("typeCatalog").loadFromFile(file).then((catalog: TypeCatalog) => {
      window.dispatchEvent(new CustomEvent("obs:type-catalog-imported", { detail: catalog }));
      const status = document.querySelector<HTMLElement>("#obs-param-family-panel [data-status]");
      if (status) status.textContent = `Imported ${catalog.types.length} type(s) for ${catalog.familyName}.`;
      notify(`Imported ${catalog.types.length} type(s) for ${catalog.familyName}.`);
    }).catch((error: unknown) => {
      console.warn("[family-catalog] type catalog import failed:", error);
      notify(error instanceof Error ? error.message : String(error), "error");
    }).finally(() => { fileInput.value = ""; });
  });
  manage.addEventListener("click", openSharedParameters);
  importButton.addEventListener("click", () => fileInput.click());
  controls.append(manage, importButton, fileInput);
  familyPanel.appendChild(controls);
}

/** Adds shared-parameter and type-catalog controls to the parametric family panel. */
export function setupFamilyCatalogControls(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  mountControls();
  if (typeof MutationObserver !== "undefined" && document.body) {
    observer = new MutationObserver(mountControls);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener("beforeunload", () => observer?.disconnect(), { once: true });
}
