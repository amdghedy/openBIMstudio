import { defineConfig } from "vite";

import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
/**
 * Vite config for Open BIM Studio.
 *
 * Proxies exist because some AI providers do not send permissive CORS
 * headers for browser requests:
 *   /ollama     → http://localhost:11434   (Ollama)
 *   /lmstudio   → http://localhost:1234    (LM Studio; CORS off by default)
 *   /anthropic  → https://api.anthropic.com (Anthropic; no CORS headers)
 *
 * Providers that DO send CORS headers (OpenAI, Groq, Gemini, DeepSeek,
 * Mistral, Together, OpenRouter, Fireworks, Perplexity, xAI) are called
 * directly — no proxy needed.
 */
export default defineConfig({
  plugins: [react(), crossOriginIsolation(), pwaPrecache()],
  esbuild: { target: "esnext" },
  // web-ifc WASM is served from a versioned folder (/web-ifc/<version>/) so a
  // new build can never be paired with stale cached WASM bytes (PWA precache,
  // browser HTTP cache, edge cache) — the source of web-ifc BindingErrors
  // like "StreamMeshes called with 4 arguments, expected 3".
  define: {
    __WEB_IFC_VERSION__: JSON.stringify(webIfcVersion()),
  },
  build: {
    target: "esnext",
    // Large vendors (web-ifc WASM, @thatopen/components, monaco) inherently
    // exceed 1.5 MB; raise the limit so CI build logs stay clean.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // Vite 8 / rolldown requires a function (object form throws TypeError).
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/node_modules\/(?:react|react-dom|react-redux|@reduxjs)\//.test(id)) return "react-vendor";
          if (/node_modules\/(?:@mui|@emotion)\//.test(id)) return "mui-vendor";
          if (/node_modules\/(?:three|three-mesh-bvh|three-csg-ts)\//.test(id)) return "three-vendor";
          if (/node_modules\/@thatopen\//.test(id)) return "thatopen-vendor";
          if (/node_modules\/@tldraw\//.test(id)) return "tldraw-vendor";
          if (/node_modules\/monaco-editor\//.test(id)) return "monaco-vendor";
          if (/node_modules\/web-ifc\//.test(id)) return "ifc-vendor";
          if (/node_modules\/(?:yjs|y-websocket)\//.test(id)) return "yjs-vendor";
        },
      },
    },
  },
  resolve: {
    dedupe: ["lit", "lit-html", "lit-element", "@lit/reactive-element"],
    // three ≥ r187's TTFLoader imports opentype.js from a CDN at runtime —
    // that makes the whole boot depend on third-party reachability and
    // blanks the app wherever CDNs are blocked (corporate filters, some
    // regional ISPs). Alias the CDN specifier to the same-origin package.
    alias: [
      {
        find: "https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/+esm",
        replacement: "opentype.js",
      },
    ],
  },
  worker: {
    format: "es",
  },
  server: {
    port: 3000,
    proxy: {
      "/ollama": {
        target: "http://localhost:11434",
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/ollama/, ""),
      },
      "/lmstudio": {
        target: "http://localhost:1234",
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/lmstudio/, ""),
      },
      "/anthropic": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/anthropic/, ""),
      },
    },
  },
  preview: {
    port: 3000,
    proxy: {
      "/ollama": {
        target: "http://localhost:11434",
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/ollama/, ""),
      },
      "/lmstudio": {
        target: "http://localhost:1234",
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/lmstudio/, ""),
      },
      "/anthropic": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/anthropic/, ""),
      },
    },
  },
});
// --- OpenBIMStudio :: COOP/COEP for SharedArrayBuffer (web-ifc-mt) ---
// CSP for the DWG reader worker document ONLY. The LibreDWG wasm registers its
// whole API through emscripten embind, which generates invoker functions with
// `new Function` during wasm startup - JavaScript evaluation the main document
// CSP deliberately forbids. The parser therefore runs in an isolated module
// worker; this scoped policy is the ONLY place 'unsafe-eval' is allowed, and
// the worker has no DOM or BIM state (bytes in -> geometry JSON out).
const DWG_READER_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
// Solid readers additionally import their classic-script glue as a blob module
// (module workers have no importScripts), so this one scoped policy also allows
// blob: scripts — still confined to the isolated reader-worker document.
const SOLID_READER_WORKER_CSP =
  "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
