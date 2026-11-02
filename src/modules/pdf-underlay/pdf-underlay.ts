/**
 * PDF Underlay — rasterise a PDF page and embed as a plan-view underlay.
 *
 * BIM-equivalent of Revit's "PDF Underlay" tool. Loads a PDF, rasterises
 * the requested page to a canvas, and produces a textured THREE.Mesh that
 * can be placed in plan views at a chosen scale + rotation.
 *
 * Uses pdf-lib to extract page count + dimensions; rasterisation uses the
 * browser's built-in PDF.js (loaded lazily) or a fallback canvas snapshot.
 */

import * as THREE from "three";

export interface PdfUnderlayParams {
  /** PDF file bytes. */
  file: File | Uint8Array;
  /** Page number (1-indexed). */
  page?: number;
  /** Drawing scale (real-world mm per PDF pt). e.g. 1:100 on A1 → 0.297/841. */
  scale?: number;
  /** World position (m). */
  position?: { x: number; y: number; z: number };
  /** Rotation around Y axis (radians). */
  angle?: number;
  /** Rasterisation DPI. */
  dpi?: number;
  /** Opacity 0-1. */
  opacity?: number;
  /** Snap to PDF entities (true = enable PDF entity snapping). */
  enableSnapping?: boolean;
}

export interface PdfUnderlayResult {
  pageCount: number;
  pageSize: { width: number; height: number }; // pt
  rasterSize: { width: number; height: number }; // px
  object: THREE.Object3D;
  scale: number;
}

const DEFAULTS = {
  page: 1,
  scale: 0.000353, // 1 pt = 0.3528 mm → m
  position: { x: 0, y: 0, z: 0 },
  angle: 0,
  dpi: 150,
  opacity: 0.7,
  enableSnapping: false,
};

/** Load a PDF and create an underlay mesh. */
export async function loadPdfUnderlay(input: PdfUnderlayParams): Promise<PdfUnderlayResult> {
  const p = { ...DEFAULTS, ...input };
  const bytes = input.file instanceof Uint8Array ? input.file : new Uint8Array(await input.file.arrayBuffer());

  // Lazy-load pdf-lib to read page count + size.
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.load(bytes);
  const pageCount = pdf.getPageCount();
  if (p.page < 1 || p.page > pageCount) {
    throw new Error(`Page ${p.page} out of range (1..${pageCount})`);
  }
  const page = pdf.getPage(p.page - 1);
  const { width, height } = page.getSize();

  // Rasterise using the locally bundled PDF.js dependency.
  const pdfjs: any = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const pdfDoc = await loadingTask.promise;
  const pdfPage = await pdfDoc.getPage(p.page);
  const viewport = pdfPage.getViewport({ scale: p.dpi / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d")!;
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  const dataUrl = canvas.toDataURL("image/png");

  // Build textured plane.
  const worldWidth = width * p.scale;
  const worldHeight = height * p.scale;
  const texture = new THREE.TextureLoader().load(dataUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.PlaneGeometry(worldWidth, worldHeight);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: p.opacity,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(
    p.position.x + worldWidth * 0.5,
    p.position.y,
    p.position.z + worldHeight * 0.5,
  );
  mesh.rotation.z = -p.angle;
  mesh.name = `obs-pdf-underlay-p${p.page}`;
  mesh.userData = {
    kind: "pdf-underlay",
    page: p.page,
    scale: p.scale,
    snapping: p.enableSnapping,
  };

  return {
    pageCount,
    pageSize: { width, height },
    rasterSize: { width: canvas.width, height: canvas.height },
    object: mesh,
    scale: p.scale,
  };
}

let pdfJsPromise: Promise<any> | null = null;
function loadPdfJs(): Promise<any> {
  if (pdfJsPromise) return pdfJsPromise;
  pdfJsPromise = import("pdfjs-dist")
    .then((pdfjs: any) => {
      // Resolve the worker from the exact installed package version. Vite emits
      // it as a same-origin asset, avoiding CDN outages and version mismatches.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    })
    .catch((error: unknown) => {
      // Permit a later user retry if the first dynamic import fails.
      pdfJsPromise = null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load the bundled PDF.js library: ${detail}`);
    });
  return pdfJsPromise;
}
