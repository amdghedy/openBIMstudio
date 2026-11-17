/**
 * tests/bcf21-roundtrip.test.cjs
 *
 * BCF 2.1 markup.bcf round trip + spec-conformance tests for the shared
 * markup module (src/modules/issues/bcf-markup.ts) that BOTH writers
 * (issues panel exportBCF and the clash/standards bcf21 writer) now use,
 * and that the importer (importBCF) parses through parseBcfMarkup.
 *
 * Why this exists: before the shared module the repo shipped two writers
 * in two dialects — the issues writer put Title/Priority/dates/author on
 * XML ATTRIBUTES with <DescriptionText>/<Text> elements (not in the BCF
 * 2.1 markup.xsd, so external consumers drop them) and used internal
 * "issue-…" strings as topic Guids (invalid GuidType), while the clash
 * writer emitted the conformant child-element dialect that our own
 * importer could not read (it read attributes). Titles, priorities,
 * descriptions and comment text/authors were silently lost either way.
 *
 * The parser runs against a minimal XML-tree shim covering exactly the
 * DOM subset parseBcfMarkup uses (tag selectors, child access, attributes,
 * textContent) — no external dependency is added.
 *
 * Run: `node tests/bcf21-roundtrip.test.cjs`
 */

const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log("  PASS " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
};

const ROOT = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-bcf21-"));
execSync(
  `npx tsc src/modules/issues/bcf-markup.ts --outDir ${out} --module commonjs --target es2020 ` +
  `--skipLibCheck --strict --ignoreDeprecations 5.0`,
  { cwd: ROOT, stdio: "inherit" },
);
const compiled =
  ["issues/bcf-markup.js", "bcf-markup.js"]
    .map((p) => path.join(out, p))
    .find((p) => fs.existsSync(p));
assert.ok(compiled, "expected compiled module (bcf-markup.js) under the tsc outDir");
const {
  buildBcfMarkup, parseBcfMarkup, bcfGuid, isBcfGuid,
  setBcfDomParserFactory, BCF_GUID_RE,
} = require(compiled);

/* ── Minimal XML tree shim (the subset parseBcfMarkup relies on) ─────── */

function parseXml(xml) {
  let i = 0;
  const n = xml.length;
  const doc = { tagName: "#document", attrs: {}, childNodes: [], parent: null };
  const stack = [doc];
  const top = () => stack[stack.length - 1];

  const nameRe = /[A-Za-z_:][\w.:-]*/y;
  function readName() {
    nameRe.lastIndex = i;
    const m = nameRe.exec(xml);
    if (!m) throw new Error(`bad name at ${i}`);
    i = nameRe.lastIndex;
    return m[0];
  }

  function decodeEntities(s) {
    // The browser DOMParser decodes these on parse; the shim must too.
    return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (m, e) => {
      if (e === "amp") return "&";
      if (e === "lt") return "<";
      if (e === "gt") return ">";
      if (e === "quot") return '"';
      if (e === "apos") return "'";
      if (e[1] === "x" || e[1] === "X") return String.fromCodePoint(parseInt(e.slice(2), 16));
      return String.fromCodePoint(parseInt(e.slice(1), 10));
    });
  }

  while (i < n) {
    if (xml.startsWith("<?", i)) { // xml decl / PI
      const e = xml.indexOf("?>", i); if (e < 0) throw new Error("unterminated PI");
      i = e + 2; continue;
    }
    if (xml.startsWith("<!--", i)) { // comment
      const e = xml.indexOf("-->", i); if (e < 0) throw new Error("unterminated comment");
      i = e + 3; continue;
    }
    if (xml.startsWith("<!", i)) { // doctype
      const e = xml.indexOf(">", i); if (e < 0) throw new Error("unterminated doctype");
      i = e + 1; continue;
    }
    if (xml.startsWith("</", i)) { // closing tag
      i += 2;
      const name = readName();
      while (i < n && /\s/.test(xml[i])) i++;
      if (xml[i] !== ">") throw new Error(`expected > at ${i}`);
      i++;
      const node = top();
      if (node.tagName !== name) throw new Error(`mismatched </${name}>, open <${node.tagName}>`);
      stack.pop();
      continue;
    }
    if (xml[i] === "<") { // opening tag
      i++;
      const name = readName();
      const node = { tagName: name, attrs: {}, childNodes: [], parent: top() };
      while (i < n && /\s/.test(xml[i])) i++;
      while (i < n && xml[i] !== ">" && !(xml[i] === "/" && xml[i + 1] === ">")) {
        const an = readName();
        while (i < n && /\s/.test(xml[i])) i++;
        let av = "";
        if (xml[i] === "=") {
          i++;
          const q = xml[i];
          if (q !== '"' && q !== "'") throw new Error(`attr ${an}: expected quote at ${i}`);
          const e = xml.indexOf(q, i + 1); if (e < 0) throw new Error("unterminated attr");
          av = xml.slice(i + 1, e); i = e + 1;
          while (i < n && /\s/.test(xml[i])) i++;
        }
        node.attrs[an] = decodeEntities(av);
      }
      let selfClose = false;
      if (xml[i] === "/") { selfClose = true; i++; }
      if (xml[i] !== ">") throw new Error(`expected > at ${i}`);
      i++;
      top().childNodes.push(node);
      if (!selfClose) stack.push(node);
      continue;
    }
    // text run
    const e = xml.indexOf("<", i);
    const text = e < 0 ? xml.slice(i) : xml.slice(i, e);
    i = e < 0 ? n : e;
    if (text) top().childNodes.push({ textNode: true, value: decodeEntities(text) });
  }
  if (stack.length !== 1) throw new Error(`unclosed element <${top().tagName}>`);
  return doc;
}

