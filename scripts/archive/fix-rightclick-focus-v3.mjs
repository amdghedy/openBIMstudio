import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

async function existsFile(fullPath) {
  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

async function backup(rel) {
  const full = path.join(root, rel);
  if (!(await existsFile(full))) return false;
  await fs.copyFile(full, full + ".bak-" + stamp);
  return true;
}

async function read(rel) {
  return fs.readFile(path.join(root, rel), "utf8");
}

async function write(rel, content) {
  await fs.writeFile(path.join(root, rel), content, "utf8");
}

function stripNonAscii(value) {
  return value.replace(/[^\x20-\x7E]/g, "");
}

function cleanIconValue(value) {
  let clean = stripNonAscii(value);

  // Remove obvious corrupted placeholder icons.
  if (/\?/.test(clean)) clean = "";

  // Remove control/control-like residue.
  clean = clean.replace(/[\u0000-\u001F\u007F]/g, "").trim();

  return clean;
}

function cleanStringProperty(src, prop) {
  let changed = false;

  const doubleRe = new RegExp(prop + ':\\s*"([^"]*)"', "g");
  src = src.replace(doubleRe, (match, value) => {
    let clean = value;

    if (prop === "icon") {
      clean = cleanIconValue(value);
    } else {
      clean = stripNonAscii(value).trim();
    }

    if (clean !== value) {
      changed = true;
      return prop + ': "' + clean + '"';
    }

    return match;
  });

  const singleRe = new RegExp(prop + ":\\s*'([^']*)'", "g");
  src = src.replace(singleRe, (match, value) => {
    let clean = value;

    if (prop === "icon") {
      clean = cleanIconValue(value);
    } else {
      clean = stripNonAscii(value).trim();
    }

    if (clean !== value) {
      changed = true;
      return prop + ": '" + clean + "'";
    }

    return match;
  });

  return { src, changed };
}

const focusObject = `{
            type: "action",
            text: "Focus",
            icon: "",
            onclick: () => {
              void (async () => {
                try {
                  const cam: any = await import("./camera-tools");
                  const auth: any = (ctx as any).features?.authoring;

                  let sel: any = (ctx as any).features?.selection;
                  if (!sel) {
                    try {
                      sel = (await import("./selection")).selection;
                    } catch {
                      /* selection bridge optional */
                    }
                  }

                  const authIdsRaw = auth?.getSelectedIds?.() ?? [];
                  const authIds: string[] = Array.from(authIdsRaw as any).map(
                    (x: any) => String(x),
                  );

                  if (authIds.length) {
                    const THREE_MOD: any = await import("three");
                    const union = new THREE_MOD.Box3();
                    const elements = auth?.getElements?.() ?? [];

                    for (const id of authIds) {
                      const el = elements.find((x: any) => x?.id === id);
                      const wb = el ? auth?.getElementWorldBox?.(el) : null;
                      if (wb && !wb.isEmpty()) union.union(wb);
                    }

                    if (!union.isEmpty()) {
                      cam.focusOnBox?.(union);
                      return;
                    }
                  }

                  const snap = sel?.snapshot?.() ?? {};
                  const map: Record<string, Set<number>> = {};
                  let hasFrag = false;

                  for (const [modelId, ids] of Object.entries(snap)) {
                    if (ids instanceof Set && ids.size) {
                      map[modelId] = ids;
                      hasFrag = true;
                    }
                  }

                  if (hasFrag) {
                    await cam.fitToMap?.(map);
                    return;
                  }

                  cam.fitAll?.();
                } catch (err) {
                  console.warn("[context-menu] Focus safe fallback failed", err);

                  try {
                    const cam: any = await import("./camera-tools");
                    cam.fitAll?.();
                  } catch {
                    /* focus unavailable */
                  }
                }
              })();
            },
          }`;

function patchFocusObjects(src) {
  const re = /text:\s*["']Focus["']/g;
  const indexes = [];
  let m;

  while ((m = re.exec(src))) {
    indexes.push(m.index);
  }

  let changed = false;

  for (let i = indexes.length - 1; i >= 0; i--) {
    const textIndex = indexes[i];
    const start = src.lastIndexOf("{", textIndex);

    if (start < 0) continue;

    let depth = 0;
    let end = -1;

    for (let j = start; j < src.length; j++) {
      const ch = src[j];

      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;

        if (depth === 0) {
          end = j;
          break;
        }
      }
    }

    if (end < 0) continue;

    const before = src.slice(0, start);
    const after = src.slice(end + 1);

    src = before + focusObject + after;
    changed = true;
  }

  return { src, changed };
}

async function patchContextMenu() {
  const rel = "src/features/context-menu.ts";
  const full = path.join(root, rel);

  if (!(await existsFile(full))) {
    console.log("SKIP: context-menu.ts not found");
    return;
  }

  let src = await read(rel);
  const original = src;

  const rIcon1 = cleanStringProperty(src, "icon");
  src = rIcon1.src;

  const rText = cleanStringProperty(src, "text");
  src = rText.src;

  const rFocus = patchFocusObjects(src);
  src = rFocus.src;

  const rIcon2 = cleanStringProperty(src, "icon");
  src = rIcon2.src;

  if (src !== original) {
    await backup(rel);
    await write(rel, src);
    console.log("PATCHED: src/features/context-menu.ts");
  } else {
    console.log("NO CHANGE: src/features/context-menu.ts");
  }
}

function removeMmbMovedGuards(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let changed = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.includes("__OBS_MMB_MOVED") && line.includes("drag-end")) {
      changed = true;

      let depth =
        (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

      i++;

      while (i < lines.length && depth > 0) {
        depth +=
          (lines[i].match(/\{/g) || []).length -
          (lines[i].match(/\}/g) || []).length;
        i++;
      }

      continue;
    }

    out.push(line);
    i++;
  }

  return { src: out.join("\n"), changed };
}

