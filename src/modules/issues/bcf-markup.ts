/**
 * BCF 2.1 markup.bcf build + parse — the single dialect both writers use.
 *
 * Spec conformance notes (BCF 2.1 markup.xsd):
 *   - Topic carries ONLY Guid / TopicType / TopicStatus as XML attributes.
 *     Title, Priority, Labels, CreationDate, CreationAuthor, ModifiedDate,
 *     ModifiedAuthor, DueDate, AssignedTo and Description are CHILD elements.
 *     (The pre-BCF-markup-module writer emitted them as attributes and named
 *     the description "DescriptionText" — external BCF consumers drop or
 *     reject that dialect, and our own reader could not read the conformant
 *     writer's output. Both writers now share this module.)
 *   - Comment carries ONLY Guid as an attribute; Date, Author and the text
 *     (in a nested <Comment> element) are child elements. The legacy dialect
 *     put Date/Author on attributes and the text in <Text> — the reader
 *     below still accepts that for files exported by older builds.
 *   - Guid values follow the BCF GuidType pattern (RFC 4122 UUID). Internal
 *     issue ids ("issue-…") are not valid topic guids and are never written.
 *
 * The parser is intentionally dependency-free and runs on the browser
 * DOMParser; tests inject a minimal XML-tree implementation through
 * setBcfDomParserFactory so the round trip is verified in Node.
 */

/* ── GUID helpers ──────────────────────────────────────────────────────── */

/** BCF GuidType: RFC 4122 UUID shape (markup.xsd / visinfo.xsd restriction)
 *  — or an IFC GlobalId: 22 chars of the compressed-GUID alphabet. BCF
 *  topics commonly carry the IFC GlobalId of the element they annotate, and
 *  the project's own BCF fixture does exactly that; the UUID-only shape made
 *  the import's schema gate reject such topics outright (X-4: the valid
 *  control fixture failed validateBcfParsedTopic), and made the writer
 *  silently replace the guid with a fresh UUID on round-trip. */
export const BCF_GUID_RE =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9A-Za-z_$]{22})$/;

export function isBcfGuid(s: string | null | undefined): boolean {
  return typeof s === "string" && BCF_GUID_RE.test(s);
}

export function bcfGuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  // RFC 4122 v4 fallback (same shape randomUUID guarantees).
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4"; // version nibble
    else if (i === 19) out += hex[8 + ((Math.random() * 4) | 0)]; // variant 8/9/a/b
    else out += hex[(Math.random() * 16) | 0];
  }
  return out;
}

/* ── Shared XML helpers ────────────────────────────────────────────────── */

export function xmlEscape(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }) as Record<string, string>)[c],
  );
}

/** BCF timestamps: xs:dateTime — ISO-8601 with local offset. */
export function bcfDate(t: number | undefined): string {
  const d = new Date(t || Date.now());
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = Math.floor(Math.abs(off) / 60);
  const om = Math.abs(off) % 60;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(oh)}:${pad(om)}`
  );
}

/* ── Writer ────────────────────────────────────────────────────────────── */

export interface BcfMarkupComment {
  guid: string;
  author: string;
  /** Epoch millis; rendered as xs:dateTime. */
  date: number;
  text: string;
}

export interface BcfMarkupTopic {
  guid: string;
  topicType: string;
  topicStatus: string;
  title: string;
  priority?: string;
  labels?: string[];
  /** Epoch millis. */
  createdAt: number;
  createdBy: string;
  modifiedAt?: number;
  modifiedBy?: string;
  /** Epoch millis; BCF 2.1 carries DueDate as a child element. */
  dueDate?: number;
  assignedTo?: string;
  description?: string;
  comments?: BcfMarkupComment[];
  /**
   * Raw XML inserted right after <Header> opening — callers pass their own
   * <File> elements (the clash writer records the coordination origin).
   */
  headerXml?: string;
  /** Viewpoint filename (relative to the topic folder), e.g. "viewpoint.bcfv". */
  viewpointFile?: string;
}

/** One canonical, BCF 2.1-conformant markup.bcf for every writer. */
export function buildBcfMarkup(t: BcfMarkupTopic): string {
  const child = (tag: string, v?: string | number) =>
    v === undefined || v === null || v === ""
      ? ""
      : `\n    <${tag}>${xmlEscape(String(v))}</${tag}>`;

  const labels = (t.labels ?? []).length
    ? `\n    <Labels>${t
        .labels!.map((l) => `<Label>${xmlEscape(l)}</Label>`)
        .join("")}</Labels>`
    : "";

  const comments = (t.comments ?? [])
    .map(
      (c) => `
    <Comment Guid="${xmlEscape(isBcfGuid(c.guid) ? c.guid : bcfGuid())}">
      <Date>${bcfDate(c.date)}</Date>
      <Author>${xmlEscape(c.author)}</Author>
      <Comment>${xmlEscape(c.text)}</Comment>
    </Comment>`,
    )
    .join("");

  const header = t.headerXml
    ? `\n  <Header>${t.headerXml}\n  </Header>`
    : "";

  const viewpoint = t.viewpointFile
    ? `\n    <Viewpoints><Viewpoint Guid="${xmlEscape(
        bcfGuid(),
      )}" Type="Viewpoint">${xmlEscape(t.viewpointFile)}</Viewpoint></Viewpoints>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="markup.xsd">${header}
  <Topic Guid="${xmlEscape(isBcfGuid(t.guid) ? t.guid : bcfGuid())}" TopicType="${xmlEscape(
    t.topicType,
  )}" TopicStatus="${xmlEscape(t.topicStatus)}">
    <Title>${xmlEscape(t.title)}</Title>${child("Priority", t.priority)}${labels}${child(
    "CreationDate",
    bcfDate(t.createdAt),
  )}${child("CreationAuthor", t.createdBy)}${child(
    "ModifiedDate",
    t.modifiedAt ? bcfDate(t.modifiedAt) : undefined,
  )}${child("ModifiedAuthor", t.modifiedBy)}${child(
    "DueDate",
    t.dueDate ? bcfDate(t.dueDate) : undefined,
  )}${child("AssignedTo", t.assignedTo)}${child("Description", t.description)}${comments}${viewpoint}
  </Topic>
