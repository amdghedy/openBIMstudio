/**
 * Error handling: a global reporter, a ring-buffer log, and a boot-failure
 * screen. Replaces ad-hoc `console.error` + `alert()` calls with a single
 * entry point that surfaces failures in the UI instead of hiding them in
 * the dev-tools console.
 */
import { notify, type NotifyKind } from "./notify";

export interface ErrorEntry {
  time: number;
  message: string;
  stack?: string;
  context?: string;
}

const LOG_LIMIT = 200;
const log: ErrorEntry[] = [];

export function logError(err: unknown, context?: string): ErrorEntry {
  const entry: ErrorEntry = {
    time: Date.now(),
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    context,
  };
  log.push(entry);
  if (log.length > LOG_LIMIT) log.shift();
  // eslint-disable-next-line no-console
  console.error(`[obs-error]${context ? ` ${context}:` : ""}`, err);
  return entry;
}

export function recentErrors(): readonly ErrorEntry[] {
  return log;
}

export function clearErrorLog(): void {
  log.length = 0;
}

/* ══════════════════════════════════════════════════════════════════════
   Global handlers
   ══════════════════════════════════════════════════════════════════════ */
const BENIGN = [
  /Fragments\s*:?\s*Model not found/i,
  /ResizeObserver loop/i,
  /Loading CSS chunk/i,
  /Script error\.?/i,
  /cancelled/i,
  /AbortError/i,
];

function isBenign(msg: string): boolean {
  return BENIGN.some((re) => re.test(msg));
}

export function installGlobalErrorHandlers(): void {
  window.addEventListener("error", (e) => {
    const msg = String(e.error?.message ?? e.message ?? "");
    if (isBenign(msg)) {
      e.preventDefault();
      return;
    }
    logError(e.error ?? e.message, "window.error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const msg =
      reason instanceof Error ? reason.message
      : typeof reason === "string" ? reason
      : String((reason as { message?: string })?.message ?? reason ?? "");
    if (isBenign(msg)) {
      console.warn("[suppressed benign] " + msg);
      e.preventDefault();
      return;
    }
    logError(e.reason, "unhandled-rejection");
  });
}

/* ══════════════════════════════════════════════════════════════════════
   Boot failure screen
   ══════════════════════════════════════════════════════════════════════ */
export interface BootFailure {
  title: string;
  message: string;
  hint?: string;
  details?: string;
}

export function renderBootFailure(failure: BootFailure): void {
  // Remove any prior screen (idempotent).
  document.getElementById("obs-boot-failure")?.remove();

  const app = document.getElementById("app");
  if (!app) {
    notify("error", `${failure.title}: ${failure.message}`);
    return;
  }

  const screen = document.createElement("div");
  screen.id = "obs-boot-failure";
  screen.style.cssText =
    "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;" +
    "justify-content:center;background:#0b0d12;color:#e8eaf0;" +
    "font:14px/1.6 system-ui,sans-serif;padding:24px;overflow:auto";

  const card = document.createElement("div");
  card.style.cssText =
    "max-width:640px;width:100%;background:#1c1e28;" +
    "border:1px solid #2a2e3a;border-left:4px solid #ef4444;" +
    "border-radius:12px;padding:24px 26px;" +
    "box-shadow:0 24px 60px rgba(0,0,0,.55)";

  const title = document.createElement("h1");
  title.textContent = failure.title;
  title.style.cssText = "margin:0 0 8px;font-size:19px;color:#fca5a5";

  const msg = document.createElement("p");
  msg.textContent = failure.message;
  msg.style.cssText = "margin:0 0 12px;color:#cbd5e1";

  card.append(title, msg);

  if (failure.hint) {
    const hint = document.createElement("div");
    hint.style.cssText =
      "padding:12px 14px;border-radius:8px;background:rgba(56,189,248,.08);" +
      "border:1px solid rgba(56,189,248,.35);color:#bae6fd;font-size:13px;" +
      "line-height:1.6;margin-bottom:14px";
    hint.textContent = failure.hint;
    card.appendChild(hint);
  }

  if (failure.details) {
    const details = document.createElement("details");
    details.style.cssText = "margin-bottom:16px";
    const summary = document.createElement("summary");
    summary.textContent = "Technical details";
    summary.style.cssText = "cursor:pointer;color:#94a3b8;font-size:12px";
    const pre = document.createElement("pre");
    pre.textContent = failure.details;
    pre.style.cssText =
      "margin:8px 0 0;padding:10px 12px;background:#0e1017;border-radius:6px;" +
      "font-size:11.5px;line-height:1.5;white-space:pre-wrap;overflow:auto;" +
      "max-height:240px;color:#cbd5e1";
    details.append(summary, pre);
    card.appendChild(details);
  }

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";

  const reload = document.createElement("button");
  reload.textContent = "Reload";
  reload.style.cssText = btnCss("#38bdf8", "#0b0d12");
  reload.onclick = () => location.reload();

  const copy = document.createElement("button");
  copy.textContent = "Copy diagnostics";
  copy.style.cssText = btnCss("transparent", "#cbd5e1", "#2a2e3a");
  copy.onclick = () => {
    const diag = [
      `Message: ${failure.message}`,
      failure.hint ? `Hint: ${failure.hint}` : "",
      failure.details ? `Details: ${failure.details}` : "",
      `User agent: ${navigator.userAgent}`,
      `URL: ${location.href}`,
    ].filter(Boolean).join("\n");
    void navigator.clipboard.writeText(diag).then(
      () => { copy.textContent = "Copied ✓"; setTimeout(() => (copy.textContent = "Copy diagnostics"), 1200); },
      () => { copy.textContent = "Copy failed"; },
    );
  };

  actions.append(reload, copy);
  card.appendChild(actions);

  screen.appendChild(card);
  document.body.appendChild(screen);
}

function btnCss(bg: string, fg: string, border = "transparent"): string {
  return (
    `padding:9px 18px;border-radius:6px;font:600 13px system-ui,sans-serif;` +
    `background:${bg};color:${fg};border:1px solid ${border};cursor:pointer`
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Convenience: run a block with structured error reporting
   ══════════════════════════════════════════════════════════════════════ */
export async function guarded<T>(
  fn: () => Promise<T> | T,
  context: string,
  kind: NotifyKind = "error",
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const entry = logError(err, context);
    notify(kind, `${context}: ${entry.message}`);
    return null;
  }
}