const DWG_READER_WORKER_URL = /dwg-reader-worker/;
const SOLID_READER_WORKER_URL = /solid-reader-worker/;
const readerWorkerCsp = (url: string | undefined) =>
  url && SOLID_READER_WORKER_URL.test(url) ? SOLID_READER_WORKER_CSP
    : url && DWG_READER_WORKER_URL.test(url) ? DWG_READER_WORKER_CSP
    : undefined;

function crossOriginIsolation() {
  return {
    name: "cross-origin-isolation",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        applySecurityHeaders(res, readerWorkerCsp(req.url));
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        applySecurityHeaders(res, readerWorkerCsp(req.url));
        next();
      });
    },
  };
}
// --- OpenBIMStudio :: PWA — list every built file in the service worker so the app runs offline ---
function webIfcVersion(): string {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "node_modules", "web-ifc", "package.json"), "utf8")).version || "";
  } catch { return ""; }
}

function pwaPrecache() {
  let outDir = "dist";
  return {
    name: "obs-pwa-precache",
    apply: "build" as const,
    configResolved(cfg: { build: { outDir: string }; root: string }) { outDir = join(cfg.root, cfg.build.outDir); },
    closeBundle() {
      const swPath = join(outDir, "sw.js");
      if (!existsSync(swPath)) return;
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else files.push("/" + relative(outDir, full).split(sep).join("/"));
        }
      };
      walk(outDir);
      // Versioned web-ifc WASM is NOT precached into the per-build cache:
      // it lives in the version-keyed cache (obs-webifc-<version>) populated
      // on first IFC import, so it survives app rebuilds instead of being
      // re-downloaded with every redeploy. Root /web-ifc/* files stay in the
      // precache — they are the same-build fallback the importer uses when
      // the versioned folder is unavailable.
      const list = files.filter((f) => f !== "/sw.js" && !f.endsWith(".map") && !f.endsWith(".html") && !/^\/web-ifc\/\d+\.\d+\.\d+\//.test(f));
      const hash = createHash("sha1").update(list.join("|")).update(String(Date.now())).digest("hex").slice(0, 10);
      const src = readFileSync(swPath, "utf8")
        .replace("__OBS_BUILD__", hash)
        .replaceAll("__OBS_WEB_IFC_VERSION__", webIfcVersion())
        .replace("/*__OBS_PRECACHE__*/ []", JSON.stringify(list));
      writeFileSync(swPath, src);
      // Publish-as-web-page needs the same enumeration at runtime: the
      // publish flow fetches /asset-list.json and downloads every built
      // file into the published zip. Same walk, same filters, plus sizes
      // so the UI can show the download size honestly. sw.js is excluded
      // (a published page is a static snapshot; it does not register the
      // app's service worker) and .map files are excluded (debug only).
      // asset-list.json itself is excluded — it describes the build, it
      // is not part of the published page.
      const publishable = files
        .filter((f) => f !== "/sw.js" && f !== "/asset-list.json" && !f.endsWith(".map"))
        .map((f) => ({ path: f.slice(1), bytes: statSync(join(outDir, f.slice(1))).size }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      writeFileSync(join(outDir, "asset-list.json"), JSON.stringify({ files: publishable }, null, 2));
    },
  };
}

/** Hardening headers shared by the dev and preview servers (the hosted build sets the same ones in vercel.json). */
function applySecurityHeaders(res: { setHeader(k: string, v: string): void }, cspOverride?: string) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  res.setHeader(
    "Content-Security-Policy",
    cspOverride ?? "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
}
