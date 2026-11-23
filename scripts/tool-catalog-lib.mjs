// Shared static scan of palette-command registrations across src/ (#102).
//
// Coverage — every way the codebase registers a palette command:
//  - literal `registerCommand({ id: "...", ... })`, including the method
//    form `cp.registerCommand?.({ id: "..." })` and local aliases such as
//    `const reg = cp.registerCommand` + `reg({ id: "..." })`
//  - table-driven loops: `for (const [id, ...] of cmds) registerCommand({ id, ... })`
//    where `cmds` is a literal tuple/object array (gap packs, compatibility
//    bridge, auto-dimensions, view-templates)
//  - template ids fed by literal tables: `tool.${tool}` (+ helper calls),
//    `panel.${key}.toggle` (+ panels table), `authoring.tool.${tool}`
//    (+ Object.entries(toolAliases)), `schedule.template.${tpl.id}`
//    (+ BUILT_IN_TEMPLATES), `panel.${spec.key}.*` (+ PANELS),
//    `paletteIds[definition.id]` (+ the modify registry), and the
//    bim-experience indirection (`registerBimCommand` catalog, registered
//    to the palette as `bim.${id}`)
//  - data-driven templates whose ids come from runtime data
//    (`clash.scenario.${s.id}`, `schedule.saved.${s.id}`,
//    `level.activate.` + id): reported as PATTERNS, one per literal prefix.
//    A pattern is only accepted when the loop's source is provably
//    non-literal (a call such as listScenarios() / levels.list()).
//
// Resolution is scope-aware: a template variable is resolved from the
// supplier whose body ENCLOSES the registration (the loop or helper it
// sits in), so two tables binding the same variable name in one file
// (e.g. the `tool()` helper's calls vs the toolAliases loop) never leak
// ids into each other. Anything dynamic that no resolver can explain is
// an UNRESOLVED site: the gate fails on it rather than silently ignoring
// it. An ambiguous supplier (two literal tables of the same name, a
// missing cross-file registry) also reports unresolved — fail closed.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

export function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(f, out); }
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(f);
  }
  return out;
}

/* ── string / bracket aware scanning ─────────────────────────────── */

/** Index just past the string starting at src[i] (', " or `). Handles \ escapes and ${...} nesting. */
function skipString(src, i) {
  const q = src[i];
  i++;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (q === "`" && ch === "$" && src[i + 1] === "{") {
      const close = matchBracket(src, i + 1);
      if (close < 0) return src.length;
      i = close + 1;
      continue;
    }
    if (ch === q) return i + 1;
    i++;
  }
  return src.length;
}

function skipComment(src, i) {
  if (src.startsWith("//", i)) {
    const nl = src.indexOf("\n", i);
    return nl < 0 ? src.length : nl + 1;
  }
  if (src.startsWith("/*", i)) {
    const end = src.indexOf("*/", i + 2);
    return end < 0 ? src.length : end + 2;
  }
  return i;
}

/** Index of the bracket matching the opener at src[openIdx], or -1. */
function matchBracket(src, openIdx) {
  const open = src[openIdx];
  const close = { "(": ")", "[": "]", "{": "}" }[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") { i = skipString(src, i) - 1; continue; }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) { i = skipComment(src, i) - 1; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Split text on top-level commas (string / bracket / comment aware). */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") { i = skipString(text, i) - 1; continue; }
    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) { i = skipComment(text, i) - 1; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Value of a '...' / "..." literal (trimmed), or null when not one. */
function parseStringLiteral(text) {
  const t = text.trim();
  if (t.length < 2 || (t[0] !== '"' && t[0] !== "'")) return null;
  let out = "";
  for (let i = 1; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && i + 1 < t.length) { out += t[i + 1]; i++; continue; }
    if (ch === t[0]) return out;
    out += ch;
  }
  return null;
}

/** Top-level `key: "value"` string properties of an object literal's inner text. */
function stringProps(inner) {
  const props = new Map();
  for (const part of splitTopLevel(inner)) {
    const m = /^\s*(?:([A-Za-z_$][\w$]*)|"([^"]+)")\s*:\s*([\s\S]*)$/.exec(part);
    if (!m) continue;
    const v = parseStringLiteral(m[3]);
    if (v !== null) props.set(m[1] ?? m[2], v);
  }
  return props;
}

/** Skip whitespace and comments, returning the next significant index. */
function skipWs(src, i) {
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) { i = skipComment(src, i); continue; }
    break;
  }
  return i;
}

