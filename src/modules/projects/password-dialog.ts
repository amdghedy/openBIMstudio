/** Small modal that asks for a password (masked). Resolves null when cancelled. */
export function askPassword(opts: { title: string; message?: string; confirm?: boolean; okLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
    const box = document.createElement("form");
    box.style.cssText = "background:#141821;color:#e8eaf0;border:1px solid #2a2e3a;border-radius:10px;padding:18px 20px;width:340px;font:13px system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6)";
    const h = document.createElement("div");
    h.textContent = opts.title; h.style.cssText = "font-weight:700;font-size:14px;margin-bottom:6px";
    box.appendChild(h);
    if (opts.message) { const m = document.createElement("div"); m.textContent = opts.message; m.style.cssText = "opacity:.75;margin-bottom:10px;line-height:1.4"; box.appendChild(m); }
    const mk = (ph: string) => {
      const i = document.createElement("input");
      i.type = "password"; i.placeholder = ph; i.autocomplete = "off";
      i.style.cssText = "width:100%;box-sizing:border-box;margin:4px 0;padding:8px;background:#0e1017;border:1px solid #2a2e3a;border-radius:6px;color:#e8eaf0";
      return i;
    };
    const p1 = mk("Password"); box.appendChild(p1);
    const p2 = opts.confirm ? mk("Repeat password") : null; if (p2) box.appendChild(p2);
    const err = document.createElement("div"); err.style.cssText = "color:#fca5a5;min-height:16px;font-size:12px;margin:4px 0"; box.appendChild(err);
    const row = document.createElement("div"); row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel";
    const ok = document.createElement("button"); ok.type = "submit"; ok.textContent = opts.okLabel ?? "OK";
    for (const b of [cancel, ok]) b.style.cssText = "padding:7px 14px;border-radius:6px;border:1px solid #2a2e3a;cursor:pointer;background:#1e2430;color:#e8eaf0";
    ok.style.background = "#2563eb"; ok.style.borderColor = "#2563eb";
    row.append(cancel, ok); box.appendChild(row);
    const done = (v: string | null) => { wrap.remove(); resolve(v); };
    cancel.onclick = () => done(null);
    wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); e.stopPropagation(); });
    box.onsubmit = (e) => {
      e.preventDefault();
      if (!p1.value) { err.textContent = "Enter a password."; return; }
      if (p2 && p1.value !== p2.value) { err.textContent = "The passwords don't match."; return; }
      if (p2 && p1.value.length < 8) { err.textContent = "Use at least 8 characters."; return; }
      done(p1.value);
    };
    wrap.appendChild(box); document.body.appendChild(wrap);
    p1.focus();
  });
}
