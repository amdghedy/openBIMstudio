/** "PDF → DWG…" - pick a vector PDF, choose pages, download .dwg (or a .zip of one DWG per page). Local, nothing is uploaded. */
import { ctx } from "../core/context";
import { openFormModal } from "./form-modal";
import { zipStore } from "../modules/export/zip-store";
import { parsePageSpec } from "../modules/drawings/pdf-to-dwg";

function toast(kind: string, message: string): void {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { kind, message, timeout: 6000 } }));
}

function download(name: string, bytes: Uint8Array, type: string): void {
  const buf = new Uint8Array(bytes).buffer as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([buf], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function openPdfToDwg(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,application/pdf";
  input.onchange = () => { const f = input.files?.[0]; if (f) void runPdfToDwg(f); };
  input.click();
}

export async function runPdfToDwg(file: File): Promise<void> {
  const values = await openFormModal({
    title: "PDF → DWG",
    subtitle: `${file.name} - converted in this browser; the PDF is not uploaded.`,
    submitLabel: "Convert and download",
    fields: [
      { kind: "text", key: "pages", label: "Pages", default: "all", placeholder: "all, 1, 2-4, 7", hint: "One DWG per page. Several pages download as a zip." },
      { kind: "select", key: "format", label: "Output", default: "dwg", options: [["dwg", "DWG (binary)"], ["dxf", "DXF (text)"]] },
      { kind: "select", key: "units", label: "Scale", default: "25.4", options: [["25.4", "True size, millimetres (1 pt = 0.3528 mm)"], ["1", "Raw PDF points (1 pt = 1 unit)"]] },
      { kind: "divider", key: "d", label: "" },
    ],
  });
  if (!values) return;
  toast("info", `Converting ${file.name} to ${String(values.format).toUpperCase()}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { convertPdfToDwg } = await import("../modules/drawings/pdf-to-dwg");
    // Resolve the page text against the real page count.
    const probe = await convertPdfToDwgPageCount(bytes);
    const pages = parsePageSpec(String(values.pages ?? "all"), probe);
    const res = await convertPdfToDwg(bytes, file.name, { pages, format: values.format === "dxf" ? "dxf" : "dwg", unitsPerInch: Number(values.units) || 25.4 });
    if (!res.files.length) {
      toast("error", `Nothing converted: ${res.skipped.map((s) => `page ${s.page}: ${s.reason}`).join("; ")}`);
      return;
    }
    const base = file.name.replace(/\.pdf$/i, "") || "drawing";
    if (res.files.length === 1) {
      const f = res.files[0];
      download(f.name, f.data, f.name.endsWith(".dwg") ? "application/acad" : "application/dxf");
    } else {
      download(`${base}-drawings.zip`, zipStore(res.files.map((f) => ({ name: f.name, data: f.data }))), "application/zip");
    }
    const skip = res.skipped.length ? ` Skipped: ${res.skipped.map((s) => `page ${s.page} (${s.reason})`).join("; ")}.` : "";
    toast(res.skipped.length ? "warn" : "success", `${res.files.length} ${String(values.format).toUpperCase()} file(s) from ${file.name}.${skip}`);
  } catch (e) {
    toast("error", `PDF → DWG failed: ${(e as Error).message}`);
  }
}

async function convertPdfToDwgPageCount(bytes: Uint8Array): Promise<number> {
  const { pdfToDxfDocument } = await import("../modules/drawings/pdf-vector");
  return (await pdfToDxfDocument(bytes, { page: 1 })).pageCount;
}

/** Boot hook: lets automated browser tests (and scripts) run the converter on a File without the OS file chooser. */
export function setupPdfToDwg(): void {
  (ctx.features as any).pdfToDwg = { run: (file: File) => runPdfToDwg(file) };
}