/** End of the statement starting at i (first `;` at depth 0), or src.length. */
function statementEnd(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '"' || ch === "'" || ch === "`") { j = skipString(src, j) - 1; continue; }
    if (ch === "/" && (src[j + 1] === "/" || src[j + 1] === "*")) { j = skipComment(src, j) - 1; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) return j; depth--; }
    else if (ch === ";" && depth === 0) return j + 1;
  }
  return src.length;
}

/* ── literal declarations ─────────────────────────────────────────── */

/**
 * Find `const <name> ... = [` (array literal) in src.
 * Returns { text, index }, { ambiguous: true } when two literal
 * declarations of the name exist, or null. A `const <name> = <call>`
 * (non-literal) does not count as a literal.
 */
function findArrayLiteral(src, name) {
  const hits = [];
  const re = new RegExp(`const\\s+${name}\\b`, "g");
  let m;
  while ((m = re.exec(src))) {
    let j = m.index + m[0].length;
    let found = -1;
    while (j < src.length) {
      if (src[j] === ";") break;
      if (src[j] === "=" && src[j + 1] !== ">" && src[j + 1] !== "=") {
        const k = skipWs(src, j + 1);
        if (src[k] === "[") { found = k; break; }
      }
      if (src[j] === '"' || src[j] === "'" || src[j] === "`") { j = skipString(src, j); continue; }
      j++;
    }
    if (found >= 0) {
      const close = matchBracket(src, found);
      if (close >= 0) hits.push({ text: src.slice(found, close + 1), index: found });
    }
  }
  if (hits.length > 1) return { ambiguous: true };
  return hits[0] ?? null;
}

function findObjectLiteral(src, name) {
  const re = new RegExp(`const\\s+${name}\\b`, "g");
  let m;
  while ((m = re.exec(src))) {
    let j = m.index + m[0].length;
    while (j < src.length) {
      if (src[j] === ";") break;
      if (src[j] === "=" && src[j + 1] !== ">" && src[j + 1] !== "=") {
        const k = skipWs(src, j + 1);
        if (src[k] === "{") {
          const close = matchBracket(src, k);
          if (close >= 0) return { text: src.slice(k, close + 1), index: k };
        }
        break;
      }
      if (src[j] === '"' || src[j] === "'" || src[j] === "`") { j = skipString(src, j); continue; }
      j++;
    }
  }
  return null;
}

/** Is `name` declared in src by a non-literal assignment (call, identifier, ...)? */
function hasNonLiteralDecl(src, name) {
  const re = new RegExp(`const\\s+${name}\\b[^;]*?=\\s*(?!\\[|\\{)`, "g");
  return re.test(src);
}

/* ── rows of a literal table ──────────────────────────────────────── */

/** Skip leading whitespace and comments, returning the remaining text. */
function stripLeading(text) {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) { i = skipComment(text, i); continue; }
    break;
  }
  return text.slice(i);
}

/**
 * One row of a literal array.
 * Returns { kind: "tuple", values } | { kind: "object", props } | { kind: "call", fn, args } | null.
 */