function textOfNode(node) {
  let s = "";
  for (const c of node.childNodes) {
    if (c.textNode) s += c.value;
    else s += textOfNode(c);
  }
  return s;
}
function elementChildren(node) {
  return node.childNodes.filter((c) => !c.textNode);
}
function descendants(node) { // element descendants, document order, excluding self
  const out = [];
  for (const c of elementChildren(node)) {
    out.push(c);
    for (const d of descendants(c)) out.push(d);
  }
  return out;
}
function matchSelector(node, sel) { // "Tag" or "A > B" — node itself must match the LAST part
  const parts = sel.split(">").map((p) => p.trim()).filter(Boolean);
  let cur = node;
  for (let k = parts.length - 1; k >= 0; k--) {
    if (!cur || cur.tagName !== parts[k]) return null;
    cur = cur.parent; // direct-child combinator walks up one element per part
  }
  return node;
}
function makeElement(node) {
  return {
    tagName: node.tagName,
    get textContent() { return textOfNode(node); },
    get children() { return elementChildren(node).map(makeElement); },
    getAttribute(name) { return node.attrs[name] ?? null; },
    querySelector(sel) {
      const d = descendants(node).find((x) => !!matchSelector(x, sel));
      return d ? makeElement(d) : null;
    },
    querySelectorAll(sel) {
      return descendants(node).filter((x) => !!matchSelector(x, sel)).map(makeElement);
    },
  };
}
function makeDocument(node) {
  const el = makeElement(node);
  return {
    querySelector(sel) {
      const hit = descendants(node).find((x) => !!matchSelector(x, sel));
      return hit ? makeElement(hit) : null;
    },
    querySelectorAll(sel) {
      return descendants(node).filter((x) => !!matchSelector(x, sel)).map(makeElement);
    },
  };
}

setBcfDomParserFactory(() => ({
  parseFromString(xml, _mime) { return makeDocument(parseXml(xml)); },
}));

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const T0 = Date.parse("2026-03-05T10:20:30Z");
const T1 = Date.parse("2026-03-06T11:21:32Z");
const T2 = Date.parse("2026-03-10T09:00:00Z");

const fullTopic = {
  guid: "9b2f4c1e-1111-4222-8333-444455556666",
  topicType: "Issue",
  topicStatus: "In Progress",
  title: "Duct <runs> through & wall",
  priority: "High",
  labels: ["Envelope", "MEP"],
  createdAt: T0,
  createdBy: "Ada Arch",
  modifiedAt: T1,
  modifiedBy: "Bob MEP",
  dueDate: T2,
  assignedTo: "Cara Str",
  description: "Clash description with \"quotes\" & <angles>",
  comments: [
    { guid: "aa2f4c1e-1111-4222-8333-444455556666", author: "Bob MEP", date: T1, text: "Confirmed on site — needs offset" },
    { guid: "bb2f4c1e-1111-4222-8333-444455556666", author: "Ada Arch", date: T2, text: "Wall moved 150mm" },
  ],
};

