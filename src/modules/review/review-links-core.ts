/**
 * Pure helpers for view-only review links (differentiation item 8).
 *
 * A review link is `https://<app>/?review=<url-encoded .obsproj URL>`:
 * the reviewer opens it in any browser, the model loads, review mode
 * engages (view-only), the reviewer marks up with issues, and the markup
 * comes back as a BCF 2.1 file the author imports. No server, no account,
 * no licence — the author hosts the .obsproj file anywhere (any static
 * host, Drive, a release asset) and pastes its URL.
 *
 * Honest limits, stated here and in the registry entry:
 * - The host must serve the file over https when the app is https (mixed
 *   content is blocked by the browser) and must allow cross-origin reads
 *   (CORS) unless the file is served from the same origin as the app.
 * - The return path is a file: the reviewer downloads the .bcfzip and
 *   sends it back. There is no live sync — that is the share-links item.
 * - The gates below cover the tool setters and the element-mutation choke
 *   points (create / delete / transform). They are view-only enforcement,
 *   not a sandbox: a reviewer with devtools open can still poke the
 *   in-memory model, and saving in review mode writes the reviewer's own
 *   local copy only — it never reaches the author.
 */

/** Read-only tools per surface. Everything else is an edit and is refused. */
export const READONLY_AUTHORING_TOOLS = new Set(["select"]);
export const READONLY_PLAN_TOOLS = new Set(["select", "pan", "navigate"]);
export const READONLY_ANNOTATION_TOOLS = new Set(["select"]);

/** `tool` may be null (clear the active tool), which is always allowed. */
export function isReadOnlyAuthoringTool(tool: string | null): boolean {
  return tool === null || READONLY_AUTHORING_TOOLS.has(tool);
}

export function isReadOnlyPlanTool(tool: string): boolean {
  return READONLY_PLAN_TOOLS.has(tool);
}

export function isReadOnlyAnnotationTool(tool: string): boolean {
  return READONLY_ANNOTATION_TOOLS.has(tool);
}

export interface ReviewLinkParams {
  /** True when the URL carries a `review` parameter at all. */
  review: boolean;
  /** The hosted .obsproj URL, or null when `?review` has no value (review the current model). */
  modelUrl: string | null;
}

export function parseReviewSearch(search: string): ReviewLinkParams {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!params.has("review")) return { review: false, modelUrl: null };
  const raw = (params.get("review") ?? "").trim();
  return { review: true, modelUrl: raw ? raw : null };
}

/** A review link only makes sense for a fetchable http(s) model URL. */
export function isFetchableModelUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build the review link for a hosted .obsproj URL.
 * `appUrl` is the app's own URL (origin + pathname, no query).
 * Throws on anything that is not a fetchable http(s) URL.
 */
export function buildReviewLink(appUrl: string, modelUrl: string): string {
  const clean = modelUrl.trim();
  if (!isFetchableModelUrl(clean)) {
    throw new Error(
      "That is not a usable model URL — paste the https:// (or http://) address of a hosted .obsproj file.",
    );
  }
  const base = appUrl.split("?")[0].split("#")[0];
  return `${base}?review=${encodeURIComponent(clean)}`;
}
