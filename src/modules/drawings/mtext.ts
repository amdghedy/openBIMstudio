/**
 * MTEXT / TEXT inline-format decoder (AutoCAD codes) -> plain text with "\n" line breaks.
 * Pure. Handles paragraph breaks, stacked fractions, unicode escapes, %% symbols and strips
 * font/height/colour/width/oblique/tracking/alignment/underline/overline/strike codes.
 *
 * `mtextRuns` is the structured view of the same decoder: inline `\C`/`\c` colours and
 * `\f` bold/italic flags become run boundaries so the viewer can paint native-looking
 * multi-colour, multi-weight MTEXT instead of flattening every note to one style.
 */
export interface MTextRunStyle {
  text: string;
  /** ACI colour (1-255) from an inline `\C<n>;` code. */
  color?: number;
  /** 0xRRGGBB true colour from an inline `\c<n>;` code (high bookkeeping byte masked off). */
  rgb?: number;
  /** `\fName|b1;` bold flag. */
  bold?: boolean;
  /** `\fName|i1;` italic flag. */
  italic?: boolean;
}

const SYMBOL: Record<string, string> = { c: "Ø", d: "°", p: "±" };

/** Runs of an MTEXT string with the inline colour / weight state they were written in. */
export function mtextRuns(src: string): MTextRunStyle[] {
  const s = String(src ?? "");
  const runs: MTextRunStyle[] = [];
  let buf = "";
  let color: number | undefined, rgb: number | undefined, bold: boolean | undefined, italic: boolean | undefined;
  const flush = () => {
    if (!buf) return;
    runs.push({
      text: buf,
      ...(color != null ? { color } : {}),
      ...(rgb != null ? { rgb } : {}),
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
    });
    buf = "";
  };
  const setStyle = (next: { color?: number; rgb?: number; bold?: boolean; italic?: boolean }) => {
    if (next.color === color && next.rgb === rgb && next.bold === bold && next.italic === italic) return;
    flush();
    color = next.color;
    rgb = next.rgb;
    bold = next.bold;
    italic = next.italic;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      const n = s[i + 1];
      if (n === undefined) break;
      if (n === "P") { buf += "\n"; i++; continue; }
      if (n === "~") { buf += " "; i++; continue; }
      if (n === "\\" || n === "{" || n === "}") { buf += n; i++; continue; }
      if (n === "U" && s[i + 2] === "+") {
        const m = /^[0-9A-Fa-f]{4}/.exec(s.slice(i + 3));
        if (m) { buf += String.fromCharCode(parseInt(m[0], 16)); i += 6; continue; }
      }
      if (n === "M" && s[i + 2] === "+") { const m = /^[0-9A-Fa-f]{5}/.exec(s.slice(i + 3)); if (m) { i += 7; continue; } }
      if (n === "S") {
        const end = s.indexOf(";", i + 2);
        if (end > 0) {
          const body = s.slice(i + 2, end).replace(/\\\//g, "\u0000");
          const m = /^(.*?)([\/#^])(.*)$/.exec(body);
          const t = m ? m[1] + (m[2] === "^" ? " " : "/") + m[3] : body;
          buf += t.replace(/\u0000/g, "/").replace(/\\\^/g, "^").replace(/\\#/g, "#");
          i = end; continue;
        }
      }
      // Codes terminated by ';' (font, height, colour, width, oblique, tracking, align, paragraph, ...)
      if ("fFHhCcWwQTtAap".includes(n)) {
        const end = s.indexOf(";", i + 2);
        if (end > 0 && !s.slice(i + 2, end).includes("\\")) {
          const body = s.slice(i + 2, end);
          if (n === "f" || n === "F") {
            // \fName|b1|i1|c0|p2; — the bold/italic flags ride on the font code.
            const m = /^([^|]*)((?:\|[a-z]-?\d+)*)/.exec(body);
            const flag = (k: string) => (m ? new RegExp("\\|" + k + "(-?\\d+)").exec(m[2] ?? "")?.[1] : undefined);
            setStyle({
              color, rgb,
              bold: flag("b") === "1" || undefined,
              italic: flag("i") === "1" || undefined,
            });
          } else if (n === "C") {
            const v = Number(body);
            setStyle({ color: v >= 1 && v <= 255 ? v : undefined, rgb, bold, italic });
          } else if (n === "c") {
            const v = Number(body);
            setStyle({
              color: v >= 1 && v <= 255 ? v : undefined,
              rgb: v > 255 ? v & 0xffffff : rgb,
              bold, italic,
            });
          }
          i = end; continue;
        }
      }
      if ("LlOoKk".includes(n)) { i++; continue; } // underline / overline / strike toggles (no terminator)
      if (n === "N") { buf += "\n"; i++; continue; }
      // Unknown escape: drop the backslash, keep the character.
      buf += n; i++; continue;
    }
    if (ch === "{" || ch === "}") continue;
    if (ch === "%" && s[i + 1] === "%") {
      const k = s[i + 2];
      if (k !== undefined) {
        const sym = SYMBOL[k.toLowerCase()];
        if (sym) { buf += sym; i += 2; continue; }
        if (/[uUoOkK]/.test(k)) { i += 2; continue; }
        const m = /^\d{3}/.exec(s.slice(i + 2));
        if (m) { buf += String.fromCharCode(parseInt(m[0], 10)); i += 4; continue; }
      }
    }
    if (ch === "\r") continue;
    buf += ch;
  }
  flush();
  return runs;
}

/**
 * Structured fields a reader should attach to the flattened TEXT built from an MTEXT:
 * the column wrap, the line-spacing factor and the styled runs. Widths/factors that are
 * missing or meaningless are simply omitted, so callers can pass candidates straight through.
 */
export function mtextExtras(
  src: string,
  width?: unknown,
  spacing?: unknown,
): { wrapWidth?: number; lineSpacing?: number; runs?: MTextRunStyle[] } {
  const runs = mtextRuns(src);
  const styled = runs.length > 1 || runs.some((r) => r.color != null || r.rgb != null || r.bold || r.italic);
  const w = typeof width === "number" ? width : Number(width);
  const sp = typeof spacing === "number" ? spacing : Number(spacing);
  return {
    ...(Number.isFinite(w) && w > 0 ? { wrapWidth: w } : {}),
    ...(Number.isFinite(sp) && sp > 0 && Math.abs(sp - 1) > 1e-9 ? { lineSpacing: sp } : {}),
    ...(styled ? { runs } : {}),
  };
}

export function cleanText(src: string): string {
  const joined = mtextRuns(src).map((r) => r.text).join("");
  return joined.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();
}

/** Visual lines of a cleaned text value. */
export function textLines(value: string): string[] {
  return String(value ?? "").split("\n");
}

/** First inline font code `\\fName|b1|i1|...;` of an MTEXT string (font family + bold/italic), if any. */
export function mtextFont(src: string): { font?: string; bold?: boolean; italic?: boolean } {
  const m = /\\[fF]([^|;\\]+)((?:\|[a-z]-?\d+)*);/.exec(String(src ?? ""));
  if (!m) return {};
  const flag = (k: string) => new RegExp("\\|" + k + "(-?\\d+)").exec(m[2])?.[1];
  return { font: m[1].trim(), bold: flag("b") === "1" || undefined, italic: flag("i") === "1" || undefined };
}

/** Inline width factor `\\W0.8;` (first occurrence) of an MTEXT string. */
export function mtextWidthFactor(src: string): number | undefined {
  const m = /\\W(\d*\.?\d+);/.exec(String(src ?? ""));
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * First inline colour of an MTEXT string:
 * `\\C<aci>;` (ACI 1-255) or `\\c<truecolour>;` (0xRRGGBB decimal, writers
 * sometimes set the high bookkeeping byte — masked off). BYLAYER/BYBLOCK
 * special values are ignored so the entity keeps inheriting properly.
 */
export function mtextColor(src: string): { color?: number; rgb?: number } {
  const s = String(src ?? "");
  const mC = /\\C(\d+);/.exec(s);
  if (mC) {
    const v = Number(mC[1]);
    if (v >= 1 && v <= 255) return { color: v };
  }
  const mc = /\\c(\d+);/.exec(s);
  if (mc) {
    const v = Number(mc[1]);
    if (v > 255) return { rgb: v & 0xffffff };
    if (v >= 1 && v <= 255) return { color: v };
  }
  return {};
}
