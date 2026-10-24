/**
 * Open BIM Studio project file (.obsproj).
 *
 * Layout (single binary file, no dependencies, models are never copied into memory twice):
 *   bytes 0..7    magic "OBSPROJ1"
 *   bytes 8..11   uint32 little-endian: header length H
 *   bytes 12..    H bytes of UTF-8 JSON header { format, version, savedAt, app, doc, blobs:[{modelId,name,size,type}] }
 *   then          every model blob, back to back, in header order
 */
import type { ProjectDoc } from "./types";

export const PROJECT_FILE_EXT = ".obsproj";
export const PROJECT_FILE_MIME = "application/vnd.openbimstudio.project";
const MAGIC = "OBSPROJ1";
const VERSION = 1;

export interface ProjectBlob { modelId: string; name: string; blob: Blob }

interface Header {
  format: "obsproj";
  version: number;
  savedAt: number;
  app: string;
  doc: ProjectDoc;
  blobs: { modelId: string; name: string; size: number; type: string }[];
}

export function suggestedFileName(doc: Pick<ProjectDoc, "name">): string {
  const base = (doc.name || "project").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() || "project";
  return base + PROJECT_FILE_EXT;
}

export function buildProjectFile(doc: ProjectDoc, blobs: readonly ProjectBlob[]): Blob {
  const header: Header = {
    format: "obsproj",
    version: VERSION,
    savedAt: Date.now(),
    app: "Open BIM Studio",
    doc,
    blobs: blobs.map((b) => ({ modelId: b.modelId, name: b.name, size: b.blob.size, type: b.blob.type || "" })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.byteLength, true);
  return new Blob([MAGIC, len, json, ...blobs.map((b) => b.blob)], { type: PROJECT_FILE_MIME });
}

export class ProjectFileError extends Error {}

export async function parseProjectFile(file: Blob): Promise<{ doc: ProjectDoc; blobs: ProjectBlob[]; savedAt: number }> {
  if (file.size < 12) throw new ProjectFileError("This is not an Open BIM Studio project file (too small).");
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const magic = new TextDecoder().decode(head.slice(0, 8));
  if (magic !== MAGIC) throw new ProjectFileError("This is not an Open BIM Studio project file.");
  const hlen = new DataView(head.buffer, head.byteOffset + 8, 4).getUint32(0, true);
  if (hlen <= 0 || 12 + hlen > file.size) throw new ProjectFileError("The project file is damaged (bad header).");
  let header: Header;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(await file.slice(12, 12 + hlen).arrayBuffer())));
  } catch {
    throw new ProjectFileError("The project file is damaged (unreadable header).");
  }
  if (header.format !== "obsproj" || !header.doc || !Array.isArray(header.blobs)) throw new ProjectFileError("Unrecognised project file.");
  if (header.version > VERSION) throw new ProjectFileError(`This project was saved by a newer version (file v${header.version}). Update the app to open it.`);
  const blobs: ProjectBlob[] = [];
  let off = 12 + hlen;
  for (const b of header.blobs) {
    if (off + b.size > file.size) throw new ProjectFileError(`The project file is truncated (model "${b.name}" is incomplete).`);
    blobs.push({ modelId: b.modelId, name: b.name, blob: file.slice(off, off + b.size, b.type || undefined) });
    off += b.size;
  }
  return { doc: header.doc, blobs, savedAt: header.savedAt };
}
