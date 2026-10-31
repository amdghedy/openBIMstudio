/**
 * Language switcher — the top-left globe button.
 *
 * Mounted as the FIRST element of the Project Center header and of the
 * workspace ribbon tab row, so it always sits in the upper-left corner of
 * whatever screen the user is on. Opens a dropdown listing the most common
 * languages (native names); choosing one updates the i18n service locale
 * (persistence, RTL, font stack) and the DOM translation layer rewrites
 * every translated string on the site.
 */
import { i18n, type Locale } from "../core/i18n";
import { LANGS, langDef, currentDomLang } from "../core/dom-translate";

const STYLE = `
.obs-lang{position:relative;display:inline-flex;align-items:center;z-index:80;flex:0 0 auto}
.obs-lang__btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;
  border-radius:8px;border:1px solid rgba(148,163,184,.28);background:rgba(15,20,28,.72);
  color:#cbd5e1;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer;
  transition:background .15s,border-color .15s,color .15s}
.obs-lang__btn:hover{background:rgba(56,189,248,.14);border-color:rgba(56,189,248,.5);color:#e2e8f0}
.obs-lang__btn svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;
  stroke-linecap:round;stroke-linejoin:round}
.obs-lang__menu{position:fixed;min-width:200px;padding:6px;
  border-radius:10px;border:1px solid rgba(148,163,184,.25);background:#0d1219;
  box-shadow:0 12px 32px rgba(0,0,0,.55);display:none;z-index:9600}
.obs-lang.is-open .obs-lang__menu{display:block}
.obs-lang__menu-title{padding:6px 8px 4px;font:600 10px/1 ui-monospace,monospace;
  letter-spacing:.08em;text-transform:uppercase;color:#64748b}
.obs-lang__item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;
  border-radius:7px;background:transparent;color:#cbd5e1;font:13px/1.2 system-ui,sans-serif;
  text-align:left;cursor:pointer}
.obs-lang__item:hover{background:rgba(56,189,248,.12)}
.obs-lang__item[aria-checked="true"]{background:rgba(56,189,248,.18);color:#f0f9ff}
.obs-lang__item .code{margin-left:auto;font:600 10px/1 ui-monospace,monospace;color:#64748b}
.obs-lang__item .tick{width:12px;color:#38bdf8;font-weight:700}
html[dir="rtl"] .obs-lang__item{text-align:right}
html[dir="rtl"] .obs-lang__item .code{margin-left:0;margin-right:auto}
`

/** The ribbon tab row clips overflow (overflow-y:hidden), so the dropdown is
 *  positioned fixed against the viewport at open time — immune to ancestor
 *  clipping, valid on both the home header and the ribbon. */
function positionMenu(wrap: HTMLDivElement): void {
  const btn = wrap.querySelector(".obs-lang__btn") as HTMLElement | null;
  const menu = wrap.querySelector(".obs-lang__menu") as HTMLElement | null;
  if (!btn || !menu) return;
  menu.style.top = "";
  menu.style.left = "";
  menu.style.right = "";
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth || 200;
  const rtl = document.documentElement.dir === "rtl";
  if (rtl && r.left + mw > window.innerWidth - 8) {
    menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  } else {
    menu.style.left = `${Math.min(r.left, Math.max(8, window.innerWidth - mw - 8))}px`;
  }
  menu.style.top = `${r.bottom + 6}px`;
}

const GLOBE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/>
<path d="M3 12h18M12 3c2.6 2.5 3.9 5.5 3.9 9S14.6 18.5 12 21c-2.6-2.5-3.9-5.5-3.9-9S9.4 5.5 12 3z"/></svg>`;

let instances: HTMLDivElement[] = [];

function refreshAll(): void {
  for (const el of instances) {
    if (!el.isConnected) continue;
    refresh(el);
  }
}

function refresh(el: HTMLDivElement): void {
  const code = currentDomLang();
  const label = el.querySelector(".obs-lang__code") as HTMLElement | null;
  if (label) label.textContent = code.toUpperCase();
  const title = el.querySelector(".obs-lang__menu-title") as HTMLElement | null;
  if (title) title.textContent = langDef(code).native;
  const btn = el.querySelector(".obs-lang__btn") as HTMLElement | null;
  if (btn) btn.title = langDef(code).native;
  for (const item of Array.from(el.querySelectorAll<HTMLButtonElement>("[data-lang]"))) {
    item.setAttribute("aria-checked", item.dataset.lang === code ? "true" : "false");
  }
}

function select(code: string): void {
  const def = langDef(code);
  // One source of truth: the i18n service persists `obs.locale`, applies
  // <html lang/dir> + font stack, and fires obs-locale-changed — which the
  // DOM translation layer follows to rewrite every translated string.
  i18n.setLocale((def.serviceLocale ?? def.code) as Locale);
  refreshAll();
}

function build(): HTMLDivElement {
  if (!document.getElementById("obs-i18n-style")) {
    const style = document.createElement("style");
    style.id = "obs-i18n-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  const wrap = document.createElement("div");
  wrap.className = "obs-lang";
  wrap.dataset.i18nSkip = "1";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "obs-lang__btn";
  btn.innerHTML = `${GLOBE_SVG}<span class="obs-lang__code"></span>`;

  const menu = document.createElement("div");
  menu.className = "obs-lang__menu";
  menu.setAttribute("role", "listbox");
  const title = document.createElement("div");
  title.className = "obs-lang__menu-title";
  menu.appendChild(title);
  for (const lang of LANGS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "obs-lang__item";
    item.dataset.lang = lang.code;
    item.setAttribute("role", "option");
    item.setAttribute("dir", lang.dir);
    item.innerHTML =
      `<span class="tick"></span><span class="name"></span><span class="code">${lang.code.toUpperCase()}</span>`;
    (item.querySelector(".name") as HTMLElement).textContent = lang.native;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      select(lang.code);
      wrap.classList.remove("is-open");
    });
    menu.appendChild(item);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    refresh(wrap);
    const opening = !wrap.classList.contains("is-open");
    wrap.classList.toggle("is-open");
    if (opening) positionMenu(wrap);
  });
  wrap.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => wrap.classList.remove("is-open"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") wrap.classList.remove("is-open");
  });
  window.addEventListener("obs-dom-lang-changed", refreshAll);

  wrap.append(btn, menu);
  instances.push(wrap);
  refresh(wrap);
  return wrap;
}

/**
 * Mount a language button as the first child of `parent` (the Project
 * Center header or the ribbon tab row). Each mount point owns its own
 * instance — the ribbon wipes its row on every tab change, so detached
 * instances are reused instead of leaking.
 */
export function mountLanguageButton(parent: Element | null | undefined): void {
  if (!parent) return;
  if (instances.some((el) => el.parentElement === parent)) return;
  // Reuse a detached instance (e.g. dropped by renderTabs innerHTML wipe).
  let el = instances.find((i) => !i.isConnected);
  if (!el) el = build();
  parent.insertBefore(el, parent.firstChild);
}
