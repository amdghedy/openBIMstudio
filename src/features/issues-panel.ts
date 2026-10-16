/** Floating Issues panel: create/expand/comment/status + BCF import/export. */
import { ctx } from "../core/context";
import {
  getIssues, createIssue, addComment, setStatus, setPriority, deleteIssue,
  goToViewpoint, getAuthor, setAuthor, onIssuesChanged,
} from "../modules/issues/issues";
import { exportBCF, importBCF } from "../modules/issues/bcf";
import type { Issue, IssueComment, IssuePriority, IssueStatus } from "../modules/issues/types";
import { getCurrentProject } from "../modules/projects/projects";

const panel = document.createElement("div");
panel.style.cssText = "position:absolute;top:210px;right:14px;width:310px;max-height:calc(100% - 230px);z-index:35;display:none;flex-direction:column;background:#171821;border:1px solid #2a2a35;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:12px system-ui,sans-serif;color:#e2e8f0;overflow:hidden";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText = "display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #24252f;background:#1b1c26";
const body = document.createElement("div");
body.style.cssText = "overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px";
panel.append(header, body);

let expandedId: string | null = null;
let newFormOpen = false;
const fileInput = document.createElement("input");
fileInput.type = "file"; fileInput.accept = ".bcfzip,.zip,.bcf"; fileInput.style.display = "none";

const STATUS_COLOR: Record<IssueStatus, string> = { open: "#38bdf8", active: "#f59e0b", resolved: "#22c55e", closed: "#6b7280" };
const PRIORITY_COLOR: Record<IssuePriority, string> = { low: "#6b7280", medium: "#f59e0b", high: "#ef4444" };
const ORDER_S: IssueStatus[] = ["open", "active", "resolved", "closed"];
const ORDER_P: IssuePriority[] = ["low", "medium", "high"];
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const fmtDate = (t: number) => new Date(t).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

const MINI = "padding:3px 8px;background:#24252f;color:#cbd5e1;border:1px solid #34353f;border-radius:5px;cursor:pointer;font-size:10px";
const INP = "width:100%;box-sizing:border-box;padding:5px 7px;background:#12131a;border:1px solid #34353f;border-radius:5px;color:#e2e8f0;font-size:11px";

function miniBtn(label: string, onclick: () => void, title = "") {
  const b = document.createElement("button");
  b.textContent = label; b.title = title; b.style.cssText = MINI;
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

function renderHeader() {
  header.innerHTML = "";
  const title = document.createElement("span");
  title.textContent = `🗣 Issues (${getIssues().length})`;
  title.style.cssText = "font-weight:700;flex:1";
  header.appendChild(title);
  header.appendChild(miniBtn("＋ New", () => { newFormOpen = !newFormOpen; renderBody(); }, "Create issue from current view"));
  header.appendChild(miniBtn("⬇ BCF", () => {
    const p = getCurrentProject();
    void exportBCF(undefined, `${(p?.name ?? "issues").replace(/[^\w-]+/g, "_")}-issues.bcfzip`);
  }, "Export all issues as BCF 2.1"));
  header.appendChild(miniBtn("⬆", () => fileInput.click(), "Import BCF file"));
  header.appendChild(miniBtn(panel.style.display === "none" ? "▾" : "▴", () => {}, ""));
}

function renderNewForm(container: HTMLElement) {
  if (!newFormOpen) return;
  const box = document.createElement("div");
  box.style.cssText = "border:1px solid #34353f;border-radius:8px;padding:8px;background:#1b1c26;display:grid;gap:6px";
  const t = document.createElement("input");
  t.placeholder = "Issue title…"; t.style.cssText = INP;
  const d = document.createElement("textarea");
  d.placeholder = "Description (optional)…"; d.rows = 2; d.style.cssText = INP + ";resize:vertical";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;align-items:center";
  const create = document.createElement("button");
  create.textContent = "📷 Capture & Create";
  create.style.cssText = "flex:1;padding:6px;background:#2563eb;color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:600;font-size:11px";
  create.onclick = () => {
    if (!t.value.trim()) { t.focus(); return; }
    createIssue(t.value, d.value);
    newFormOpen = false; expandedId = null; renderBody(); renderHeader();
  };
  const authorLbl = document.createElement("span");
  authorLbl.textContent = `as ${getAuthor()}`;
  authorLbl.style.cssText = "opacity:.5;font-size:10px";
  row.append(create, authorLbl);
  box.append(t, d, row);
  container.appendChild(box);
}

function commentNode(c: IssueComment) {
  const el = document.createElement("div");
  el.style.cssText = "border-left:2px solid #34353f;padding:4px 8px;margin-left:4px;background:#15161d;border-radius:4px";
  el.innerHTML = `<div style="display:flex;gap:6px;font-size:10px;opacity:.65"><b>${esc(c.author)}</b><span>${fmtDate(c.date)}</span></div>
    <div style="margin-top:2px;white-space:pre-wrap">${esc(c.text)}</div>`;
  if (c.viewpoint) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:4px";
    if (c.viewpoint.thumbnail) {
      const img = document.createElement("img");
      img.src = c.viewpoint.thumbnail;
      img.style.cssText = "width:70px;border-radius:4px;border:1px solid #34353f;cursor:pointer";
      img.onclick = () => goToViewpoint(c.viewpoint!);
      row.appendChild(img);
    }
    row.appendChild(miniBtn("👁 Go to view", () => goToViewpoint(c.viewpoint!)));
    el.appendChild(row);
  }
  return el;
}

