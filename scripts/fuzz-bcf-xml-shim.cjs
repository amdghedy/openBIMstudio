/**
 * Minimal XML-tree shim: the exact DOM subset parseBcfMarkup relies on
 * (tag selectors, child access, attributes, textContent).
 *
 * Extracted verbatim from tests/bcf21-roundtrip.test.cjs, where the same code
 * is the conformance test's parser. It lives here (instead of being required
 * from the test) so the BCF fuzz child can run standalone. The roundtrip test
 * owns this code: if the parser subset changes there, copy the change here.
 *
 * Scope note: in production the browser DOMParser tokenizes the XML; this
 * shim stands in for it in Node. The BCF fuzz leg therefore exercises the
 * markup *semantic* layer (topic/comment extraction, GUID validation, date
 * handling) against adversarial trees — not the browser's XML tokenizer.
 * A hang/crash reported by this leg is in the shim or in parseBcfMarkup,
 * never in a production tokenizer.
 */


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
  // Memoized: the browser DOM's `children` is a live HTMLCollection with
  // O(1) indexed access, but a naive getter re-maps every child on every
  // access — and bcf-markup's childEls() reads el.children per loop
  // iteration, which made a 2000-comment markup take ~115 s here while the
  // XML tokenization itself took 66 ms. Memoizing models the browser, so the
  // fuzz leg measures the product code instead of the harness. This is a
  // deliberate divergence from the roundtrip test's copy of this shim (which
  // only ever parses small markups); the tree shape and order are unchanged.
  let childrenCache = null;
  return {
    tagName: node.tagName,
    get textContent() { return textOfNode(node); },
    get children() {
      if (!childrenCache) childrenCache = elementChildren(node).map(makeElement);
      return childrenCache;
    },
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

/** Factory shape parseBcfMarkup expects via setBcfDomParserFactory. */
function makeBcfDomParserFactory() {
  return () => ({
    parseFromString(xml, _mime) { return makeDocument(parseXml(xml)); },
  });
}

module.exports = { makeBcfDomParserFactory, parseXml, makeDocument };
