/**
 * Reusable form-modal dialog — replaces ad-hoc `prompt()` calls in the ribbon.
 *
 * Builds a styled modal dialog with arbitrary form fields (text, number,
 * select, checkbox) and a submit/cancel footer. Returns a Promise that
 * resolves with the field values when submitted, or null if cancelled.
 *
 * Visual style matches the existing .obs-modal design (dark card, cyan
 * accents) so it feels native to the rest of the app.
 */

export type FieldKind = "text" | "number" | "select" | "checkbox" | "textarea" | "divider";

export interface Field {
  kind: FieldKind;
  /** Field key — appears as the key in the resolved values object. */
  key: string;
  /** Display label. */
  label: string;
  /** Default value (string / number / boolean). */
  default?: string | number | boolean;
  /** For select fields: array of [value, label] tuples. */
  options?: Array<[string, string]>;
  /** HTML placeholder for text inputs. */
  placeholder?: string;
  /** Min/max for number inputs. */
  min?: number;
  max?: number;
  /** Step for number inputs. */
  step?: number;
  /** Suffix unit displayed after the input (e.g. "m", "m³/s"). */
  unit?: string;
  /** Help text shown below the field. */
  hint?: string;
  /** Validate the value — return an error string, or null if valid. */
  validate?: (value: string | number | boolean, allValues: Record<string, any>) => string | null;
}

export interface FormModalOptions {
  /** Dialog title. */
  title: string;
  /** Optional subtitle / context line. */
  subtitle?: string;
  /** Form fields. */
  fields: Field[];
  /** Submit button text (default: "OK"). */
  submitLabel?: string;
  /** Cancel button text (default: "Cancel"). */
  cancelLabel?: string;
  /** Width in pixels (default: 520). */
  width?: number;
  /** Called when the user submits — return false to keep dialog open. */
  onSubmit?: (values: Record<string, any>) => boolean | Promise<boolean>;
}

let overlay: HTMLDivElement | null = null;
let currentCard: HTMLDivElement | null = null;