/* ── A. Writer conformance (BCF 2.1 markup.xsd dialect) ────────────────── */

const xml = buildBcfMarkup(fullTopic);

t("writer: Topic attributes are exactly Guid/TopicType/TopicStatus", () => {
  const m = xml.match(/<Topic ([^>]*)>/);
  assert.ok(m, "Topic element found");
  const attrs = m[1].match(/([\w:-]+)=/g).map((s) => s.replace("=", ""));
  assert.deepStrictEqual(attrs.sort(), ["Guid", "TopicStatus", "TopicType"]);
});

t("writer: title/priority/dates/author/description are CHILD elements, not attributes", () => {
  for (const tag of ["Title", "Priority", "CreationDate", "CreationAuthor",
    "ModifiedDate", "ModifiedAuthor", "DueDate", "AssignedTo", "Description"]) {
    assert.ok(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`).test(xml), `<${tag}> child element missing`);
  }
  assert.ok(!/\bTitle="/.test(xml), "Title must not be an attribute");
  assert.ok(!/\bPriority="/.test(xml), "Priority must not be an attribute");
  assert.ok(!/\bCreationDate="/.test(xml), "CreationDate must not be an attribute");
  assert.ok(!/DescriptionText/.test(xml), "legacy DescriptionText element must be gone");
  assert.ok(!/<Text>/.test(xml), "legacy comment <Text> element must be gone");
});

t("writer: comment = Guid attribute + Date/Author/Comment(text) children", () => {
  const cm = xml.match(
    /<Comment Guid="([^"]+)">\s*<Date>[^<]*<\/Date>\s*<Author>Bob MEP<\/Author>\s*<Comment>Confirmed on site — needs offset<\/Comment>\s*<\/Comment>/,
  );
  assert.ok(cm, "comment = Guid attr + Date/Author children + nested Comment text");
  assert.ok(cm && isBcfGuid(cm[1]), "comment Guid is a BCF UUID");
});

t("writer: labels are <Labels><Label>…</Label></Labels>", () => {
  assert.ok(/<Labels><Label>Envelope<\/Label><Label>MEP<\/Label><\/Labels>/.test(xml));
});

t("writer: topic guid is a valid BCF GuidType UUID", () => {
  const m = xml.match(/<Topic Guid="([^"]+)"/);
  assert.ok(m && isBcfGuid(m[1]), "topic Guid matches GuidType");
});

t("writer: XML escapes markup-sensitive characters", () => {
  assert.ok(xml.includes("Duct &lt;runs&gt; through &amp; wall"), "title escaped");
  assert.ok(xml.includes('&quot;quotes&quot; &amp; &lt;angles&gt;'), "description escaped");
});

t("writer: optional fields omitted cleanly", () => {
  const minimal = buildBcfMarkup({
    guid: "9b2f4c1e-1111-4222-8333-444455556666",
    topicType: "Issue", topicStatus: "Open", title: "Bare",
    createdAt: T0, createdBy: "A",
  });
  assert.ok(!/<Priority>/.test(minimal), "no empty Priority");
  assert.ok(!/<DueDate>/.test(minimal), "no empty DueDate");
  assert.ok(!/<AssignedTo>/.test(minimal), "no empty AssignedTo");
  assert.ok(!/<Description>/.test(minimal), "no empty Description");
  assert.ok(!/<Labels>/.test(minimal), "no empty Labels");
  assert.ok(!/<Comment /.test(minimal), "no comments");
});

t("writer: header XML and viewpoint reference land in the markup", () => {
  const withHeader = buildBcfMarkup({
    ...fullTopic,
    headerXml: `\n    <File IfcProject=""><Filename>Studio</Filename></File>`,
    viewpointFile: "viewpoint.bcfv",
  });
  assert.ok(/<Header>\s*<File IfcProject="">/.test(withHeader), "Header wraps caller File element");
  assert.ok(/<Viewpoints><Viewpoint Guid="[^"]+" Type="Viewpoint">viewpoint\.bcfv<\/Viewpoint><\/Viewpoints>/.test(withHeader),
    "Viewpoints wrapper with Viewpoint child");
});

t("writer: non-UUID topic guid is regenerated to keep GuidType valid", () => {
  const m = buildBcfMarkup({ ...fullTopic, guid: "issue-1729-abc" }).match(/<Topic Guid="([^"]+)"/);
  assert.ok(m && isBcfGuid(m[1]), "internal id replaced by a real UUID");
});

/* ── B. Round trip: own writer → parser ────────────────────────────────── */

const rt = parseBcfMarkup(xml);
const SEC = (x) => Math.floor(x / 1000) * 1000; // markup dates carry second precision

t("round-trip: guid/topicType/topicStatus survive", () => {
  assert.strictEqual(rt.guid, fullTopic.guid);
  assert.strictEqual(rt.topicType, "Issue");
  assert.strictEqual(rt.topicStatus, "In Progress");
});

t("round-trip: title, description and labels survive exactly", () => {
  assert.strictEqual(rt.title, fullTopic.title);
  assert.strictEqual(rt.description, fullTopic.description);
  assert.deepStrictEqual(rt.labels, ["Envelope", "MEP"]);
});

t("round-trip: priority, author, assignee survive", () => {
  assert.strictEqual(rt.priority, "High");
  assert.strictEqual(rt.author, "Ada Arch");
  assert.strictEqual(rt.assignee, "Cara Str");
});

t("round-trip: dates survive to second precision", () => {
  assert.strictEqual(rt.createdAt, SEC(T0));
  assert.strictEqual(rt.updatedAt, SEC(T1));
  assert.strictEqual(rt.dueDate, SEC(T2));
});

t("round-trip: comments survive with guid/author/date/text", () => {
  assert.strictEqual(rt.comments.length, 2);
  assert.strictEqual(rt.comments[0].guid, fullTopic.comments[0].guid);
  assert.strictEqual(rt.comments[0].author, "Bob MEP");
  assert.strictEqual(rt.comments[0].text, "Confirmed on site — needs offset");
  assert.strictEqual(rt.comments[0].date, SEC(T1));
  assert.strictEqual(rt.comments[1].author, "Ada Arch");
  assert.strictEqual(rt.comments[1].text, "Wall moved 150mm");
});

t("round-trip: nested <Comment> text element is NOT double-counted", () => {
  // A naive doc.querySelectorAll("Comment") would match both the outer
  // comment element and its nested text element → 4 comments for 2 real ones.
  assert.strictEqual(rt.comments.length, 2);
});

/* ── C. Legacy attribute dialect (older builds' exports) still parses ──── */

const legacy = `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Topic Guid="issue-1729000000-x" TopicType="Issue" TopicStatus="Open" Priority="Medium" AssignedTo="Old Assignee" DueDate="2026-02-01T00:00:00.000Z" Title="Legacy attribute topic" CreationDate="2026-01-05T08:00:00.000Z" ModifiedDate="2026-01-06T09:00:00.000Z" Author="Old Author">
<DescriptionText>legacy description body</DescriptionText>
<Comment Guid="legacy-c1" Date="2026-01-05T10:00:00.000Z" Author="Legacy Commenter"><Text>legacy comment text</Text></Comment>
</Topic>
</Markup>`;

t("legacy dialect: attributes + DescriptionText/<Text> still import", () => {
  const p = parseBcfMarkup(legacy);
  assert.strictEqual(p.title, "Legacy attribute topic");
  assert.strictEqual(p.description, "legacy description body");
  assert.strictEqual(p.priority, "Medium");
  assert.strictEqual(p.author, "Old Author");
  assert.strictEqual(p.assignee, "Old Assignee");
  assert.strictEqual(p.dueDate, Date.parse("2026-02-01T00:00:00.000Z"));
  assert.strictEqual(p.createdAt, Date.parse("2026-01-05T08:00:00.000Z"));
  assert.strictEqual(p.updatedAt, Date.parse("2026-01-06T09:00:00.000Z"));
  assert.strictEqual(p.comments.length, 1);
  assert.strictEqual(p.comments[0].guid, "legacy-c1");
  assert.strictEqual(p.comments[0].author, "Legacy Commenter");
  assert.strictEqual(p.comments[0].text, "legacy comment text");
  assert.strictEqual(p.comments[0].date, Date.parse("2026-01-05T10:00:00.000Z"));
});

/* ── D. Clash-writer markup shape (bcf21.ts delegation) ────────────────── */

t("clash writer dialect: header + labels + comment parse through the same parser", () => {
  const clashMarkup = buildBcfMarkup({
    guid: "cc2f4c1e-1111-4222-8333-444455556666",
    topicType: "Hard Clash",
    topicStatus: "Open",
    title: "Wall 001 vs Duct 002",
    priority: "High",
    labels: ["Structure"],
    createdAt: T0,
    createdBy: "Open BIM Studio",
    description: "Intersecting 0.42 m",
    headerXml: `\n    <File IfcProject=""><Filename>Open BIM Studio</Filename></File>`,
    viewpointFile: "viewpoint.bcfv",
    comments: [{ guid: "dd2f4c1e-1111-4222-8333-444455556666", author: "Reviewer", date: T1, text: "Resolved by reroute" }],
  });
  const p = parseBcfMarkup(clashMarkup);
  assert.strictEqual(p.title, "Wall 001 vs Duct 002");
  assert.strictEqual(p.topicType, "Hard Clash");
  assert.strictEqual(p.author, "Open BIM Studio");
  assert.strictEqual(p.description, "Intersecting 0.42 m");
  assert.strictEqual(p.comments.length, 1);
  assert.strictEqual(p.comments[0].text, "Resolved by reroute");
  assert.ok(/<Header>\s*<File IfcProject="">/.test(clashMarkup));
});

/* ── E. Failure behaviour ──────────────────────────────────────────────── */

t("malformed XML throws (importBCF catches per topic folder)", () => {
  assert.throws(() => parseBcfMarkup("<Markup><Topic Guid="), /unclosed|bad name|expected/);
  assert.throws(() => parseBcfMarkup("<Markup></Markup>"), /no <Topic>/);
});

/* ── F. GUID helpers ───────────────────────────────────────────────────── */

t("bcfGuid: 1000 guids all match GuidType, unique, uuid4 shape", () => {
  const seen = new Set();
  for (let k = 0; k < 1000; k++) {
    const g = bcfGuid();
    assert.ok(isBcfGuid(g), "matches GuidType: " + g);
    assert.strictEqual(g[14], "4", "version 4");
    assert.ok(/[89ab]/.test(g[19]), "variant nibble");
    seen.add(g);
  }
  assert.strictEqual(seen.size, 1000, "no collisions");
});

t("isBcfGuid rejects internal ids, empty and malformed values", () => {
  assert.strictEqual(isBcfGuid("issue-1729-abc"), false);
  assert.strictEqual(isBcfGuid(""), false);
  assert.strictEqual(isBcfGuid(null), false);
  assert.strictEqual(isBcfGuid("9b2f4c1e-1111-4222-8333-44445555666"), false);
  assert.strictEqual(isBcfGuid("9b2f4c1e_1111_4222_8333_444455556666"), false);
  assert.ok(BCF_GUID_RE instanceof RegExp);
});

/* ── G. Source-level writer guard (both writers share the dialect) ─────── */

t("source guard: issues writer delegates to buildBcfMarkup with UUID guids", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/modules/issues/bcf.ts"), "utf8");
  assert.ok(src.includes("buildBcfMarkup({"), "exportBCF must call buildBcfMarkup");
  assert.ok(src.includes("guid: bcfGuid()"), "topic guid must come from bcfGuid()");
  assert.ok(!src.includes("DescriptionText"), "legacy writer dialect removed");
  assert.ok(!/Title="\$\{xmlEsc\(/.test(src), "Title attribute writer removed");
  assert.ok(src.includes("parseBcfMarkup(markupXml)"), "importBCF must parse via parseBcfMarkup");
});

t("source guard: clash writer delegates to buildBcfMarkup", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/modules/export/bcf21.ts"), "utf8");
  assert.ok(src.includes('buildBcfMarkup({'), "writeMarkupBcf must delegate to the shared writer");
  assert.ok(src.includes('from "../issues/bcf-markup"'), "import present");
});

console.log(`\nbcf21-roundtrip: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