function ensureSingleWheelMmbGuard(src) {
  const lines = src.split(/\r?\n/);
  const cleaned = [];
  let changed = false;

  for (const line of lines) {
    if (line.includes("__OBS_MMB_HELD") && line.includes("return true")) {
      changed = true;
      continue;
    }

    cleaned.push(line);
  }

  const out = [];
  let inserted = false;

  for (const line of cleaned) {
    out.push(line);

    if (
      !inserted &&
      /if\s*\(\s*g\.kind\s*===\s*["']wheel["']\s*\)\s*\{/.test(line)
    ) {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      out.push(indent + "  if ((window as any).__OBS_MMB_HELD) return true;");
      inserted = true;
      changed = true;
    }
  }

  return { src: out.join("\n"), changed };
}

function ensureWheelAuthorityGuard(src) {
  if (src.includes("__OBS_WHEEL_AUTHORITY")) {
    return { src, changed: false };
  }

  const lines = src.split(/\r?\n/);
  const out = [];
  let inserted = false;

  for (const line of lines) {
    if (
      !inserted &&
      /zoomAtCursor\s*\(\s*g\.event\.deltaY/.test(line)
    ) {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      out.push(
        indent + "if ((window as any).__OBS_WHEEL_AUTHORITY) return false;",
      );
      inserted = true;
    }

    out.push(line);
  }

  return { src: out.join("\n"), changed: inserted };
}

function patchDampingLines(src) {
  const lines = src.split(/\r?\n/);
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (
      line.includes("dampingFactor") &&
      !trimmed.startsWith("/*") &&
      !trimmed.startsWith("//")
    ) {
      lines[i] = "/* dampingFactor deprecated; skipped */";
      changed = true;
    }
  }

  return { src: lines.join("\n"), changed };
}

async function patchNavigation() {
  const rel = "src/features/navigation.ts";
  const full = path.join(root, rel);

  if (!(await existsFile(full))) {
    console.log("SKIP: navigation.ts not found");
    return;
  }

  let src = await read(rel);
  const original = src;

  const r1 = removeMmbMovedGuards(src);
  src = r1.src;

  const r2 = ensureSingleWheelMmbGuard(src);
  src = r2.src;

  const r3 = ensureWheelAuthorityGuard(src);
  src = r3.src;

  const r4 = patchDampingLines(src);
  src = r4.src;

  if (src !== original) {
    await backup(rel);
    await write(rel, src);
    console.log("PATCHED: src/features/navigation.ts");
  } else {
    console.log("NO CHANGE: src/features/navigation.ts");
  }
}

async function main() {
  console.log("");
  console.log("Running Node.js right-click / Focus / navigation cleanup...");
  console.log("");

  await patchContextMenu();
  await patchNavigation();

  console.log("");
  console.log("Node patch completed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});