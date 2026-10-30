/**
 * New-feature discovery badges.
 *
 * Small green dots are attached to controls introduced during the latest
 * development window so users can quickly find and test them. A badge is
 * cleared after that specific control is clicked and the state is kept in
 * localStorage for the current browser profile.
 */

const STORAGE_KEY = "obs.new-feature-badges.v1";

const NEW_PATTERNS: RegExp[] = [
  // PDF review / markup
  /pdf\s*review/i,
  /pdf\s*(markup|comment|annotation|export|review)/i,
  /add\s*(markup|comment)/i,
  /export\s*(review|marked\s*pdf)/i,

  // Native Twin / recent editable-model workflow
  /make\s+editable/i,
  /native\s+twin/i,
  /ifc\s+source/i,
  /twin\s+(length|rotation|height|thickness)/i,
  /export\s+edited\s+ifc/i,

  // MEP / electrical lifecycle and panel workflows
  /panel\s+schedule/i,
  /load\s+circuit/i,
  /create\s+circuit/i,
  /circuit\s+(editor|schedule)/i,
  /connection\s+diagnostics/i,
  /lifecycle\s+diagnostics/i,
  /mep\s+lifecycle/i,
  /electrical\s+distribution/i,

  // CAD additions from the recent CAD viewer work
  /command\s+line/i,
  /\bucs\b/i,
  /\bosnap\b/i,
  /\bdyn\b/i,
  /drafting/i,
  /cad\s+viewcube/i,

  // Recent BIM authoring additions
  /arc\s+wall/i,
  /detail\s+hatch/i,
  /gltf/i,

  // Recent collaboration / production additions
  /worksharing/i,
  /out[-\s]?of[-\s]?core/i,
  /batch\s+vector\s+plot/i,
  /vector\s+plot/i,

  // Full Modify toolkit introduced in the recent context-menu work.
  /create\s+similar/i,
  /match\s+properties/i,
  /select\s+similar/i,
  /join\s+walls?/i,
  /trim\s*\/\s*extend/i,
  /offset/i,
  /mirror/i,
  /array/i,
  /pin\s*\/\s*unpin/i,
];

function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const values = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(values) ? values.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSeen(seen: Set<string>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...seen])); } catch { /* private mode */ }
}

function controlText(button: HTMLButtonElement): string {
  return [
    button.getAttribute("aria-label") || "",
    button.getAttribute("title") || "",
    button.textContent || "",
  ].join(" ").replace(/\s+/g, " ").trim();
}

function stableKey(button: HTMLButtonElement): string {
  const explicit = button.dataset.obsNewId;
  if (explicit) return explicit;
  const text = controlText(button).toLowerCase();
  const scope = button.closest("[data-obs-new-scope]")?.getAttribute("data-obs-new-scope") || "global";
  return `${scope}:${text}`;
}

function matchesNewFeature(button: HTMLButtonElement): boolean {
  if (button.dataset.obsNew === "1") return true;
  if (button.dataset.obsNewIgnore === "1") return false;
  const text = controlText(button);
  return !!text && NEW_PATTERNS.some((pattern) => pattern.test(text));
}

function clearBadge(button: HTMLButtonElement): void {
  const key = stableKey(button);
  const seen = readSeen();
  seen.add(key);
  writeSeen(seen);
  button.classList.remove("obs-new-feature");
  button.removeAttribute("data-obs-new-visible");
}

function decorate(button: HTMLButtonElement): void {
  if (!matchesNewFeature(button)) return;
  const key = stableKey(button);
  const seen = readSeen();
  if (seen.has(key)) return;

  button.classList.add("obs-new-feature");
  button.dataset.obsNewVisible = "1";
  if (button.dataset.obsNewBound !== "1") {
    button.dataset.obsNewBound = "1";
    button.addEventListener("click", () => clearBadge(button), { passive: true });
  }
}

function scan(root: ParentNode): void {
  if (root instanceof HTMLButtonElement) decorate(root);
  root.querySelectorAll?.("button").forEach((node) => {
    if (node instanceof HTMLButtonElement) decorate(node);
  });
}

export function setupNewFeatureBadges(): void {
  if (typeof document === "undefined") return;
  scan(document);

  const style = document.createElement("style");
  style.id = "obs-new-feature-badges-style";
  style.textContent = `
    button.obs-new-feature { position: relative !important; }
    button.obs-new-feature::after {
      content: "";
      position: absolute;
      top: 3px;
      right: 3px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 0 1.5px rgba(15, 23, 42, .78), 0 0 7px rgba(34, 197, 94, .55);
      pointer-events: none;
      z-index: 20;
    }
    button.obs-new-feature:hover::after {
      transform: scale(1.18);
      box-shadow: 0 0 0 1.5px rgba(15, 23, 42, .78), 0 0 10px rgba(34, 197, 94, .75);
    }
  `;
  document.head.appendChild(style);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node as Element);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  (window as any).__obsNewFeatureBadges = {
    clear: (button: HTMLButtonElement) => clearBadge(button),
    rescan: () => scan(document),
    reset: () => { localStorage.removeItem(STORAGE_KEY); scan(document); },
  };
}
