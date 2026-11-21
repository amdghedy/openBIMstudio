/**
 * View-only review links with markup (differentiation item 8).
 *
 * The loop, end to end:
 *   1. The author uploads the model's .obsproj file to any static host and
 *      runs "Review: copy a review link" (File menu or palette). The link
 *      is `https://<app>/?review=<url-encoded .obsproj URL>`.
 *   2. The reviewer opens the link in any browser. The model loads, review
 *      mode engages (view-only — the edit gates in authoring.ts,
 *      plan-view-panel.ts and tools.ts refuse every edit tool and every
 *      create/delete/transform call with a toast pointing at issues).
 *   3. The reviewer selects elements, adds issues from the review banner
 *      (each issue captures the camera viewpoint, selection and a snapshot
 *      thumbnail — the existing issues system), and exports the review as
 *      a BCF 2.1 file.
 *   4. The reviewer sends the .bcfzip back; the author imports it via the
 *      Issues panel (existing importBCF) and the issues appear with their
 *      viewpoints intact.
 *
 * No server, no account, no licence. The return path is a file the
 * reviewer sends back — there is no live sync (that is the share-links
 * item, which this builds on conceptually but does not depend on: every
 * branch it needs is on main today).
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { assertFileAllowed } from "../../core/file-guard";
import { registerCommand } from "../../features/command-palette";
import { promptLine } from "../../features/form-modal";
import { importProjectFile, snapshotProjectFile } from "../projects/project-file-io";
import { getCurrentProject } from "../projects/projects";
import { exportBCF } from "../issues/bcf";
import { getAuthor, getIssues, onIssuesChanged, setAuthor } from "../issues/issues";
import { buildReviewLink, parseReviewSearch } from "./review-links-core";
import { isReviewMode, setReviewMode } from "./review-state";

type Any = Record<string, any>;

const BANNER_ID = "obs-review-banner";
const REVIEW_TOAST =
  "Review mode is view-only — add an issue instead of editing the model.";

let banner: HTMLElement | null = null;
let countSpan: HTMLElement | null = null;
let nameSpan: HTMLElement | null = null;

function refreshBannerCount(): void {
  if (countSpan) countSpan.textContent = `${getIssues().length} issue${getIssues().length === 1 ? "" : "s"}`;
}

function showReviewBanner(): void {
  if (!banner) {
    banner = document.createElement("div");
    banner.id = BANNER_ID;
    banner.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:60;" +
      "display:flex;align-items:center;gap:10px;padding:8px 12px;" +
      "background:#171821;border:1px solid #2a2a35;border-radius:10px;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.5);font:12px system-ui,sans-serif;color:#e2e8f0";
    const label = document.createElement("span");
    label.innerHTML = "🔍 Reviewing <b></b> — view-only";
    nameSpan = label.querySelector("b");
    const as = document.createElement("span");
    as.textContent = "as";
    as.style.opacity = ".6";
    const author = document.createElement("input");
    author.value = getAuthor();
    author.title = "Your name — shown as the author on every issue you create";
    author.style.cssText =
      "width:110px;padding:4px 6px;background:#12131a;border:1px solid #34353f;border-radius:5px;color:#e2e8f0;font-size:11px";
    author.onchange = () => setAuthor(author.value);
    countSpan = document.createElement("span");
    countSpan.style.opacity = ".7";
    const btn = (text: string, title: string, onclick: () => void) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      b.style.cssText =
        "padding:4px 10px;background:#24252f;color:#cbd5e1;border:1px solid #34353f;border-radius:5px;cursor:pointer;font-size:11px";
      b.onclick = (e) => {
        e.stopPropagation();
        onclick();
      };
      return b;
    };
    const addIssue = btn("＋ Add issue", "Open the Issues panel and create an issue from the current view", () => {
      const panel = (ctx.features as Any).issuesPanel;
      if (panel && !panel.isVisible?.()) panel.toggle?.();
    });
    const exportBtn = btn(
      "⬇ Export review as BCF",
      "Download every issue in this review as a BCF 2.1 file to send back to the author",
      () => {
        void exportBCF();
      },
    );
    const exit = btn("Exit review", "Leave review mode — editing is enabled again", () => exitReviewMode());
    banner.append(label, as, author, countSpan, addIssue, exportBtn, exit);
    document.body.appendChild(banner);
  }
  const proj = getCurrentProject();
  if (nameSpan) nameSpan.textContent = proj?.name ?? "this model";
  refreshBannerCount();
  banner.style.display = "flex";
}

function hideReviewBanner(): void {
  if (banner) banner.style.display = "none";
}

export function enterReviewMode(): void {
  setReviewMode(true);
  showReviewBanner();
  notify("info", "Review mode — view-only. Select elements and add issues; export the review as BCF to send it back.");
}

export function exitReviewMode(): void {
  setReviewMode(false);
  hideReviewBanner();
  notify("info", "Review mode off — editing is enabled again.");
}

/**
 * Boot hook: run after project-auto-reopen. When the URL carries
 * `?review=<hosted .obsproj URL>`, fetch the model (the host must allow
 * cross-origin reads unless it is the app's own origin), validate it with
 * the same file guard every project import uses, open it (replacing any
 * auto-reopened project), and enter review mode. `?review` with no value
 * reviews the model that is already open. Returns true when review mode
 * was entered.
 */