function issueNode(issue: Issue) {
  const expanded = expandedId === issue.id;
  const card = document.createElement("div");
  card.style.cssText = "border:1px solid #2a2a35;border-radius:8px;background:#1b1c26;overflow:hidden";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px;cursor:pointer";
  const dot = document.createElement("span");
  dot.style.cssText = `width:9px;height:9px;border-radius:50%;flex:none;background:${STATUS_COLOR[issue.status]}`;
  const title = document.createElement("span");
  title.style.cssText = "flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  title.textContent = issue.title;
  const prio = document.createElement("span");
  prio.style.cssText = `font-size:9px;padding:2px 6px;border-radius:4px;color:#0f1117;font-weight:700;background:${PRIORITY_COLOR[issue.priority]}`;
  prio.textContent = issue.priority.toUpperCase();
  head.append(dot, title, prio);
  head.onclick = () => { expandedId = expanded ? null : issue.id; renderBody(); };

  const meta = document.createElement("div");
  meta.style.cssText = "display:flex;gap:8px;align-items:center;padding:0 8px 8px;font-size:10px;opacity:.6";
  meta.innerHTML = `<span>${esc(issue.author)}</span><span>${fmtDate(issue.createdAt)}</span><span>💬 ${issue.comments.length}</span>`;
  if (issue.viewpoint.thumbnail) {
    const img = document.createElement("img");
    img.src = issue.viewpoint.thumbnail;
    img.style.cssText = "width:44px;height:30px;object-fit:cover;border-radius:4px;border:1px solid #34353f;margin-left:auto;cursor:pointer";
    img.title = "Go to viewpoint";
    img.onclick = (e) => { e.stopPropagation(); goToViewpoint(issue.viewpoint); };
    meta.appendChild(img);
  }
  card.append(head, meta);

  if (!expanded) return card;

  const details = document.createElement("div");
  details.style.cssText = "padding:0 8px 8px;display:flex;flex-direction:column;gap:8px";
  if (issue.description) {
    const d = document.createElement("div");
    d.style.cssText = "opacity:.8;white-space:pre-wrap";
    d.textContent = issue.description;
    details.appendChild(d);
  }
  const btns = document.createElement("div");
  btns.style.cssText = "display:flex;gap:5px;flex-wrap:wrap";
  btns.append(
    miniBtn("👁 Go to view", () => goToViewpoint(issue.viewpoint)),
    miniBtn(`Status: ${issue.status}`, () => {
      const next = ORDER_S[(ORDER_S.indexOf(issue.status) + 1) % ORDER_S.length];
      setStatus(issue.id, next);
    }, "Cycle status"),
    miniBtn(`⚑ ${issue.priority}`, () => {
      const next = ORDER_P[(ORDER_P.indexOf(issue.priority) + 1) % ORDER_P.length];
      setPriority(issue.id, next);
    }, "Cycle priority"),
    miniBtn("🗑", () => { if (confirm(`Delete issue "${issue.title}"?`)) { deleteIssue(issue.id); renderHeader(); } }, "Delete issue"),
  );
  details.appendChild(btns);

  if (issue.comments.length) {
    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:6px";
    for (const c of issue.comments) list.appendChild(commentNode(c));
    details.appendChild(list);
  }

  const ta = document.createElement("textarea");
  ta.placeholder = "Add comment…"; ta.rows = 2; ta.style.cssText = INP + ";resize:vertical";
  const crow = document.createElement("div");
  crow.style.cssText = "display:flex;gap:6px;align-items:center";
  const withVp = document.createElement("label");
  withVp.style.cssText = "display:flex;align-items:center;gap:4px;font-size:10px;opacity:.75;white-space:nowrap";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  withVp.append(cb, "📷 view");
  const add = document.createElement("button");
  add.textContent = "Add";
  add.style.cssText = "padding:5px 12px;background:#2563eb;color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:600;font-size:11px";
  add.onclick = () => {
    if (!ta.value.trim()) return;
    addComment(issue.id, ta.value, cb.checked);
    renderBody();
  };
  crow.append(ta, withVp, add);
  details.append(ta, crow);

  card.appendChild(details);
  return card;
}

function renderBody() {
  body.innerHTML = "";
  const authorRow = document.createElement("div");
  authorRow.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:2px";
  const a = document.createElement("input");
  a.value = getAuthor(); a.style.cssText = INP + ";flex:1";
  a.onchange = () => setAuthor(a.value);
  const al = document.createElement("span");
  al.textContent = "Author";
  al.style.cssText = "font-size:10px;opacity:.6;white-space:nowrap";
  authorRow.append(al, a);
  body.appendChild(authorRow);

  renderNewForm(body);

  const list = getIssues();
  if (!list.length && !newFormOpen) {
    body.innerHTML += `<div style="opacity:.5;font-size:11px;text-align:center;padding:14px;border:1px dashed #34353f;border-radius:8px">No issues yet.<br>Click <b>＋ New</b> to capture the current view as an issue.</div>`;
    return;
  }
  for (const issue of list) body.appendChild(issueNode(issue));
}

function renderAll() { renderHeader(); renderBody(); }

fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  fileInput.value = "";
  if (!f) return;
  try {
    const n = await importBCF(f);
    alert(`Imported ${n} issue(s) from BCF.`);
    renderAll();
  } catch (e: any) {
    alert(`BCF import failed: ${e?.message ?? e}`);
  }
};

export function toggleIssuesPanel() {
  panel.style.display = panel.style.display === "none" || !panel.style.display ? "flex" : "none";
  if (panel.style.display === "flex") renderAll();
}
export function isIssuesPanelVisible() { return panel.style.display === "flex"; }

export function setupIssuesPanel() {
  ctx.rightHost.appendChild(panel);
  ctx.rightHost.appendChild(fileInput);
  onIssuesChanged(renderAll);
  ctx.features.issuesPanel = { toggle: toggleIssuesPanel, isVisible: isIssuesPanelVisible };
}