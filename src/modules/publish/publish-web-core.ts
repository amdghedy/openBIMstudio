/**
 * Publish-as-web-page — pure core (differentiation item 6).
 *
 * No DOM, no ctx, no engine imports: everything here is testable in Node.
 * The browser orchestration (fetching the viewer files, zipping, the
 * download, the boot hook) lives in publish-web.ts.
 *
 * A published page is a static snapshot: the built viewer (every file in
 * dist/, enumerated at build time into asset-list.json) + the project
 * document as model.obsproj + a rewritten index.html that boots the viewer
 * and auto-opens the model. It is hostable anywhere a static file can be
 * served — no app server, no collab server, no account.
 */

/** The marker the published index.html carries; main.ts reads it at boot. */
export interface PublishedMarker {
  model: string;
  name: string;
}

export const PUBLISHED_MODEL_FILE = "model.obsproj";

/** Files the build emits that must never go into a published page. */
export function isPublishableAsset(path: string): boolean {
  if (path === "sw.js") return false; // the published page does not register the app's service worker
  if (path === "asset-list.json") return false; // describes the build; not part of the page
  if (path.endsWith(".map")) return false; // debug source maps only
  return true;
}

/** The publishable subset of an asset-list.json file list, sorted. */
export function filterPublishableFiles(files: Array<{ path: string; bytes: number }>): Array<{ path: string; bytes: number }> {
  return files
    .filter((f) => isPublishableAsset(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** URL-safe file slug for the published zip, e.g. "My Model!" → "my-model". */
export function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "model";
}

export function publishedZipName(projectName: string): string {
  return `${slugifyName(projectName)}-web.zip`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Turn the built dist/index.html into the published page's index.html:
 *   1. every root-absolute asset reference (href="/…" / src="/…") becomes
 *      relative (href="./…" / src="./…") so the page works from any static
 *      host path, not only a domain root;
 *   2. the document title becomes the project name;
 *   3. a marker script is injected immediately before the first module
 *      script (classic scripts run before module scripts, so main.ts can
 *      read window.__OBS_PUBLISHED__ at boot).
 * External URLs (https://…) are untouched — the rewrite only matches
 * quoted references that start with a slash.
 */
export function rewritePublishedIndexHtml(
  builtHtml: string,
  marker: PublishedMarker,
): string {
  let out = builtHtml.replace(/(href|src)="\/([^"]*)"/g, '$1="./$2"');
  out = out.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(marker.name)} — OpenBIMStudio</title>`,
  );
  const markerScript =
    `<script>window.__OBS_PUBLISHED__ = ${JSON.stringify(marker).replace(/</g, "\\u003c")};</script>`;
  const moduleScript = out.search(/<script[^>]*type="module"/);
  if (moduleScript === -1) {
    throw new Error("Built index.html has no module script to anchor the published marker to.");
  }
  return out.slice(0, moduleScript) + markerScript + "\n" + out.slice(moduleScript);
}

/** Read the published marker back out of a rewritten index.html (tests). */
export function readPublishedMarker(html: string): PublishedMarker | null {
  const m = /window\.__OBS_PUBLISHED__ = (\{[^<]*\});/.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as PublishedMarker;
  } catch {
    return null;
  }
}
