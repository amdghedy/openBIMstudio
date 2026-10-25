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
  define: {
    __WEB_IFC_SCRIPT_URL__: JSON.stringify('/web-ifc/web-ifc-api.js'),
  },
  esbuild: { target: "esnext" },
  build: {
    target: "esnext",
    // Large vendors (web-ifc WASM, @thatopen/components, monaco) inherently
    // exceed 1.5 MB; raise the limit so CI build logs stay clean.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks: {
          // Group large vendor libs into separate chunks for better caching
          // and to silence the > 500 KB build warning.
          "react-vendor": ["react", "react-dom", "react-redux", "@reduxjs/toolkit"],
          "mui-vendor": ["@mui/material", "@mui/lab", "@emotion/react", "@emotion/styled"],
          "three-vendor": ["three", "three-mesh-bvh", "three-csg-ts"],
          "thatopen-vendor": [
            "@thatopen/components",
            "@thatopen/components-front",
            "@thatopen/fragments",
            "@thatopen/ui",
            "@thatopen/ui-obc",
          ],
          "tldraw-vendor": [
            "@tldraw/editor",
          ],
          "monaco-vendor": ["monaco-editor"],
          "ifc-vendor": ["web-ifc"],
          "yjs-vendor": ["yjs", "y-websocket"],
        },
      },
    },
  },
  resolve: { dedupe: ["lit", "lit-html", "lit-element", "@lit/reactive-element"] },
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
function crossOriginIsolation() {
  return {
    name: "cross-origin-isolation",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        applySecurityHeaders(res);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        applySecurityHeaders(res);
        next();
      });
    },
  };
}
// --- OpenBIMStudio :: PWA — list every built file in the service worker so the app runs offline ---
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
      const list = files.filter((f) => f !== "/sw.js" && !f.endsWith(".map") && !f.endsWith(".html"));
      const hash = createHash("sha1").update(list.join("|")).update(String(Date.now())).digest("hex").slice(0, 10);
      const src = readFileSync(swPath, "utf8")
        .replace("__OBS_BUILD__", hash)
        .replace("/*__OBS_PRECACHE__*/ []", JSON.stringify(list));
      writeFileSync(swPath, src);
    },
  };
}

/** Hardening headers shared by the dev and preview servers (the hosted build sets the same ones in vercel.json). */
function applySecurityHeaders(res: { setHeader(k: string, v: string): void }) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  res.setHeader("Content-Security-Policy", "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
}