export async function openReviewLink(): Promise<boolean> {
  const { review, modelUrl } = parseReviewSearch(location.search);
  if (!review) return false;
  if (modelUrl) {
    try {
      const res = await fetch(modelUrl, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        throw new Error(
          `Could not load the review model (${res.status} ${res.statusText}). Check the link, and that the host serves the file over https and allows cross-origin reads.`,
        );
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const name = decodeURIComponent(modelUrl.split("/").pop()?.split("?")[0] || "model.obsproj");
      // Encrypted projects use a different envelope (OBSPROJE) and are
      // refused by the file guard below; say so plainly instead of letting
      // the guard report a missing magic.
      if (new TextDecoder().decode(bytes.subarray(0, 8)) === "OBSPROJE") {
        throw new Error(
          "This review link points to a password-protected project, which cannot be opened from a link. Open the file in the app with its password instead.",
        );
      }
      assertFileAllowed("obsproj", name, bytes.length, bytes.subarray(0, 32));
      const ok = await importProjectFile(new Blob([bytes]), null, { replaceExisting: true });
      if (!ok) return false;
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
      return false;
    }
  }
  enterReviewMode();
  return true;
}

/** Author flow: paste the hosted .obsproj URL, get a review link back. */
export async function createReviewLink(): Promise<void> {
  try {
    const dirty = (ctx.features as Any).projects?.getSaveState?.().state !== "saved";
    if (dirty) {
      notify(
        "warn",
        "This project has unsaved changes — save it and upload the new file before sharing the link, or the reviewer will see the older version.",
      );
    }
  } catch {
    /* save state unavailable — proceed */
  }
  const url = await promptLine(
    "Create a review link",
    "URL of the hosted .obsproj file (download the model file, upload it to any static host, then paste its link here)",
    "",
  );
  if (!url?.trim()) return;
  let link: string;
  try {
    link = buildReviewLink(`${location.origin}${location.pathname}`, url);
  } catch (e) {
    notify("error", e instanceof Error ? e.message : String(e));
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    notify("success", "Review link copied — anyone opening it reviews this model view-only and returns markup as BCF.");
  } catch {
    // Clipboard unavailable (insecure context / permission denied): show the
    // link so it can be copied by hand instead of failing silently.
    await promptLine("Review link", "Copy this link", link);
  }
}

let setupDone = false;

export function setupReviewLinks(): void {
  if (setupDone) return;
  setupDone = true;
  registerCommand({
    id: "review-create-link",
    label: "Review: copy a review link for this model",
    category: "Review",
    run: () => {
      void createReviewLink();
    },
  });
  ctx.features.reviewLinks = {
    enterReviewMode,
    exitReviewMode,
    isReviewMode,
    createReviewLink,
    openReviewLink,
    // The exact snapshot the Save-to-file command writes, exposed for the
    // review flow (and its browser spec, which cannot drive the native
    // file picker headless): same bytes, same flush, no picker involved.
    snapshotProjectFile,
  };
  onIssuesChanged(refreshBannerCount);
}

export { REVIEW_TOAST };