</Markup>
`;
}

/* ── Reader ────────────────────────────────────────────────────────────── */

export interface BcfParsedComment {
  guid: string;
  author: string;
  date: number;
  text: string;
}

export interface BcfParsedTopic {
  guid: string;
  topicType: string;
  topicStatus: string;
  title: string;
  priority?: string;
  labels: string[];
  author: string;
  assignee?: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  dueDate?: number;
  comments: BcfParsedComment[];
}

/**
 * Minimal structural subset of the DOM the parser relies on — the real
 * browser DOMParser satisfies it, and so does the test shim.
 */
export interface BcfElementLike {
  tagName: string;
  textContent: string;
  children: ArrayLike<BcfElementLike>;
  getAttribute(name: string): string | null;
  querySelector(selectors: string): BcfElementLike | null;
  querySelectorAll(selectors: string): ArrayLike<BcfElementLike>;
}

export interface BcfDocumentLike {
  querySelector(selectors: string): BcfElementLike | null;
  querySelectorAll(selectors: string): ArrayLike<BcfElementLike>;
}

export interface BcfDomParser {
  parseFromString(xml: string, mimeType: string): BcfDocumentLike;
}

let domParserFactory: (() => BcfDomParser) | null = null;

/** Tests inject a Node-side parser here; browsers use the global DOMParser. */
export function setBcfDomParserFactory(f: (() => BcfDomParser) | null): void {
  domParserFactory = f;
}

function makeParser(): BcfDomParser {
  if (domParserFactory) return domParserFactory();
  const g = globalThis as unknown as { DOMParser?: new () => BcfDomParser };
  if (!g.DOMParser) throw new Error("no DOMParser available for BCF markup");
  return new g.DOMParser();
}

/** Direct-child elements with a given tag (avoids nested-<Comment> false hits). */
function childEls(el: BcfElementLike, tag: string): BcfElementLike[] {
  const out: BcfElementLike[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (c.tagName === tag) out.push(c);
  }
  return out;
}

/** First direct child with the tag, else null. */
function childEl(el: BcfElementLike | null, tag: string): BcfElementLike | null {
  if (!el) return null;
  return childEls(el, tag)[0] ?? null;
}

function textOf(el: BcfElementLike | null): string {
  return el?.textContent?.trim() ?? "";
}

/**
 * Element text first, legacy attribute fallback — reads both the
 * spec-conformant writer and files exported by older builds.
 */
function field(parent: BcfElementLike, tag: string, attr?: string): string {
  const el = childEl(parent, tag);
  if (el && textOf(el)) return textOf(el);
  const a = attr ? parent.getAttribute(attr) : null;
  return a ?? "";
}

function dateField(parent: BcfElementLike, tag: string, attr?: string): number {
  const raw = field(parent, tag, attr);
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Parse one markup.bcf into topic + comments. Throws on XML the parser
 * cannot read (importBCF catches per topic folder and keeps going).
 */
export function parseBcfMarkup(xml: string): BcfParsedTopic {
  const doc = makeParser().parseFromString(xml, "text/xml");
  const topic = doc.querySelector("Topic");
  if (!topic) throw new Error("markup.bcf has no <Topic> element");

  const status = topic.getAttribute("TopicStatus") ?? "";
  const priorityRaw = field(topic, "Priority", "Priority");

  const labelsEl = childEl(topic, "Labels");
  const labels: string[] = [];
  if (labelsEl) {
    for (const l of childEls(labelsEl, "Label")) {
      const v = textOf(l);
      if (v) labels.push(v);
    }
    // Legacy comma-joined form: <Labels>a, b</Labels> with no Label children.
    if (!labels.length) {
      const joined = textOf(labelsEl);
      for (const piece of joined.split(",")) {
        const v = piece.trim();
        if (v) labels.push(v);
      }
    }
  }

  const comments: BcfParsedComment[] = [];
  for (const ce of childEls(topic, "Comment")) {
    const text =
      textOf(childEl(ce, "Comment")) || textOf(childEl(ce, "Text"));
    comments.push({
      guid: ce.getAttribute("Guid") ?? "",
      author: field(ce, "Author", "Author") || "Unknown",
      date: dateField(ce, "Date", "Date") || Date.now(),
      text,
    });
  }

  return {
    guid: topic.getAttribute("Guid") ?? "",
    topicType: topic.getAttribute("TopicType") ?? "",
    topicStatus: status,
    title: field(topic, "Title", "Title") || "Imported issue",
    priority: priorityRaw || undefined,
    labels,
    author:
      field(topic, "CreationAuthor", "Author") || "Imported",
    assignee: field(topic, "AssignedTo", "AssignedTo") || undefined,
    description:
      field(topic, "Description", "Description") ||
      ((): string => {
        // Older builds named the description DescriptionText.
        const el = childEl(topic, "DescriptionText");
        return el ? textOf(el) : "";
      })(),
    createdAt: dateField(topic, "CreationDate", "CreationDate") || Date.now(),
    updatedAt: dateField(topic, "ModifiedDate", "ModifiedDate") || Date.now(),
    dueDate: dateField(topic, "DueDate", "DueDate") || undefined,
    comments,
  };
}
