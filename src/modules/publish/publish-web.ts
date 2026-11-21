/**
 * Publish-as-web-page — browser orchestration (differentiation item 6).
 *
 * One click ("Publish: export this model as a web page", also in the File
 * menu under 3D Model Zone) downloads a .zip that is a complete static
 * website: the built viewer (every file in dist/, enumerated at build
 * time into asset-list.json) + the current project as model.obsproj +
 * a rewritten index.html that boots the viewer and auto-opens the model.
 * Unzip it anywhere a static file can be served — no app server, no
 * collab server, no account. The published page is a frozen snapshot:
 * edits made in it are local-only and are replaced by the published
 * model on the next load (a backup is kept by the app's recovery).
 *
 * Publish runs from the app's own production build: the viewer files are
 * fetched from the same origin that served the app, so the published
 * page is always the viewer version the user is running. In dev (no
 * asset-list.json) it refuses with a clear message instead of building
 * a broken page.
 */
import JSZip from "jszip";
import { notify as toast } from "../../core/notify";
import { ctx } from "../../core/context";
import {
  PUBLISHED_MODEL_FILE,
  filterPublishableFiles,
  publishedZipName,
  rewritePublishedIndexHtml,
  type PublishedMarker,
} from "./publish-web-core";

type Any = Record<string, any>;

async function fetchText(url: string, what: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${what} (${res.status} ${res.url})`);
  return res.text();
}

async function fetchBytes(url: string, what: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${what} (${res.status} ${res.url})`);
  return res.arrayBuffer();
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build the published zip and trigger the download. Returns the zip file
 * name on success, null when nothing was published (with a toast naming
 * the reason — never a silent no-op, never a broken page).
 */
export async function publishAsWebPage(): Promise<string | null> {
  const { snapshotProjectFile } = await import("../projects/project-file-io");
  const { isEncryptedProjectBlob } = await import("../projects/project-crypto");
  const snap = await snapshotProjectFile();
  if (!snap) return null; // snapshotProjectFile already toasted the reason
  const { blob: modelBlob, doc } = snap;
  if (await isEncryptedProjectBlob(modelBlob)) {
    toast("error", "This project is encrypted — publish needs an unencrypted snapshot. Save an unencrypted copy first.");
    return null;
  }

  toast("info", "Publishing… fetching the viewer files.");
  let assetList: Array<{ path: string; bytes: number }>;
  try {
    const listText = await fetchText(new URL("asset-list.json", location.href).href, "asset-list.json");
    assetList = filterPublishableFiles(JSON.parse(listText).files ?? []);
  } catch (e) {
    toast("error", "Publish needs a production build (asset-list.json not found). Build the app and publish from the built version.");
    console.warn("[publish] asset-list.json unavailable", e);
    return null;
  }
  if (!assetList.length) {
    toast("error", "Publish found no viewer files to bundle (asset-list.json is empty).");
    return null;
  }

  let indexHtml: string;
  try {
    indexHtml = await fetchText(new URL("index.html", location.href).href, "index.html");
  } catch (e) {
    toast("error", "Publish could not read the app's index.html.");
    console.warn("[publish] index.html unavailable", e);
    return null;
  }

  const zip = new JSZip();
  const totalBytes = assetList.reduce((n, f) => n + f.bytes, 0) + modelBlob.size;
  for (const file of assetList) {
    // index.html is rewritten (relative paths + published marker) and added
    // below — fetching the built one as an asset would only be overwritten.
    if (file.path === "index.html") continue;
    try {
      const bytes = await fetchBytes(new URL(file.path, location.href).href, file.path);
      zip.file(file.path, bytes);
    } catch (e) {
      toast("error", `Publish stopped: could not fetch the viewer file ${file.path} — the page would be broken without it.`);
      console.warn("[publish] asset fetch failed", file.path, e);
      return null;
    }
  }
  zip.file(PUBLISHED_MODEL_FILE, modelBlob);
  let publishedHtml: string;
  try {
    publishedHtml = rewritePublishedIndexHtml(indexHtml, { model: PUBLISHED_MODEL_FILE, name: doc.name });
  } catch (e) {
    toast("error", "Publish could not rewrite index.html for the published page.");
    console.warn("[publish] index rewrite failed", e);
    return null;
  }
  zip.file("index.html", publishedHtml);
  zip.file(
    "README.txt",
    `${doc.name} — published with OpenBIMStudio.\n\n` +
      `Serve this folder with any static file server (e.g. \`python3 -m http.server\`)\n` +
      `and open index.html. No app server, account or licence is needed.\n\n` +
      `This is a frozen snapshot of the model as published. Edits made in the\n` +
      `published page stay in that browser and are replaced by this snapshot\n` +
      `on the next load. To share a live model instead, use a share link.\n`,
  );

  toast("info", "Publishing… building the zip.");
  const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const name = publishedZipName(doc.name);
  downloadBlob(zipBlob, name);
  toast("success", `Published ${doc.name} as a web page (${formatBytes(totalBytes)} viewer + model, ${name}). Unzip it and serve the folder with any static file server.`);
  return name;
}

/**
 * Boot hook (main.ts, after project-auto-reopen): when this page IS a
 * published page (window.__OBS_PUBLISHED__ set by its index.html), fetch
 * the bundled model and open it, replacing any local copy — the published
 * snapshot always wins on load, so a returning visitor sees the published
 * model, not their own earlier edits. Returns true when a published model
 * was opened. The welcome overlay hides itself via the normal
 * project-changed hook when the open succeeds.
 */
export async function openPublishedModel(): Promise<boolean> {
  const marker = (window as unknown as Any).__OBS_PUBLISHED__ as PublishedMarker | undefined;
  if (!marker?.model) return false;
  let res: Response;
  try {
    res = await fetch(new URL(marker.model, location.href).href);
  } catch (e) {
    console.warn("[publish] could not fetch the published model", e);
    return false;
  }
  if (!res.ok) {
    console.warn(`[publish] published model ${marker.model} missing (${res.status})`);
    return false;
  }
  const { importProjectFile } = await import("../projects/project-file-io");
  try {
    return await importProjectFile(await res.blob(), null, { replaceExisting: true });
  } catch (e) {
    console.warn("[publish] published model could not be opened", e);
    return false;
  }
}

export function setupPublishWeb(): void {
  (ctx.features as Any).publishWeb = { publishAsWebPage, openPublishedModel };
  import("../../features/command-palette").then((m) => {
    m.registerCommand({
      id: "publish-web-page",
      label: "Publish: export this model as a web page",
      category: "Publish",
      hint: "Model + viewer as a static page anyone can open",
      run: () => void publishAsWebPage(),
    });
  }).catch((e) => console.warn("[publish] could not register the palette command", e));
}
