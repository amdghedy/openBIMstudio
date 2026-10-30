/**
 * MTEXT / TEXT inline-format decoder (AutoCAD codes) -> plain text with "\n" line breaks.
 * Pure. Handles paragraph breaks, stacked fractions, unicode escapes, %% symbols and strips
 * font/height/colour/width/oblique/tracking/alignment/underline/overline/strike codes.
 */
const SYMBOL: Record<string, string> = { c: "Ø", d: "°", p: "±" };

export function cleanText(src: string): string {
  const s = String(src ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      const n = s[i + 1];
      if (n === undefined) break;
      if (n === "P") { out += "\n"; i++; continue; }
      if (n === "~") { out += " "; i++; continue; }
      if (n === "\\" || n === "{" || n === "}") { out += n; i++; continue; }
      if (n === "U" && s[i + 2] === "+") {
        const m = /^[0-9A-Fa-f]{4}/.exec(s.slice(i + 3));
        if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += 6; continue; }
      }
      if (n === "M" && s[i + 2] === "+") { const m = /^[0-9A-Fa-f]{5}/.exec(s.slice(i + 3)); if (m) { i += 7; continue; } }
      if (n === "S") {
        const end = s.indexOf(";", i + 2);
        if (end > 0) {
          const body = s.slice(i + 2, end).replace(/\\\//g, "\u0000");
          const m = /^(.*?)([\/#^])(.*)$/.exec(body);
          const t = m ? m[1] + (m[2] === "^" ? " " : "/") + m[3] : body;
          out += t.replace(/\u0000/g, "/").replace(/\\\^/g, "^").replace(/\\#/g, "#");
          i = end; continue;
        }
      }
      // Codes terminated by ';' (font, height, colour, width, oblique, tracking, align, paragraph, ...)
      if ("fFHhCcWwQTtAap".includes(n)) {
        const end = s.indexOf(";", i + 2);
        if (end > 0 && !s.slice(i + 2, end).includes("\\")) { i = end; continue; }
      }
      if ("LlOoKk".includes(n)) { i++; continue; } // underline / overline / strike toggles (no terminator)
      if (n === "N") { out += "\n"; i++; continue; }
      // Unknown escape: drop the backslash, keep the character.
      out += n; i++; continue;
    }
    if (ch === "{" || ch === "}") continue;
    if (ch === "%" && s[i + 1] === "%") {
      const k = s[i + 2];
      if (k !== undefined) {
        const sym = SYMBOL[k.toLowerCase()];
        if (sym) { out += sym; i += 2; continue; }
        if (/[uUoOkK]/.test(k)) { i += 2; continue; }
        const m = /^\d{3}/.exec(s.slice(i + 2));
        if (m) { out += String.fromCharCode(parseInt(m[0], 10)); i += 4; continue; }
      }
    }
    if (ch === "\r") continue;
    out += ch;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();
}

/** Visual lines of a cleaned text value. */
export function textLines(value: string): string[] {
  return String(value ?? "").split("\n");
}
