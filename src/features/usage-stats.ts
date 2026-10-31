/** Cumulative usage tracking + welcome badge. Self-contained, no ctx dependency. */
const STORAGE_KEY = 'obs.usage.v1';
const CLICK_DEBOUNCE_MS = 400;
const SESSION_GAP_MS = 30 * 60 * 1000;
const COUNTRY_CACHE_MS = 24 * 60 * 60 * 1000;
const GLOBAL_CACHE_MS = 24 * 60 * 60 * 1000;
const STYLE_ID = 'obs-usage-style';

function getEnv(key: string): string | undefined {
  try {
    const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
    return meta?.env?.[key];
  } catch { return undefined; }
}
const COUNTER_API = getEnv('VITE_COUNTER_API') ?? 'https://api.counterapi.dev/v1/openbimstudio/visits';
const GEO_API = getEnv('VITE_GEO_API') ?? 'https://ipapi.co/json/';

export interface LocalUsage {
  clicks: number;
  visits: number;
  sessions: number;
  streak: number;
  firstSeen: number;
  lastSeen: number;
  lastVisitDay: string;
  lastSessionStart: number;
  countryCode: string;
  countryName: string;
  countryFlag: string;
  countryDetectedAt: number;
  globalVisits: number;
  globalFetchedAt: number;
}

const todayKey = (): string => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};
const yesterdayKey = (): string => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

function defaults(): LocalUsage {
  const now = Date.now();
  return {
    clicks: 0, visits: 0, sessions: 0, streak: 0,
    firstSeen: now, lastSeen: now, lastVisitDay: '', lastSessionStart: 0,
    countryCode: '', countryName: '', countryFlag: '', countryDetectedAt: 0,
    globalVisits: 0, globalFetchedAt: 0,
  };
}

function load(): LocalUsage {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    return { ...defaults(), ...(JSON.parse(raw) as Partial<LocalUsage>) };
  } catch { return defaults(); }
}

function save(u: LocalUsage): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(u)); } catch { /* private mode */ }
}

let cache: LocalUsage = load();
let clickBuffer = 0;
let clickTimer = 0;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) { try { fn(); } catch { /* */ } }
}

function flushClicks(): void {
  if (clickBuffer <= 0) return;
  cache.clicks += clickBuffer;
  clickBuffer = 0;
  cache.lastSeen = Date.now();
  save(cache);
  notify();
}

export function trackClick(): void {
  clickBuffer++;
  if (clickTimer) return;
  clickTimer = window.setTimeout(() => { clickTimer = 0; flushClicks(); }, CLICK_DEBOUNCE_MS);
}

export function trackVisit(): void {
  const now = Date.now();
  cache.visits++;
  cache.lastSeen = now;
  if (now - cache.lastSessionStart > SESSION_GAP_MS) {
    cache.sessions++;
    cache.lastSessionStart = now;
  }
  const today = todayKey();
  if (cache.lastVisitDay !== today) {
    cache.streak = cache.lastVisitDay === yesterdayKey() ? cache.streak + 1 : 1;
    cache.lastVisitDay = today;
  }
  save(cache);
  notify();
  void fetchGlobal();
}

async function fetchGlobal(): Promise<void> {
  if (Date.now() - cache.globalFetchedAt < GLOBAL_CACHE_MS) return;
  try {
    const r = await fetch(`${COUNTER_API}/up`, { method: 'POST' });
    if (!r.ok) return;
    const j = await r.json() as { value?: number };
    if (typeof j?.value === 'number') {
      cache.globalVisits = j.value;
      cache.globalFetchedAt = Date.now();
      save(cache);
      notify();
    }
  } catch { /* offline / CSP */ }
}

async function detectCountry(): Promise<void> {
  if (Date.now() - cache.countryDetectedAt < COUNTRY_CACHE_MS && cache.countryCode) return;
  try {
    const r = await fetch(GEO_API);
    if (!r.ok) return;
    const j = await r.json() as { country_code?: string; country_name?: string };
    if (j?.country_code && j?.country_name) {
      cache.countryCode = j.country_code;
      cache.countryName = j.country_name;
      cache.countryFlag = flagFromIso(j.country_code);
      cache.countryDetectedAt = Date.now();
      save(cache);
      notify();
    }
  } catch { /* offline / CSP */ }
}

function flagFromIso(iso: string): string {
  if (!iso || iso.length !== 2) return '🌍';
  try {
    const A = 0x1F1E6;
    return String.fromCodePoint(A + iso.charCodeAt(0) - 65, A + iso.charCodeAt(1) - 65);
  } catch { return '🌍'; }
}