function ensureOverlay(): HTMLDivElement {
  if (overlay && overlay.isConnected) return overlay;
  overlay = document.createElement("div");
  overlay.className = "obs-form-modal-overlay";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 100000;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
    display: none;
    align-items: center; justify-content: center;
    font: 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  `;
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) closeFormModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay && overlay.style.display !== "none") {
      closeFormModal();
    }
  });
  document.body.appendChild(overlay);
  return overlay;
}

function closeFormModal(): void {
  if (overlay) {
    overlay.style.display = "none";
    if (currentCard) {
      currentCard.remove();
      currentCard = null;
    }
  }
}

/** Open a form modal and return a Promise resolving to field values. */
export function openFormModal(options: FormModalOptions): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    ov.innerHTML = "";
    const w = options.width ?? 520;
    const card = document.createElement("div");
    card.className = "obs-form-modal";
    card.style.cssText = `
      width: min(${w}px, 92vw);
      max-height: 88vh; overflow-y: auto;
      background: #1c1e28; color: #e8eaf0;
      border: 1px solid #2a2e3a; border-radius: 10px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, .65);
      display: flex; flex-direction: column;
    `;
    currentCard = card;

    // ── Header ──────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.style.cssText = `
      display: flex; align-items: center; gap: 12px;
      padding: 14px 18px;
      border-bottom: 1px solid #2a2e3a; background: #181a23;
    `;
    const titleWrap = document.createElement("div");
    titleWrap.style.flex = "1";
    titleWrap.innerHTML = `
      <div style="font-weight:700;font-size:15px">${escapeHtml(options.title)}</div>
      ${options.subtitle ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px">${escapeHtml(options.subtitle)}</div>` : ""}
    `;
    header.appendChild(titleWrap);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = `
      width:28px;height:28px;border-radius:4px;background:transparent;
      color:#94a3b8;border:1px solid #2a2e3a;cursor:pointer;font-size:13px;
    `;
    closeBtn.onclick = () => { closeFormModal(); resolve(null); };
    header.appendChild(closeBtn);
    card.appendChild(header);

    // ── Body — fields ───────────────────────────────────────────────────
    const body = document.createElement("div");
    body.style.cssText = "padding: 14px 18px; display: flex; flex-direction: column; gap: 12px;";
    const inputs: Record<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> = {};
    const errorEls: Record<string, HTMLDivElement> = {};
    for (const field of options.fields) {
      if (field.kind === "divider") {
        const div = document.createElement("hr");
        div.style.cssText = "border:none;border-top:1px solid #2a2e3a;margin:4px 0";
        body.appendChild(div);
        continue;
      }
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
      // Label
      const label = document.createElement("label");
      label.textContent = field.label;
      label.style.cssText = "color:#94a3b8;font-size:12px;font-weight:600";
      wrap.appendChild(label);
      // Input + unit
      const inputRow = document.createElement("div");
      inputRow.style.cssText = "display:flex;align-items:center;gap:6px";
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (field.kind === "select") {
        input = document.createElement("select");
        input.style.cssText = inputStyle();
        for (const [value, lbl] of field.options ?? []) {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = lbl;
          if (String(field.default ?? "") === value) opt.selected = true;
          input.appendChild(opt);
        }
      } else if (field.kind === "textarea") {
        input = document.createElement("textarea");
        input.style.cssText = inputStyle() + ";min-height:60px;resize:vertical;font-family:inherit";
        input.value = String(field.default ?? "");
        if (field.placeholder) input.placeholder = field.placeholder;
      } else if (field.kind === "checkbox") {
        input = document.createElement("input");
        input.type = "checkbox";
        (input as HTMLInputElement).checked = !!field.default;
        input.style.cssText = "width:16px;height:16px;cursor:pointer;accent-color:#22d3ee";
      } else {
        input = document.createElement("input");
        input.type = field.kind === "number" ? "number" : "text";
        input.value = String(field.default ?? "");
        input.style.cssText = inputStyle();
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.kind === "number") {
          if (field.min != null) (input as HTMLInputElement).min = String(field.min);
          if (field.max != null) (input as HTMLInputElement).max = String(field.max);
          if (field.step != null) (input as HTMLInputElement).step = String(field.step);
        }
      }
      input.addEventListener("keydown", ((e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") {
          void submit();
        }
      }) as EventListener);
      inputs[field.key] = input;
      inputRow.appendChild(input);
      if (field.unit) {
        const unit = document.createElement("span");
        unit.textContent = field.unit;
        unit.style.cssText = "color:#64748b;font-size:12px;min-width:24px";
        inputRow.appendChild(unit);
      }
      wrap.appendChild(inputRow);
      // Hint
      if (field.hint) {
        const hint = document.createElement("div");
        hint.textContent = field.hint;
        hint.style.cssText = "color:#64748b;font-size:11px";
        wrap.appendChild(hint);
      }
      // Error slot
      const err = document.createElement("div");
      err.style.cssText = "color:#f87171;font-size:11px;display:none";
      errorEls[field.key] = err;
      wrap.appendChild(err);
      body.appendChild(wrap);
    }
    card.appendChild(body);

    // ── Footer ──────────────────────────────────────────────────────────
    const footer = document.createElement("div");
    footer.style.cssText = `
      padding: 10px 18px; border-top: 1px solid #2a2e3a; background: #181a23;
      display: flex; justify-content: flex-end; gap: 8px;
    `;
    const cancel = document.createElement("button");
    cancel.textContent = options.cancelLabel ?? "Cancel";
    cancel.style.cssText = btnStyle(false);
    cancel.onclick = () => { closeFormModal(); resolve(null); };
    const submitBtn = document.createElement("button");
    submitBtn.textContent = options.submitLabel ?? "OK";
    submitBtn.style.cssText = btnStyle(true);
    submitBtn.onclick = () => { void submit(); };
    footer.append(cancel, submitBtn);
    card.appendChild(footer);

    ov.appendChild(card);
    ov.style.display = "flex";

    // Focus first input.
    const firstInput = Object.values(inputs)[0];
    if (firstInput) (firstInput as HTMLElement).focus();

    function inputStyle(): string {
      return `
        flex:1;background:#0e1018;color:#e8eaf0;
        border:1px solid #2a2e3a;border-radius:5px;padding:8px 10px;
        font:13px system-ui,sans-serif;outline:none;
      `;
    }
    function btnStyle(primary: boolean): string {
      return `
        padding:7px 16px;border-radius:5px;cursor:pointer;font-size:13px;font-weight:600;
        background:${primary ? "#0e7490" : "transparent"};
        color:${primary ? "#fff" : "#94a3b8"};
        border:1px solid ${primary ? "#0e7490" : "#2a2e3a"};
      `;
    }
    function escapeHtml(s: string): string {
      return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    }

    async function submit(): Promise<void> {
      // Read all values.
      const values: Record<string, any> = {};
      let hasError = false;
      for (const field of options.fields) {
        if (field.kind === "divider") continue;
        const el = inputs[field.key];
        let val: any;
        if (field.kind === "checkbox") {
          val = (el as HTMLInputElement).checked;
        } else if (field.kind === "number") {
          val = parseFloat((el as HTMLInputElement).value);
          if (isNaN(val)) val = field.default ?? 0;
        } else if (field.kind === "select") {
          val = (el as HTMLSelectElement).value;
        } else {
          val = (el as HTMLInputElement | HTMLTextAreaElement).value;
        }
        values[field.key] = val;
        // Run validator.
        if (field.validate) {
          const err = field.validate(val, values);
          if (err) {
            errorEls[field.key].textContent = err;
            errorEls[field.key].style.display = "block";
            hasError = true;
          } else {
            errorEls[field.key].style.display = "none";
          }
        }
      }
      if (hasError) return;
      // onSubmit hook.
      if (options.onSubmit) {
        const ok = await options.onSubmit(values);
        if (!ok) return;
      }
      closeFormModal();
      resolve(values);
    }
  });
}

/** Quick helper for a single-value prompt replacement. */
export async function promptLine(
  title: string,
  label: string,
  defaultValue = "",
  placeholder?: string,
  hint?: string,
): Promise<string | null> {
  const result = await openFormModal({
    title,
    fields: [{ kind: "text", key: "value", label, default: defaultValue, placeholder, hint }],
  });
  return result ? String(result.value) : null;
}

/** Quick helper for a confirmation dialog. */
export async function confirmDialog(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    ov.innerHTML = "";
    const card = document.createElement("div");
    card.style.cssText = `
      width: min(420px, 92vw); background: #1c1e28; color: #e8eaf0;
      border: 1px solid #2a2e3a; border-radius: 10px;
      box-shadow: 0 24px 60px rgba(0,0,0,.65);
      font: 13px system-ui, sans-serif; overflow: hidden;
    `;
    const header = document.createElement("div");
    header.style.cssText = "padding:14px 18px;border-bottom:1px solid #2a2e3a;background:#181a23;font-weight:700;font-size:15px";
    header.textContent = title;
    const body = document.createElement("div");
    body.style.cssText = "padding:14px 18px;color:#cbd5e1;line-height:1.5";
    body.textContent = message;
    const footer = document.createElement("div");
    footer.style.cssText = "padding:10px 18px;border-top:1px solid #2a2e3a;background:#181a23;display:flex;justify-content:flex-end;gap:8px";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = "padding:7px 16px;border-radius:5px;cursor:pointer;background:transparent;color:#94a3b8;border:1px solid #2a2e3a;font-size:13px";
    cancel.onclick = () => { closeFormModal(); resolve(false); };
    const ok = document.createElement("button");
    ok.textContent = "Confirm";
    ok.style.cssText = "padding:7px 16px;border-radius:5px;cursor:pointer;background:#0e7490;color:#fff;border:1px solid #0e7490;font-size:13px;font-weight:600";
    ok.onclick = () => { closeFormModal(); resolve(true); };
    footer.append(cancel, ok);
    card.append(header, body, footer);
    ov.appendChild(card);
    ov.style.display = "flex";
  });
}

/** Quick helper to show a picker for one of N options (replaces `prompt("1..N")`). */
export async function pickFromList(
  title: string,
  label: string,
  options: Array<{ value: string; label: string }>,
  defaultValue?: string,
): Promise<string | null> {
  const result = await openFormModal({
    title,
    fields: [{
      kind: "select",
      key: "value",
      label,
      options: options.map((o) => [o.value, o.label] as [string, string]),
      default: defaultValue,
    }],
  });
  return result ? String(result.value) : null;
}
