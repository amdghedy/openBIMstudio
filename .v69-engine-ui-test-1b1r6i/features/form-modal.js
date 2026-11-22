"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openFormModal = openFormModal;
exports.promptLine = promptLine;
exports.confirmDialog = confirmDialog;
exports.pickFromList = pickFromList;
exports.showTableDialog = showTableDialog;
exports.showObjectsDialog = showObjectsDialog;
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
const html_escape_1 = require("../core/html-escape");
let overlay = null;
let currentCard = null;
function ensureOverlay() {
    if (overlay && overlay.isConnected)
        return overlay;
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
        if (e.target === overlay)
            closeFormModal();
    });
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && overlay && overlay.style.display !== "none") {
            closeFormModal();
        }
    });
    document.body.appendChild(overlay);
    return overlay;
}
function closeFormModal() {
    if (overlay) {
        overlay.style.display = "none";
        if (currentCard) {
            currentCard.remove();
            currentCard = null;
        }
    }
}
/** Open a form modal and return a Promise resolving to field values. */
function openFormModal(options) {
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
        const inputs = {};
        const errorEls = {};
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
            let input;
            if (field.kind === "select") {
                input = document.createElement("select");
                input.style.cssText = inputStyle();
                for (const [value, lbl] of field.options ?? []) {
                    const opt = document.createElement("option");
                    opt.value = value;
                    opt.textContent = lbl;
                    if (String(field.default ?? "") === value)
                        opt.selected = true;
                    input.appendChild(opt);
                }
            }
            else if (field.kind === "textarea") {
                input = document.createElement("textarea");
                input.style.cssText = inputStyle() + ";min-height:60px;resize:vertical;font-family:inherit";
                input.value = String(field.default ?? "");
                if (field.placeholder)
                    input.placeholder = field.placeholder;
            }
            else if (field.kind === "checkbox") {
                input = document.createElement("input");
                input.type = "checkbox";
                input.checked = !!field.default;
                input.style.cssText = "width:16px;height:16px;cursor:pointer;accent-color:#22d3ee";
            }
            else {
                input = document.createElement("input");
                input.type = field.kind === "number" ? "number" : "text";
                input.value = String(field.default ?? "");
                input.style.cssText = inputStyle();
                if (field.placeholder)
                    input.placeholder = field.placeholder;
                if (field.kind === "number") {
                    if (field.min != null)
                        input.min = String(field.min);
                    if (field.max != null)
                        input.max = String(field.max);
                    if (field.step != null)
                        input.step = String(field.step);
                }
            }
            input.addEventListener("keydown", ((e) => {
                if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
                    void submit();
                }
            }));
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
        if (firstInput)
            firstInput.focus();
        function inputStyle() {
            return `
        flex:1;background:#0e1018;color:#e8eaf0;
        border:1px solid #2a2e3a;border-radius:5px;padding:8px 10px;
        font:13px system-ui,sans-serif;outline:none;
      `;
        }
        function btnStyle(primary) {
            return `
        padding:7px 16px;border-radius:5px;cursor:pointer;font-size:13px;font-weight:600;
        background:${primary ? "#0e7490" : "transparent"};
        color:${primary ? "#fff" : "#94a3b8"};
        border:1px solid ${primary ? "#0e7490" : "#2a2e3a"};
      `;
        }
        function escapeHtml(s) {
            return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
        }
        async function submit() {
            // Read all values.
            const values = {};
            let hasError = false;
            for (const field of options.fields) {
                if (field.kind === "divider")
                    continue;
                const el = inputs[field.key];
                let val;
                if (field.kind === "checkbox") {
                    val = el.checked;
                }
                else if (field.kind === "number") {
                    val = parseFloat(el.value);
                    if (isNaN(val))
                        val = field.default ?? 0;
                }
                else if (field.kind === "select") {
                    val = el.value;
                }
                else {
                    val = el.value;
                }
                values[field.key] = val;
                // Run validator.
                if (field.validate) {
                    const err = field.validate(val, values);
                    if (err) {
                        errorEls[field.key].textContent = err;
                        errorEls[field.key].style.display = "block";
                        hasError = true;
                    }
                    else {
                        errorEls[field.key].style.display = "none";
                    }
                }
            }
            if (hasError)
                return;
            // onSubmit hook.
            if (options.onSubmit) {
                const ok = await options.onSubmit(values);
                if (!ok)
                    return;
            }
            closeFormModal();
            resolve(values);
        }
    });
}
/** Quick helper for a single-value prompt replacement. */
async function promptLine(title, label, defaultValue = "", placeholder, hint) {
    const result = await openFormModal({
        title,
        fields: [{ kind: "text", key: "value", label, default: defaultValue, placeholder, hint }],
    });
    return result ? String(result.value) : null;
}
/** Quick helper for a confirmation dialog. */
async function confirmDialog(title, message) {
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
async function pickFromList(title, label, options, defaultValue) {
    const result = await openFormModal({
        title,
        fields: [{
                kind: "select",
                key: "value",
                label,
                options: options.map((o) => [o.value, o.label]),
                default: defaultValue,
            }],
    });
    return result ? String(result.value) : null;
}
/** Read-only table dialog (replaces "see console" / console.table results). */
function showTableDialog(title, columns, rows, subtitle) {
    return new Promise((resolve) => {
        const ov = ensureOverlay();
        ov.innerHTML = "";
        const card = document.createElement("div");
        card.style.cssText = `
      width: min(760px, 94vw); max-height: 86vh; display:flex; flex-direction:column;
      background:#1c1e28; color:#e8eaf0; border:1px solid #2a2e3a; border-radius:10px;
      box-shadow:0 24px 60px rgba(0,0,0,.65); font:13px system-ui,sans-serif; overflow:hidden;
    `;
        const header = document.createElement("div");
        header.style.cssText = "padding:14px 18px;border-bottom:1px solid #2a2e3a;background:#181a23";
        header.innerHTML = `<div style="font-weight:700;font-size:15px">${(0, html_escape_1.escapeHtml)(title)}</div>` +
            (subtitle ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px">${(0, html_escape_1.escapeHtml)(subtitle)}</div>` : "");
        const body = document.createElement("div");
        body.style.cssText = "overflow:auto;padding:0";
        if (!rows.length) {
            body.innerHTML = `<div style="padding:18px;color:#94a3b8">Nothing to show.</div>`;
        }
        else {
            const th = columns.map((c) => `<th style="text-align:start;padding:7px 12px;position:sticky;top:0;background:#222637;border-bottom:1px solid #2a2e3a;font-weight:600">${(0, html_escape_1.escapeHtml)(c)}</th>`).join("");
            const tr = rows.map((r) => `<tr>${r.map((v) => `<td style="padding:6px 12px;border-bottom:1px solid #232736">${(0, html_escape_1.escapeHtml)(String(v))}</td>`).join("")}</tr>`).join("");
            body.innerHTML = `<table style="width:100%;border-collapse:collapse"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
        }
        const footer = document.createElement("div");
        footer.style.cssText = "padding:10px 18px;border-top:1px solid #2a2e3a;background:#181a23;display:flex;justify-content:space-between;align-items:center";
        const count = document.createElement("span");
        count.style.cssText = "color:#94a3b8;font-size:12px";
        count.textContent = `${rows.length} row(s)`;
        const close = document.createElement("button");
        close.textContent = "Close";
        close.style.cssText = "padding:7px 16px;border-radius:5px;cursor:pointer;background:#0e7490;color:#fff;border:1px solid #0e7490;font-size:13px;font-weight:600";
        close.onclick = () => { closeFormModal(); resolve(); };
        footer.append(count, close);
        card.append(header, body, footer);
        ov.appendChild(card);
        ov.style.display = "flex";
    });
}
/** Read-only dialog for a list of plain objects; columns come from the union of their keys. */
function showObjectsDialog(title, objs, subtitle) {
    const cols = [...new Set(objs.flatMap((o) => Object.keys(o)))];
    const fmt = (v) => typeof v === "number" ? (Number.isInteger(v) ? v : Number(v.toFixed(3))) : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return showTableDialog(title, cols, objs.map((o) => cols.map((c) => fmt(o[c]))), subtitle);
}