const STYLE = `
.obs-usage-badge{display:inline-flex;flex-direction:column;gap:6px;padding:12px 16px;border-radius:10px;background:rgba(15,17,23,.92);border:1px solid rgba(56,189,248,.35);color:#e2e8f0;font:12px/1.5 system-ui,-apple-system,sans-serif;backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:340px}
.obs-usage-badge.compact{flex-direction:row;align-items:center;gap:10px;padding:6px 12px;font-size:11px}
.obs-usage-badge.light{background:rgba(255,255,255,.95);border-color:rgba(2,132,199,.35);color:#0f172a;box-shadow:0 8px 24px rgba(0,0,0,.12)}
.obs-usage-row{display:flex;align-items:center;gap:6px;white-space:nowrap}
.obs-usage-num{font-family:var(--font-mono,ui-monospace,monospace);font-weight:700;color:#38bdf8}
.obs-usage-badge.light .obs-usage-num{color:#0284c7}
.obs-usage-label{opacity:.75;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
.obs-usage-flag{font-size:14px}
.obs-usage-badge .obs-usage-reset{margin-left:auto;background:none;border:none;color:#64748b;cursor:pointer;font-size:10px;padding:0;text-decoration:underline}
`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = STYLE;
  document.head.appendChild(s);
}

function fmtNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

export interface UsageBadgeOptions {
  theme?: 'dark' | 'light';
  compact?: boolean;
  showReset?: boolean;
}

export function mountUsageBadge(target: HTMLElement, opts: UsageBadgeOptions = {}): () => void {
  injectStyle();
  const { theme = 'dark', compact = false, showReset = false } = opts;
  const el = document.createElement('div');
  el.className = `obs-usage-badge${compact ? ' compact' : ''}${theme === 'light' ? ' light' : ''}`;
  target.appendChild(el);

  const render = (): void => {
    if (compact) {
      const parts: string[] = [];
      if (cache.globalVisits > 0) parts.push(`<span class="obs-usage-row">🌍 <span class="obs-usage-num">${fmtNum(cache.globalVisits)}</span></span>`);
      if (cache.countryName) parts.push(`<span class="obs-usage-row"><span class="obs-usage-flag">${cache.countryFlag}</span> ${cache.countryName}</span>`);
      parts.push(`<span class="obs-usage-row">🖱️ <span class="obs-usage-num">${fmtNum(cache.clicks)}</span></span>`);
      el.innerHTML = parts.join('');
      return;
    }
    const rows: string[] = [];
    if (cache.globalVisits > 0) rows.push(`<div class="obs-usage-row"><span class="obs-usage-flag">🌍</span><span class="obs-usage-num">${fmtNum(cache.globalVisits)}</span><span class="obs-usage-label">visits worldwide</span></div>`);
    if (cache.countryName) rows.push(`<div class="obs-usage-row"><span class="obs-usage-flag">${cache.countryFlag}</span><span>You're from <strong>${cache.countryName}</strong></span></div>`);
    rows.push(`<div class="obs-usage-row"><span class="obs-usage-flag">🖱️</span><span class="obs-usage-num">${fmtNum(cache.clicks)}</span><span class="obs-usage-label">your clicks</span></div>`);
    rows.push(`<div class="obs-usage-row"><span class="obs-usage-flag">👤</span><span class="obs-usage-num">${fmtNum(cache.sessions)}</span><span class="obs-usage-label">sessions</span></div>`);
    if (cache.streak > 1) rows.push(`<div class="obs-usage-row"><span class="obs-usage-flag">🔥</span><span class="obs-usage-num">${cache.streak}</span><span class="obs-usage-label">day streak</span></div>`);
    if (showReset) rows.push(`<button class="obs-usage-reset" type="button">Reset my stats</button>`);
    el.innerHTML = rows.join('');
    if (showReset) {
      el.querySelector('.obs-usage-reset')?.addEventListener('click', () => {
        if (confirm('Reset your local usage stats?')) { cache = defaults(); save(cache); notify(); }
      });
    }
  };

  render();
  subscribers.add(render);
  return () => { subscribers.delete(render); el.remove(); };
}

export function getUsageStats(): Readonly<LocalUsage> { return { ...cache }; }
export function resetUsageStats(): void { cache = defaults(); save(cache); notify(); }

function autoMount(): void {
  const tryMount = (): boolean => {
    const slot =
      document.querySelector<HTMLElement>('[data-obs-usage]') ??
      document.querySelector<HTMLElement>('#obs-welcome') ??
      document.querySelector<HTMLElement>('.obs-welcome');
    if (slot && !slot.querySelector('.obs-usage-badge')) {
      mountUsageBadge(slot, { theme: 'dark', compact: false, showReset: false });
      return true;
    }
    return false;
  };
  if (tryMount()) return;
  const obs = new MutationObserver(() => { if (tryMount()) obs.disconnect(); });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 15000);
}

export function bootUsageStats(): void {
  trackVisit();
  void detectCountry();
  if (typeof window === 'undefined') return;
  window.addEventListener('pointerdown', trackClick, { passive: true });
  window.addEventListener('keydown', trackClick, { passive: true });
  autoMount();
}