function parseRow(el) {
  const t = stripLeading(el).trim();
  if (!t) return null;
  if (t.startsWith("[")) {
    const close = matchBracket(t, 0);
    if (close < 0) return null;
    return { kind: "tuple", values: splitTopLevel(t.slice(1, close)).map((p) => parseStringLiteral(p)) };
  }
  if (t.startsWith("{")) {
    const close = matchBracket(t, 0);
    if (close < 0) return null;
    return { kind: "object", props: stringProps(t.slice(1, close)) };
  }
  const call = /^([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/.exec(t);
  if (call) return { kind: "call", fn: call[1], args: splitTopLevel(call[2]).map((p) => parseStringLiteral(p)) };
  return null;
}

function arrayRows(arrayText) {
  const close = matchBracket(arrayText, 0);
  if (close < 0) return [];
  const rows = [];
  for (const el of splitTopLevel(arrayText.slice(1, close))) {
    const row = parseRow(el);
    if (row) rows.push(row);
  }
  return rows;
}

/** Object literal's string keys (quoted or bare identifiers) with string values. */
function objectKeys(objText) {
  const close = matchBracket(objText, 0);
  if (close < 0) return [];
  const out = [];
  for (const part of splitTopLevel(objText.slice(1, close))) {
    const m = /^\s*(?:([A-Za-z_$][\w$-]*)|"([^"]+)")\s*:/.exec(part);
    if (m) out.push({ key: m[1] ?? m[2], value: parseStringLiteral(part.slice(m[0].length)) });
  }
  return out;
}

/* ── cross-file modify registry ───────────────────────────────────── */

function readModifyRegistry(root) {
  const p = path.join(root, "src", "modules", "modify", "registry.ts");
  if (!existsSync(p)) return null;
  const src = readFileSync(p, "utf8");
  const start = src.indexOf("BUILT_IN_MODIFY_COMMANDS");
  if (start < 0) return null;
  // The declaration carries a type annotation (`...Definition[] = [`):
  // find the assignment's `[`, not the `[]` in the type.
  const eq = src.indexOf("= [", start);
  if (eq < 0) return null;
  const arr = src.indexOf("[", eq);
  const close = matchBracket(src, arr);
  if (arr < 0 || close < 0) return null;
  const defs = [];
  for (const row of arrayRows(src.slice(arr, close + 1))) {
    if (row.kind === "object" && row.props.has("id")) {
      defs.push({ id: row.props.get("id"), label: row.props.get("label") ?? row.props.get("id") });
    }
  }
  return defs;
}

/* ── per-file scanner ─────────────────────────────────────────────── */

/**
 * @returns {{ commands: {id,label,category,file,origin}[], dynamicSites: {file,line,reason}[], patterns: {prefix,category,file,line}[] }}
 */
function scanFile(src, rel, root) {
  const commands = [], dynamicSites = [], patterns = [];
  const lineOf = (idx) => src.slice(0, idx).split("\n").length;
  const seenPattern = new Set();
  const addPattern = (prefix, category, idx) => {
    if (seenPattern.has(prefix)) return;
    seenPattern.add(prefix);
    patterns.push({ prefix, category: category || "", file: rel, line: lineOf(idx) });
  };
  const addCommand = (id, label, category, origin) => {
    if (typeof id !== "string" || !id) return;
    commands.push({ id, label: label ?? "", category: category ?? "", file: rel, origin });
  };

  /* — loop / helper shapes ———————————————————————————————— */

  // All `for (const ... of ...)` loops: { destr, iter, bodyStart, bodyEnd, index }.
  const findLoops = () => {
    const out = [];
    const re = /for\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const open = src.indexOf("(", m.index);
      const close = matchBracket(src, open);
      if (close < 0) continue;
      const head = src.slice(open + 1, close);
      const hm = /^\s*const\s+(?:\[([^\]]+)\]|(\w+))\s+of\s+([\s\S]+)$/.exec(head.trim());
      if (!hm) continue;
      const destr = hm[1] ? hm[1].split(",").map((s) => s.trim()).filter(Boolean) : [hm[2]];
      const after = skipWs(src, close + 1);
      let bodyStart, bodyEnd;
      if (src[after] === "{") { bodyStart = after; bodyEnd = matchBracket(src, after) + 1; }
      else { bodyStart = after; bodyEnd = statementEnd(src, after); }
      out.push({ destr, iter: hm[3].trim(), bodyStart, bodyEnd: bodyEnd < 0 ? src.length : bodyEnd, index: m.index });
    }
    return out;
  };

  // Arrow helpers `const H = (params) => body` and `function H(params) body`.
  // Params are parsed with bracket matching (not `[^)]*`): a parameter
  // type may itself contain parens, e.g. `regTool: (tool: string, ...) => void`.
  const paramNames = (inner) =>
    splitTopLevel(inner).map((p) => p.trim().split(/[:=]/)[0].trim().replace(/\?$/, "")).filter(Boolean);
  const findHelpers = () => {
    const out = [];
    const re = /const\s+(\w+)\s*=\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const open = src.indexOf("(", m.index);
      const close = matchBracket(src, open);
      if (close < 0) continue;
      const after = skipWs(src, close + 1);
      if (src.slice(after, after + 2) !== "=>") continue;
      const params = paramNames(src.slice(open + 1, close));
      const bodyAt = skipWs(src, after + 2);
      let bodyStart, bodyEnd;
      if (src[bodyAt] === "{") { bodyStart = bodyAt; bodyEnd = matchBracket(src, bodyAt) + 1; }
      else { bodyStart = bodyAt; bodyEnd = statementEnd(src, bodyAt); }
      out.push({ name: m[1], params, bodyStart, bodyEnd: bodyEnd < 0 ? src.length : bodyEnd, index: m.index });
    }
    const fre = /function\s+(\w+)\s*\(/g;
    while ((m = fre.exec(src))) {
      const open = src.indexOf("(", m.index);
      const close = matchBracket(src, open);
      if (close < 0) continue;
      const params = paramNames(src.slice(open + 1, close));
      const brace = src.indexOf("{", close);
      if (brace < 0) continue;
      // Only a return-type annotation may sit between `)` and `{`.
      if (/[;=]/.test(src.slice(close + 1, brace))) continue;
      out.push({ name: m[1], params, bodyStart: brace, bodyEnd: matchBracket(src, brace) + 1, index: m.index });
    }
    return out;
  };

  const findFunctionParams = (name) => {
    const h = findHelpers().find((x) => x.name === name);
    return h ? h.params : null;
  };

  /* — variable bindings ————————————————————————————————
     A binding scope maps variable names to values: a string, or a props
     object { id, label, ... } for object rows. bindingsForVar resolves a
     variable from the supplier whose body ENCLOSES the use site, so two
     tables binding the same name in one file never leak into each other. */

  const bindingsForVar = (varName, callPos, depth = 0) => {
    if (depth > 3) return { scopes: [], dataDriven: false };
    // 1. Enclosing supplier first.
    for (const loop of findLoops()) {
      if (!loop.destr.includes(varName)) continue;
      if (callPos < loop.bodyStart || callPos >= loop.bodyEnd) continue;
      const r = scopesForIterable(loop.iter, loop.destr, depth);
      if (r === "data-driven") return { scopes: [], dataDriven: true };
      return { scopes: r ?? [], dataDriven: false };
    }
    for (const helper of findHelpers()) {
      const pIdx = helper.params.indexOf(varName);
      if (pIdx < 0) continue;
      if (callPos < helper.bodyStart || callPos >= helper.bodyEnd) continue;
      return { scopes: callSiteScopes(helper.name, helper.params, pIdx, varName, callPos, depth), dataDriven: false };
    }
    // 2. Fallback: union of every supplier in the file (registrations that
    //    sit outside their supplier's body — none in this codebase today).
    const scopes = [];
    let dataDriven = false;
    for (const loop of findLoops()) {
      if (!loop.destr.includes(varName)) continue;
      const r = scopesForIterable(loop.iter, loop.destr, depth);
      if (r === "data-driven") { dataDriven = true; continue; }
      if (r) scopes.push(...r);
    }
    for (const helper of findHelpers()) {
      const pIdx = helper.params.indexOf(varName);
      if (pIdx < 0) continue;
      scopes.push(...callSiteScopes(helper.name, helper.params, pIdx, varName, callPos, depth));
    }
    return { scopes: dedupeScopes(scopes), dataDriven };
  };

  const dedupeScopes = (scopes) => {
    const seen = new Set(), out = [];
    for (const s of scopes) {
      const k = JSON.stringify(s);
      if (!seen.has(k)) { seen.add(k); out.push(s); }
    }
    return out;
  };

  // Scopes for one `for...of` iterable. Returns scopes, "data-driven", or null.
  const scopesForIterable = (iter, destr, depth) => {
    const entries = /^Object\.entries\(\s*(\w+)\s*\)$/.exec(iter);
    if (entries) {
      const obj = findObjectLiteral(src, entries[1]);
      if (!obj) return hasNonLiteralDecl(src, entries[1]) ? "data-driven" : null;
      return objectKeys(obj.text).map(({ key, value }) => {
        const scope = {};
        scope[destr[0]] = key;
        if (destr[1]) scope[destr[1]] = value ?? "";
        return scope;
      });
    }
    const values = /^(\w+)\.values\(\)$/.exec(iter);
    if (values) {
      const bim = resolveBimCommands();
      if (!bim) return null;
      return bim.map((b) => ({ [destr[0]]: b }));
    }
    const callM = /^([A-Za-z_$][\w$]*)\(/.exec(iter);
    if (callM && matchBracket(iter, callM[0].length - 1) === iter.length - 1) {
      if (callM[1] === "listModifyCommandDefinitions") {
        const defs = readModifyRegistry(root);
        if (!defs) return null;
        return defs.map((d) => ({ [destr[0]]: d }));
      }
      return "data-driven";
    }
    if (/[?(\.]/.test(iter) && !/^\w+$/.test(iter)) return "data-driven";
    if (/^\w+$/.test(iter)) {
      const arr = findArrayLiteral(src, iter);
      if (arr && arr.ambiguous) return null;
      if (arr) return arrayRows(arr.text).map((row) => rowToScope(row, destr));
      return hasNonLiteralDecl(src, iter) ? "data-driven" : null;
    }
    return null;
  };

  const rowToScope = (row, destr) => {
    const scope = {};
    if (row.kind === "tuple") {
      destr.forEach((name, i) => { if (row.values[i] != null) scope[name] = row.values[i]; });
    } else if (row.kind === "object") {
      scope[destr[0]] = Object.fromEntries(row.props);
    } else if (row.kind === "call") {
      // `T("id", "name", ...)` rows (schedule templates): positional id/name.
      scope[destr[0]] = { id: row.args[0] ?? "", name: row.args[1] ?? "" };
    }
    return scope;
  };

  // Scopes for one helper/function parameter, from its call sites.
  const callSiteScopes = (name, params, pIdx, varName, callPos, depth) => {
    const out = [];
    const callRe = new RegExp(`(^|[^\\w$])${name}\\s*\\(`, "g");
    let cm;
    while ((cm = callRe.exec(src))) {
      const open = src.indexOf("(", cm.index + cm[0].length - 1);
      const close = matchBracket(src, open);
      if (close < 0) continue;
      const args = splitTopLevel(src.slice(open + 1, close));
      const litScope = {};
      args.forEach((a, i) => { const lit = parseStringLiteral(a); if (lit !== null && params[i]) litScope[params[i]] = lit; });
      if (args.some((a) => a.trim() === name)) {
        // Helper passed as an argument: G(..., H) — resolve G's other args,
        // which flow positionally into H through G's body call H(...).
        const before = src.slice(0, open);
        const callee = /(\w+)\s*$/.exec(before);
        if (!callee) continue;
        const gParams = findFunctionParams(callee[1]);
        if (!gParams) continue;
        const scope = { ...litScope };
        args.forEach((a, i) => {
          if (a.trim() === name) return;
          const pName = gParams[i];
          if (!pName) return;
          if (litScope[pName] !== undefined) { scope[pName] = litScope[pName]; return; }
          const inner = bindingsForVar(a.trim(), open, depth + 1);
          for (const s of inner.scopes) if (s[a.trim()] !== undefined) scope[pName] = s[a.trim()];
        });
        const hScope = {};
        params.forEach((p) => { if (scope[p] !== undefined) hScope[p] = scope[p]; });
        if (Object.keys(hScope).length) out.push(hScope);
        continue;
      }
      const arg = args[pIdx];
      if (arg === undefined) continue;
      const lit = parseStringLiteral(arg);
      if (lit !== null) { out.push({ ...litScope, [varName]: lit }); continue; }
      const inner = bindingsForVar(arg.trim(), open, depth + 1);
      for (const s of inner.scopes) {
        if (s[arg.trim()] === undefined) continue;
        const merged = { ...litScope };
        for (const p of params) if (s[p] !== undefined) merged[p] = s[p];
        merged[varName] = s[arg.trim()];
        out.push(merged);
      }
    }
    return dedupeScopes(out);
  };

  /* — bim-experience BimCommand catalog ————————————————————
     registerBimCommand({ id, label, ribbon, ... }) calls (literal ids,
     plus template ids fed by the architecture/structure/mep/modify/
     annotate tables) form a Map; setupBimExperience registers each one
     to the palette as `bim.<id>`. Later sets overwrite earlier ones,
     exactly like the Map. Returns [{ id, label, ribbon }] or null. */
  let bimCache = undefined;
  const resolveBimCommands = () => {
    if (bimCache !== undefined) return bimCache;
    bimCache = null;
    if (!src.includes("registerBimCommand(")) return null;
    const out = new Map();
    const re = /registerBimCommand\(\{\s*id:\s*/g;
    let m;
    while ((m = re.exec(src))) {
      const objOpen = src.indexOf("{", m.index);
      const objClose = matchBracket(src, objOpen);
      if (objClose < 0) continue;
      const obj = src.slice(objOpen, objClose + 1);
      const head = obj.slice(0, 800);
      const label = /label\s*:\s*"([^"]*)"/.exec(head)?.[1] ?? "";
      const ribbon = /ribbon\s*:\s*"([^"]*)"/.exec(head)?.[1] ?? "";
      const afterId = head.slice(head.indexOf("id:") + 3).trim();
      const lit = /^"([^"]+)"/.exec(afterId);
      if (lit) { out.set(lit[1], { id: lit[1], label, ribbon }); continue; }
      const tpl = /^`([^`]*)`/.exec(afterId);
      if (tpl) {
        const resolved = resolveTemplate(tpl[1], m.index);
        if (resolved) for (const r of resolved) out.set(r.id, { id: r.id, label: r.label || label, ribbon: r.ribbon || ribbon });
      }
    }
    bimCache = [...out.values()];
    return bimCache;
  };

  /* — template resolution ———————————————————————————————— */
  const substitute = (tpl, scope) => {
    let ok = true;
    const out = tpl.replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const parts = expr.trim().split(".");
      let v = scope[parts[0]];
      for (let i = 1; i < parts.length && v !== undefined; i++) v = v?.[parts[i]];
      if (typeof v !== "string") { ok = false; return ""; }
      return v;
    });
    return ok ? out : null;
  };

  const resolveTemplate = (tpl, callPos, labelTpl = "", categoryTpl = "") => {
    const vars = [...tpl.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim().split(".")[0]);
    if (!vars.length) return [{ id: tpl, label: labelTpl, category: categoryTpl, ribbon: "" }];
    const { scopes } = bindingsForVar(vars[0], callPos);
    if (!scopes.length) return null;
    const byId = new Map();
    for (const scope of scopes) {
      const id = substitute(tpl, scope);
      if (id === null) continue;
      let label = "";
      if (labelTpl) label = substitute(labelTpl, scope) ?? "";
      else if (typeof scope.label === "string") label = scope.label;
      let category = "";
      if (categoryTpl) category = substitute(categoryTpl, scope) ?? "";
      else if (typeof scope.category === "string") category = scope.category;
      const ribbon = typeof scope.ribbon === "string" ? scope.ribbon : "";
      byId.set(id, { id, label, category, ribbon }); // later wins, like a Map
    }
    return byId.size ? [...byId.values()] : null;
  };

  /* — one register*Command({...}) object literal ———————————————————— */
  const classifyObject = (objText) => {
    const head = objText.slice(0, 1200);
    const labelM = /label\s*:\s*"([^"]*)"/.exec(head);
    const labelTplM = /label\s*:\s*`([^`]*)`/.exec(head);
    const catM = /category\s*:\s*"([^"]*)"/.exec(head);
    const label = labelM?.[1] ?? "";
    const labelTpl = labelTplM?.[1] ?? "";
    const category = catM?.[1] ?? "";
    const idAt = head.search(/id\s*:/);
    if (idAt < 0) {
      // Shorthand: registerCommand({ id, label, ... }) — id is a loop variable.
      if (/^\{\s*id\s*[,}]/.test(head)) return { kind: "bare", varName: "id", label, category };
      return { kind: "other" };
    }
    const after = head.slice(idAt + 2).replace(/^:\s*/, "");
    // "lit" — only when the literal IS the whole id (next char , or }).
    // `"prefix" + var` is NOT a literal: it is a data-driven template.
    const lit = /^"([^"]+)"\s*[,}]/.exec(after) ?? /^'([^']+)'\s*[,}]/.exec(after);
    if (lit) return { kind: "literal", id: lit[1], label, category };
    const concat = /^"([^"]+)"\s*\+\s*([\w$.]+)/.exec(after) ?? /^'([^']+)'\s*\+\s*([\w$.]+)/.exec(after);
    if (concat) return { kind: "concat", prefix: concat[1], varExpr: concat[2], label, category };
    const tpl = /^`([^`]*)`/.exec(after);
    if (tpl) return { kind: "template", template: tpl[1], label, labelTpl, category };
    const map = /^(\w+)\[(\w+)\.id\]/.exec(after);
    if (map) return { kind: "map", map: map[1], loopVar: map[2], label, category };
    const bare = /^(\w+)\s*[,}]/.exec(after);
    if (bare) return { kind: "bare", varName: bare[1], label, category };
    return { kind: "other" };
  };

  const consume = (c, callPos, origin) => {
    if (c.kind === "literal") { addCommand(c.id, c.label, c.category, origin); return; }
    if (c.kind === "template") {
      const resolved = resolveTemplate(c.template, callPos, c.labelTpl || c.label, c.category);
      if (resolved) { for (const r of resolved) addCommand(r.id, r.label || c.label, r.category || c.category, origin); return; }
      const firstVar = c.template.match(/\$\{([^}]+)\}/)?.[1].trim().split(".")[0] ?? "";
      const { dataDriven } = bindingsForVar(firstVar, callPos);
      const prefix = c.template.split("${")[0];
      if (dataDriven && prefix) { addPattern(prefix, c.category, callPos); return; }
      dynamicSites.push({ file: rel, line: lineOf(callPos), reason: `unresolved template id \`${c.template}\`` });
      return;
    }
    if (c.kind === "concat") {
      const varName = c.varExpr.split(".")[0];
      // A concatenated id whose variable resolves to literal call sites is
      // enumerable exactly like a backtick template: "tool." + id is
      // `tool.${id}`. Only when no literal supplier exists is it a pattern.
      const resolved = resolveTemplate(`${c.prefix}\${${c.varExpr}}`, callPos, c.label, c.category);
      if (resolved) { for (const r of resolved) addCommand(r.id, r.label || c.label, r.category || c.category, origin); return; }
      const { dataDriven } = bindingsForVar(varName, callPos);
      if (dataDriven) { addPattern(c.prefix, c.category, callPos); return; }
      dynamicSites.push({ file: rel, line: lineOf(callPos), reason: `unresolved concatenated id "${c.prefix}" + ${c.varExpr}` });
      return;
    }
    if (c.kind === "map") {
      const mapObj = findObjectLiteral(src, c.map);
      const defs = readModifyRegistry(root);
      if (!mapObj || !defs) {
        dynamicSites.push({ file: rel, line: lineOf(callPos), reason: `unresolved map id ${c.map}[${c.loopVar}.id]` });
        return;
      }
      const entries = new Map(objectKeys(mapObj.text).map(({ key, value }) => [key, value]));
      for (const d of defs) {
        const mapped = entries.get(d.id);
        if (mapped) addCommand(mapped, d.label, c.category, "dynamic:modify-map");
      }
      return;
    }
    if (c.kind === "bare") {
      const { scopes, dataDriven } = bindingsForVar(c.varName, callPos);
      if (scopes.length) {
        for (const scope of scopes) {
          const v = scope[c.varName];
          if (typeof v === "string") addCommand(v, scope.label ?? c.label, scope.category ?? c.category, origin);
          else if (v && typeof v === "object") addCommand(v.id ?? "", v.label ?? v.title ?? c.label, v.category ?? c.category, origin);
        }
        return;
      }
      if (dataDriven) {
        dynamicSites.push({ file: rel, line: lineOf(callPos), reason: `data-driven id ${c.varName} with no literal prefix to pattern on` });
        return;
      }
      dynamicSites.push({ file: rel, line: lineOf(callPos), reason: `unresolved id variable ${c.varName}` });
      return;
    }
    dynamicSites.push({ file: rel, line: lineOf(callPos), reason: "unresolved dynamic registerCommand call" });
  };

  /* — pass 1: register*Command({...}) call sites ———————————————————— */
  const callRe = /([\w$]+\.)?(register\w*Command)(\?\.)?\(\s*\{/g;
  let cm;
  while ((cm = callRe.exec(src))) {
    if (cm.index > 0 && /[\w$]/.test(src[cm.index - 1])) continue; // part of a longer identifier
    const name = cm[2];
    if (name === "registerBimCommand") continue; // handled by resolveBimCommands
    const objOpen = src.indexOf("{", cm.index);
    const objClose = matchBracket(src, objOpen);
    if (objClose < 0) continue;
    const objText = src.slice(objOpen, objClose + 1);
    // The bim.* palette loop is owned by pass 3 (it needs the BimCommand
    // label/ribbon, which this generic path cannot resolve).
    if (/id\s*:\s*`bim\.\$\{\w+\.id\}`/.test(objText.slice(0, 300))) continue;
    const origin = name === "registerCommand" ? (cm[1] ? "literal:method" : "literal") : "literal:alias";
    consume(classifyObject(objText), cm.index, origin);
  }

  /* — pass 2: local aliases of registerCommand ———————————————————— */
  // const <a> = <x>.registerCommand  (object-arg alias) — critical-gaps-ui
  // <a> = <x>.registerCommand ?? null / palette?.register ?? ... (table alias) — bridge, auto-dim, view-templates
  const aliasInits = [];
  const constAliasRe = /const\s+(\w+)\s*=\s*([^\n;]+)/g;
  let am;
  while ((am = constAliasRe.exec(src))) {
    const init = am[2].trim();
    if (!init.includes("registerCommand") && !init.includes("palette?.register")) continue;
    aliasInits.push({ name: am[1], init });
  }
  // Plain assignments: `register = (cp as Any).registerCommand ?? null`.
  const assignAliasRe = /(\w+)\s*=\s*([^;\n]*\.registerCommand[^;\n]*)/g;
  while ((am = assignAliasRe.exec(src))) {
    if (/const\s+$/.test(src.slice(0, am.index))) continue; // already caught above
    aliasInits.push({ name: am[1], init: am[2].trim() });
  }
  // The literal array behind `<alias>(<loopVar>)`: resolve the loop variable
  // through the enclosing for-of loop (e.g. `for (const c of cmds) register(c)`).
  const tableForLoopVar = (varName, callPos) => {
    for (const loop of findLoops()) {
      if (!loop.destr.includes(varName)) continue;
      if (callPos < loop.bodyStart || callPos >= loop.bodyEnd) continue;
      if (/^\w+$/.test(loop.iter)) {
        const arr = findArrayLiteral(src, loop.iter);
        if (arr && !arr.ambiguous) return arr.text;
      }
      return null;
    }
    return null;
  };
  for (const { name, init } of aliasInits) {
    // Pass 1 already owns calls spelled `registerCommand(...)` — including
    // a local variable shadowing the import (schedule-templates). Only
    // differently-named aliases reach this pass.
    if (/^register\w*Command$/.test(name)) continue;
    if (/^[\w$.?]+\.registerCommand$/.test(init)) {
      // Object-arg alias: <a>({ id: "literal", ... }) — critical-gaps-ui.
      const callRe2 = new RegExp(`(^|[^\\w$])${name}\\s*\\(\\s*\\{`, "g");
      let m2;
      while ((m2 = callRe2.exec(src))) {
        if (m2.index > 0 && /[\w$]/.test(src[m2.index - 1])) continue;
        const objOpen = src.indexOf("{", m2.index);
        const objClose = matchBracket(src, objOpen);
        if (objClose < 0) continue;
        consume(classifyObject(src.slice(objOpen, objClose + 1)), m2.index, "literal:alias");
      }
      continue;
    }
    if (/palette\?\.register/.test(init) || /\.registerCommand/.test(init)) {
      // Table alias: <a>(<var>) over a literal object array — the bridge's
      // register(c), auto-dimensions' and view-templates' register(c).
      // The fallback chain (palette?.register ?? ... ?? window.registerCommand)
      // resolves to nothing at runtime today, but the table is a registration
      // source all the same: enumerate it, don't ignore it.
      const origin = /palette\?\.register/.test(init) ? "dynamic:fallback-table" : "dynamic:table";
      const callRe2 = new RegExp(`(^|[^\\w$])${name}\\(\\s*(\\w+)\\s*\\)`, "g");
      let m2;
      while ((m2 = callRe2.exec(src))) {
        const direct = findArrayLiteral(src, m2[2]);
        const arrText = direct && !direct.ambiguous ? direct.text : tableForLoopVar(m2[2], m2.index);
        if (!arrText) {
          if (direct?.ambiguous) dynamicSites.push({ file: rel, line: lineOf(m2.index), reason: `ambiguous table ${m2[2]} for ${name}()` });
          continue;
        }
        for (const row of arrayRows(arrText)) {
          if (row.kind !== "object") continue;
          const id = row.props.get("id");
          if (id) addCommand(id, row.props.get("label") ?? row.props.get("title") ?? "", row.props.get("category") ?? "", origin);
        }
      }
    }
  }

  /* — pass 3: bim.* palette registration ———————————————————— */
  const bimLoop = /for\s*\(\s*const\s+(\w+)\s+of\s+(\w+)\.values\(\)\s*\)[\s\S]{0,400}?registerPaletteCommand\(\{\s*id:\s*`bim\.\$\{(\w+)\.id\}`/.exec(src);
  if (bimLoop) {
    const bim = resolveBimCommands();
    if (!bim || !bim.length) {
      dynamicSites.push({ file: rel, line: lineOf(bimLoop.index), reason: "unresolved bim.* palette loop (no BimCommand catalog)" });
    } else {
      for (const b of bim) {
        addCommand(`bim.${b.id}`, b.label, b.ribbon ? `BIM ${b.ribbon}` : "BIM", "dynamic:bim-catalog");
      }
    }
  }

  return { commands, dynamicSites, patterns };
}

/** @returns {{ commands: {id,label,category,file,origin}[], dynamicSites: {file,line,reason}[], patterns: {prefix,category,file,line}[] }} */
export function scanSource(root) {
  const commands = [], dynamicSites = [], patterns = [];
  const srcDir = path.join(root, "src");
  for (const file of walk(srcDir)) {
    const src = readFileSync(file, "utf8");
    const rel = path.relative(root, file).split(path.sep).join("/");
    const r = scanFile(src, rel, root);
    commands.push(...r.commands);
    dynamicSites.push(...r.dynamicSites);
    patterns.push(...r.patterns);
  }
  return { commands, dynamicSites, patterns };
}
